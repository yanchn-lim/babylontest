struct SurfaceCell { p:vec4f,u:vec4f,v:vec4f,n:vec4f }
struct SurfaceBox { lo:vec4f,hi:vec4f }
@group(0) @binding(3) var<storage,read> cells:array<SurfaceCell>;
@group(0) @binding(4) var<storage,read> boxes:array<SurfaceBox>;
@group(0) @binding(5) var cache:texture_storage_2d_array<rgba32float,write>;
@group(0) @binding(6) var<storage,read_write> stats:array<atomic<u32>,3>;
struct SurfaceUniforms { probeGrid:vec4f,probeDimensions:vec4f,surfaceInfo:vec4f }
@group(0) @binding(7) var<uniform> uniforms:SurfaceUniforms;

var<private> surfaceProofMargin:f32 = .000001;

fn separated(axis:vec3f,points:array<vec3f,5>,lo:vec3f,hi:vec3f)->bool {
  let size=length(axis);if(size<.0000001){return false;}
  let a=axis/size;var low=dot(a,points[0]);var high=low;
  for(var i=1;i<5;i++){let d=dot(a,points[i]);low=min(low,d);high=max(high,d);}
  let center=dot(a,(lo+hi)*.5);let radius=dot(abs(a),(hi-lo)*.5);
  return high<=center-radius+surfaceProofMargin || low>=center+radius-surfaceProofMargin;
}
// Separating-axis test: a clear pyramid certifies every segment over the cell.
fn surfaceClear(points:array<vec3f,5>)->bool {
  let axes=array<vec3f,3>(vec3f(1,0,0),vec3f(0,1,0),vec3f(0,0,1));
  for(var b=0u;b<arrayLength(&boxes);b++){
    let box=boxes[b];if(box.lo.w>.5){continue;}
    var apart=false;
    for(var a=0;a<3;a++){apart=apart||separated(axes[a],points,box.lo.xyz,box.hi.xyz);}
    if(apart){continue;}
    apart=separated(cross(points[1]-points[0],points[2]-points[0]),points,box.lo.xyz,box.hi.xyz);
    for(var i=0;i<4;i++){
      let j=(i+1)%4;
      apart=apart||separated(cross(points[i]-points[4],points[j]-points[4]),points,box.lo.xyz,box.hi.xyz);
      for(var a=0;a<3;a++){
        apart=apart||separated(cross(points[j]-points[i],axes[a]),points,box.lo.xyz,box.hi.xyz);
        apart=apart||separated(cross(points[i]-points[4],axes[a]),points,box.lo.xyz,box.hi.xyz);
      }
    }
    if(!apart){return false;}
  }
  return true;
}
fn surfaceReserveBlocked(probe:vec3f,bounds:array<vec3f,8>)->bool {return false;}
fn surfaceReserveVisible(probe:vec3f)->bool {return true;}
fn surfaceWeight(p:vec3f,n:vec3f,index:i32)->f32 {
  let dims=vec3i(uniforms.probeDimensions.xyz);
  let grid=clamp((p+n*.03-uniforms.probeGrid.xyz)/uniforms.probeGrid.w,vec3f(0),vec3f(dims-1));
  let cell=vec3i(index%dims.x,(index/dims.x)%dims.y,index/(dims.x*dims.y));
  let basis=max(vec3f(0),1.0-abs(grid-vec3f(cell)));
  let placement=textureLoad(probePlacementSampler,vec2i(0,index),0);
  let delta=p+n*.03-placement.xyz;let distance=length(delta);let direction=delta/max(distance,.00001);
  let moments=probeMoments(direction,index);let difference=max(0.0,distance-moments.x);
  let variance=max(.000001,moments.y-moments.x*moments.x);
  var weight=pow(variance/(variance+difference*difference),3.0)*pow(max(0.0,1.0-dot(n,direction))*.5,2.0);
  if(weight<.2){weight*=weight*weight/.04;}
  return weight*basis.x*basis.y*basis.z;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid:vec3u){
  let address=u32(uniforms.surfaceInfo.x)+gid.x;if(address>=u32(uniforms.surfaceInfo.y)||gid.x>=u32(uniforms.surfaceInfo.z)){return;}
  let cell=cells[address];let n=cell.n.xyz;let p=cell.p.xyz;
  let corners=array<vec3f,4>(p,p+cell.u.xyz,p+cell.v.xyz,p+cell.u.xyz+cell.v.xyz);
  let center=p+(cell.u.xyz+cell.v.xyz)*.5;
  var points=array<vec3f,5>(corners[0]+n*.001,corners[1]+n*.001,corners[3]+n*.001,corners[2]+n*.001,vec3f(0));
  let dims=vec3i(uniforms.probeDimensions.xyz);
  let base=clamp(vec3i(floor((center+n*.03-uniforms.probeGrid.xyz)/uniforms.probeGrid.w)),vec3i(0),dims-2);
  var ids:array<i32,8>;var found=0;
  for(var i=0;i<8;i++){
    ids[i]=-1;let c=base+vec3i(i&1,(i>>1)&1,(i>>2)&1);let index=c.x+dims.x*(c.y+dims.y*c.z);
    let placement=textureLoad(probePlacementSampler,vec2i(0,index),0);if(placement.w<.5){continue;}
    points[4]=placement.xyz;if(surfaceClear(points)){ids[found]=index;found++;}
  }
  // Coverage recovery uses existing nearby probes only, with the same full-cell proof.
  var hidden=false;
  for(var b=0u;b<arrayLength(&boxes);b++){let q=center+n*.001;hidden=hidden||(boxes[b].lo.w<.5&&all(q>boxes[b].lo.xyz)&&all(q<boxes[b].hi.xyz));}
  if(found==0 && !hidden){
    var distances:array<f32,8>;for(var i=0;i<8;i++){distances[i]=1e10;}
    for(var index=0;index<dims.x*dims.y*dims.z;index++){
      let placement=textureLoad(probePlacementSampler,vec2i(0,index),0);let delta=placement.xyz-center;let d=length(delta);
      if(placement.w<.5||d>2.0*uniforms.probeGrid.w||d>=distances[7]||dot(n,delta)<=0.0){continue;}
      points[4]=placement.xyz;if(!surfaceClear(points)){continue;}
      var slot=7;loop{if(slot==0||d>=distances[slot-1]){break;}distances[slot]=distances[slot-1];ids[slot]=ids[slot-1];slot--;}
      distances[slot]=d;ids[slot]=index;found=min(8,found+1);
    }
    if(found>0){atomicAdd(&stats[1],1u);}
  }
  // Uncertified cells keep candidates; the fragment shader checks each actual segment.
  var guarded=false;
  if(found==0 && !hidden){
    guarded=true;var distances:array<f32,4>;for(var i=0;i<4;i++){distances[i]=1e10;}
    for(var index=0;index<dims.x*dims.y*dims.z;index++){
      let placement=textureLoad(probePlacementSampler,vec2i(0,index),0);let delta=placement.xyz-center;let d=length(delta);
      if(placement.w<.5||d>3.0*uniforms.probeGrid.w||d>=distances[3]||dot(n,delta)<=0.0){continue;}
      var slot=3;loop{if(slot==0||d>=distances[slot-1]){break;}distances[slot]=distances[slot-1];ids[slot]=ids[slot-1];slot--;}
      distances[slot]=d;ids[slot]=index;found=min(4,found+1);
    }
    // Keep angular coverage instead of spending every slot on the same direction.
    loop {
      if(found==0||found>=8){break;}
      var best=-1;var bestSeparation=-1.0;var bestDistance=1e10;
      for(var index=0;index<dims.x*dims.y*dims.z;index++){
        let placement=textureLoad(probePlacementSampler,vec2i(0,index),0);let delta=placement.xyz-center;let d=length(delta);
        if(placement.w<.5||d>3.0*uniforms.probeGrid.w||dot(n,delta)<=0.0){continue;}
        var separation=2.0;var present=false;
        for(var i=0;i<found;i++){
          present=present||ids[i]==index;
          let selected=textureLoad(probePlacementSampler,vec2i(0,ids[i]),0).xyz-center;
          separation=min(separation,1.0-dot(delta/max(d,.00001),normalize(selected)));
        }
        if(present){continue;}
        if(separation>bestSeparation||(separation==bestSeparation&&d<bestDistance)){best=index;bestSeparation=separation;bestDistance=d;}
      }
      if(best<0){break;}ids[found]=best;found++;
    }
  }

  var reserve:array<i32,8>;for(var i=0;i<8;i++){reserve[i]=-1;}
  if(guarded){
    var reserveCount=0;
    var distances:array<f32,4>;for(var i=0;i<4;i++){distances[i]=1e10;}
    for(var index=0;index<dims.x*dims.y*dims.z;index++){
      let placement=textureLoad(probePlacementSampler,vec2i(0,index),0);let delta=placement.xyz-center;let d=length(delta);
      if(placement.w<.5||d>4.0*uniforms.probeGrid.w||d>=distances[3]||dot(n,delta)<=0.0){continue;}
      var slot=3;loop{if(slot==0||d>=distances[slot-1]){break;}distances[slot]=distances[slot-1];reserve[slot]=reserve[slot-1];slot--;}
      distances[slot]=d;reserve[slot]=index;reserveCount=min(4,reserveCount+1);
    }
    var facing=-1;var bestFacing=-1.0;var facingDistance=1e10;
    for(var index=0;index<dims.x*dims.y*dims.z;index++){
      let placement=textureLoad(probePlacementSampler,vec2i(0,index),0);
      let delta=placement.xyz-center;let d=length(delta);
      if(placement.w<.5||d>4.0*uniforms.probeGrid.w||dot(n,delta)<=0.0){continue;}
      let alignment=dot(n,delta/max(d,.00001));
      if(alignment>bestFacing||(alignment==bestFacing&&d<facingDistance)){
        facing=index;bestFacing=alignment;facingDistance=d;
      }
    }
    var hasFacing=false;
    for(var i=0;i<reserveCount;i++){hasFacing=hasFacing||reserve[i]==facing;}
    if(facing>=0&&!hasFacing){reserve[reserveCount]=facing;reserveCount++;}
    // Keep angular coverage instead of spending every slot on the same direction.
    loop {
      if(reserveCount==0||reserveCount>=8){break;}
      var best=-1;var bestSeparation=-1.0;var bestDistance=1e10;
      for(var index=0;index<dims.x*dims.y*dims.z;index++){
        let placement=textureLoad(probePlacementSampler,vec2i(0,index),0);let delta=placement.xyz-center;let d=length(delta);
        if(placement.w<.5||d>4.0*uniforms.probeGrid.w||dot(n,delta)<=0.0){continue;}
        var separation=2.0;var present=false;
        for(var i=0;i<reserveCount;i++){
          present=present||reserve[i]==index;
          let selected=textureLoad(probePlacementSampler,vec2i(0,reserve[i]),0).xyz-center;
          separation=min(separation,1.0-dot(delta/max(d,.00001),normalize(selected)));
        }
        if(present){continue;}
        if(separation>bestSeparation||(separation==bestSeparation&&d<bestDistance)){best=index;bestSeparation=separation;bestDistance=d;}
      }
      if(best<0){break;}reserve[reserveCount]=best;reserveCount++;
    }
    }
  var bounds:array<vec3f,8>;let u=normalize(cell.u.xyz)*.0002;let v=normalize(cell.v.xyz)*.0002;
  for(var i=0;i<8;i++){bounds[i]=corners[i%4]+n*(.001+select(-.0002,.0002,i>=4))+select(-u,u,(i&1)!=0)+select(-v,v,(i&2)!=0);}
  if(guarded){
    var kept=0;
    for(var i=0;i<8;i++){
      if(reserve[i]<0){continue;}let probe=textureLoad(probePlacementSampler,vec2i(0,reserve[i]),0).xyz;
      if(!surfaceReserveBlocked(probe,bounds)){reserve[kept]=reserve[i];kept++;}
    }
    for(var i=kept;i<8;i++){reserve[i]=-1;}
    var preferFacing=true;
    var tested:array<u32,16>;var visible:array<u32,16>;
    loop {
      if(kept>=8){break;}
      var best=-1;var bestScore=-1.0;var bestDistance=1e10;
      for(var index=0;index<dims.x*dims.y*dims.z;index++){
        let placement=textureLoad(probePlacementSampler,vec2i(0,index),0);let delta=placement.xyz-center;let d=length(delta);
        if(placement.w<.5||d>6.0||dot(n,delta)<=0.0){continue;}
        let direction=delta/max(d,.00001);var score=select(2.0,dot(n,direction),preferFacing);var present=false;
        for(var i=0;i<kept;i++){
          present=present||reserve[i]==index;
          if(!preferFacing){let selected=textureLoad(probePlacementSampler,vec2i(0,reserve[i]),0).xyz-center;score=min(score,1.0-dot(direction,normalize(selected)));}
        }
        if(present||score<bestScore||(score==bestScore&&d>=bestDistance)){continue;}
        let word=index/32;let bit=1u<<u32(index%32);
        if((tested[word]&bit)==0u){
          tested[word]|=bit;
          if(surfaceReserveVisible(placement.xyz)){visible[word]|=bit;}
        }
        if((visible[word]&bit)==0u){continue;}
        best=index;bestScore=score;bestDistance=d;
      }
      if(best<0){break;}reserve[kept]=best;kept++;preferFacing=false;
    }
  }
  var blocked:array<i32,8>;
  for(var i=0;i<8;i++){
    blocked[i]=-1;
    let c=base+vec3i(i&1,(i>>1)&1,(i>>2)&1);
    let index=c.x+dims.x*(c.y+dims.y*c.z);
    let placement=textureLoad(probePlacementSampler,vec2i(0,index),0);
    if(placement.w<.5){continue;}
    var clear=false;
    if(!guarded){for(var j=0;j<8;j++){clear=clear||ids[j]==index;}}
    if(!clear&&surfaceReserveBlocked(placement.xyz,bounds)){blocked[i]=index;}
  }
  // Cells can cross probe-grid boundaries; certify their neighboring probes too.
  var low=corners[0]+n*.03;var high=low;
  for(var i=1;i<4;i++){low=min(low,corners[i]+n*.03);high=max(high,corners[i]+n*.03);}
  let first=clamp(vec3i(floor((low-uniforms.probeGrid.xyz)/uniforms.probeGrid.w)),vec3i(0),dims-2);
  let last=clamp(vec3i(floor((high-uniforms.probeGrid.xyz)/uniforms.probeGrid.w)),vec3i(0),dims-2)+1;
  surfaceProofMargin=-.0002;
  for(var z=first.z;z<=last.z;z++){
    for(var y=first.y;y<=last.y;y++){
      for(var x=first.x;x<=last.x;x++){
        let c=vec3i(x,y,z);
        if(all(c>=base)&&all(c<=base+1)){continue;}
        var slot=-1;
        for(var i=0;i<8;i++){if(blocked[i]==-1){slot=i;break;}}
        if(slot<0){break;}
        let index=c.x+dims.x*(c.y+dims.y*c.z);
        let placement=textureLoad(probePlacementSampler,vec2i(0,index),0);
        if(placement.w<.5){continue;}
        points[4]=placement.xyz;
        if(surfaceClear(points)){blocked[slot]=-index-2;atomicAdd(&stats[2],1u);}
      }
    }
  }
  surfaceProofMargin=.000001;
  var weights:array<vec4f,8>;var sums=vec4f(0);
  for(var i=0;i<8;i++){
    weights[i]=vec4f(0);if(ids[i]<0){continue;}
    for(var c=0;c<4;c++){
      if(guarded){let delta=textureLoad(probePlacementSampler,vec2i(0,ids[i]),0).xyz-corners[c];let d=max(.001,length(delta));weights[i][c]=max(0.0,dot(n,delta/d))/(d*d);}
      else{weights[i][c]=surfaceWeight(corners[c],n,ids[i]);}
    }sums+=weights[i];
  }
  for(var c=0;c<4;c++){
    if(sums[c]>.000001){continue;}
    sums[c]=0.0;
    for(var i=0;i<8;i++){
      if(ids[i]<0){continue;}let delta=textureLoad(probePlacementSampler,vec2i(0,ids[i]),0).xyz-corners[c];
      let d=max(.001,length(delta));weights[i][c]=max(0.0,dot(n,delta/d))/(d*d);sums[c]+=weights[i][c];
    }
  }
  for(var i=0;i<8;i++){if(guarded&&ids[i]>=0){ids[i]=-ids[i]-2;}}
  let xy=vec2i(i32(address)%256,i32(address)/256);
  textureStore(cache,xy,0,vec4f(f32(ids[0]),f32(ids[1]),f32(ids[2]),f32(ids[3])));
  textureStore(cache,xy,1,vec4f(f32(ids[4]),f32(ids[5]),f32(ids[6]),f32(ids[7])));
  textureStore(cache,xy,10,vec4f(f32(reserve[0]),f32(reserve[1]),f32(reserve[2]),f32(reserve[3])));
  textureStore(cache,xy,11,vec4f(f32(reserve[4]),f32(reserve[5]),f32(reserve[6]),f32(reserve[7])));
  textureStore(cache,xy,12,vec4f(f32(blocked[0]),f32(blocked[1]),f32(blocked[2]),f32(blocked[3])));
  textureStore(cache,xy,13,vec4f(f32(blocked[4]),f32(blocked[5]),f32(blocked[6]),f32(blocked[7])));
  for(var i=0;i<8;i++){textureStore(cache,xy,i+2,select(vec4f(0),weights[i]/max(sums,vec4f(.000001)),sums>vec4f(.000001)));}
  if(guarded||any(sums<=vec4f(.000001))){atomicAdd(&stats[0],1u);}atomicAdd(&stats[2],select(u32(found),0u,guarded));
}
