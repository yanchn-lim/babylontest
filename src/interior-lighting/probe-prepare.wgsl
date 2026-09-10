@group(0) @binding(0) var<storage,read> nodes:array<Node>;
@group(0) @binding(1) var<storage,read> triangles:array<Triangle>;
@group(0) @binding(2) var<storage,read> materials:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> positions:array<vec4f>;
@group(0) @binding(4) var<uniform> params:Params;
@group(0) @binding(5) var visibility:texture_storage_2d<rgba32float,write>;
@group(0) @binding(6) var placement:texture_storage_2d<rgba32float,write>;
fn fixedDirection(i:u32,count:u32)->vec3f {
  let y=1.0-2.0*(f32(i)+.5)/f32(count);let phi=f32(i)*2.39996323;
  return vec3f(sqrt(1.0-y*y)*cos(phi),y,sqrt(1.0-y*y)*sin(phi));
}
var<workgroup> hits:array<vec4f,128>;
var<workgroup> distances:array<f32,1024>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
  let probe=u32(params.update.x)+group.x;
  if(probe>=u32(params.dimensions.w)){return;}
  let dims=vec3u(params.dimensions.xyz);
  let cell=vec3u(probe%dims.x,(probe/dims.x)%dims.y,probe/(dims.x*dims.y));
  let nominal=params.grid.xyz+vec3f(cell)*params.grid.w;
  let position=select(positions[probe].xyz,nominal,params.update.y==0.0 && params.update.z==0.0);
  if(params.update.z==0.0){
    for(var i=lane;i<128u;i+=64u){
      let d=fixedDirection(i,128u);let h=trace(position,d,30.0);
      hits[i]=vec4f(h.normal,select(h.distance,-h.distance,dot(h.normal,d)>0.0 && h.distance<30.0));
    }
    workgroupBarrier();
    if(lane==0u){
      var backfaces=0u;var frontDistance=30.0;var backDistance=30.0;var front=0u;var back=0u;
      for(var i=0u;i<128u;i++){
        if(hits[i].w<0.0){backfaces++;if(-hits[i].w<backDistance){backDistance=-hits[i].w;back=i;}}
        else if(hits[i].w<frontDistance){frontDistance=hits[i].w;front=i;}
      }
      let inside=backfaces>32u;let valid=!inside && frontDistance>=.05;
      var candidate=position;
      if(params.update.y<4.0 && !valid){
        if(inside){candidate+=fixedDirection(back,128u)*(backDistance+.051);}
        else{candidate+=hits[front].xyz*(.051-frontDistance);}
        if(length(candidate-nominal)>.45*params.grid.w){candidate=position;}
      }
      let value=vec4f(candidate,select(0.0,1.0,valid));
      positions[probe]=value;textureStore(placement,vec2i(0,i32(probe)),value);
    }
    return;
  }
  for(var i=lane;i<1024u;i+=64u){distances[i]=trace(position,fixedDirection(i,1024u),30.0).distance;}
  workgroupBarrier();
  for(var texel=lane;texel<256u;texel+=64u){
    let axis=octDirection((vec2f(f32(texel%16u),f32(texel/16u))+.5)/8.0-1.0);
    var sum=vec2f(0);var total=0.0;
    for(var i=0u;i<1024u;i++){
      let cosine=max(0.0,dot(axis,fixedDirection(i,1024u)));let weight=pow(cosine,64.0);
      let distance=distances[i];sum+=vec2f(distance,distance*distance)*weight;total+=weight;
    }
    textureStore(visibility,vec2i(i32(texel),i32(probe)),vec4f(sum/max(total,.00001),0,0));
  }
}
