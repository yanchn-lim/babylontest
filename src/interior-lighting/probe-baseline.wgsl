struct Node { lo:vec3f, left:u32, hi:vec3f, right:u32, first:u32, count:u32, padding:vec2u }
struct Triangle { a:vec4f, b:vec4f, c:vec4f, material:vec4u, uv0:vec4f, uv1:vec4f }
struct Fixture { position:vec4f, color:vec4f, direction:vec4f }
struct Params { sun:vec4f, sunColor:vec4f, grid:vec4f, dimensions:vec4f, update:vec4f }
struct Sample { radiance:vec4f, moments:vec4f, a0:vec4f, b0:vec4f, c0:vec4f, a1:vec4f, b1:vec4f, c1:vec4f, a2:vec4f, b2:vec4f, c2:vec4f }
@group(0) @binding(0) var<storage,read> nodes:array<Node>;
@group(0) @binding(1) var<storage,read> triangles:array<Triangle>;
@group(0) @binding(2) var<storage,read> materials:array<vec4f>;
@group(0) @binding(3) var<storage,read> lights:array<Fixture>;
@group(0) @binding(4) var<uniform> params:Params;
@group(0) @binding(5) var<storage,read_write> history:array<Sample>;
@group(0) @binding(6) var irradiance:texture_storage_2d<rgba16float,write>;
@group(0) @binding(7) var visibility:texture_storage_2d<rgba32float,write>;
@group(0) @binding(8) var albedoSampler:sampler;
@group(0) @binding(9) var albedos:texture_2d_array<f32>;
struct Hit { distance:f32, normal:vec3f, material:u32, triangle:u32, barycentric:vec2f }
fn intersects(origin:vec3f, direction:vec3f, lo:vec3f, hi:vec3f, limit:f32)->bool {
  let inv = 1.0 / select(vec3f(.0000001),direction,abs(direction)>vec3f(.0000001));
  let a=(lo-origin)*inv; let b=(hi-origin)*inv;
  let near=max(max(min(a,b).x,min(a,b).y),min(a,b).z);
  let far=min(min(max(a,b).x,max(a,b).y),max(a,b).z);
  return far>=max(near,0.0) && near<limit;
}
fn trace(origin:vec3f, direction:vec3f, limit:f32)->Hit {
  var hit=Hit(limit,vec3f(0),0u,0u,vec2f(0));
  var stack:array<u32,32>; var top=1u; stack[0]=0u;
  loop {
    if(top==0u){break;} top--; let n=nodes[stack[top]];
    if(!intersects(origin,direction,n.lo,n.hi,hit.distance)){continue;}
    if(n.count==0u){ if(top<30u){stack[top]=n.left;stack[top+1u]=n.right;top+=2u;} continue; }
    for(var i=0u;i<n.count;i++) {
      let tri=triangles[n.first+i]; if(materials[tri.material.x].w>0.0){continue;} let e1=tri.b.xyz-tri.a.xyz; let e2=tri.c.xyz-tri.a.xyz;
      let p=cross(direction,e2); let det=dot(e1,p);
      if(abs(det)<.0000001){continue;}
      let s=origin-tri.a.xyz; let u=dot(s,p)/det; if(u<0.0||u>1.0){continue;}
      let q=cross(s,e1); let v=dot(direction,q)/det; if(v<0.0||u+v>1.0){continue;}
      let t=dot(e2,q)/det;
      if(t>.001 && t<hit.distance){hit=Hit(t,normalize(cross(e1,e2)),tri.material.x,n.first+i,vec2f(u,v));}
    }
  }
  return hit;
}
fn sky(d:vec3f)->vec3f {
  let day=clamp((params.sun.y+.08)/.25,0.0,1.0);
  let horizon=pow(1.0-max(0.0,d.y),3.0);
  let forward=pow(max(0.0,dot(d,params.sun.xyz)),16.0);
  return (vec3f(.12,.22,.4)+vec3f(.25,.2,.1)*horizon+vec3f(.2,.14,.06)*forward)*day*select(.08,1.0,d.y>=0.0);
}
fn transmission(origin:vec3f,direction:vec3f,limit:f32)->vec3f {
  if(params.sunColor.w<.5){return vec3f(1);}
  var tint=vec3f(1);var stack:array<u32,32>;var top=1u;stack[0]=0u;
  loop{
    if(top==0u){break;}top--;let n=nodes[stack[top]];
    if(!intersects(origin,direction,n.lo,n.hi,limit)){continue;}
    if(n.count==0u){if(top<30u){stack[top]=n.left;stack[top+1u]=n.right;top+=2u;}continue;}
    for(var i=0u;i<n.count;i++){
      let tri=triangles[n.first+i];let material=materials[tri.material.x];if(material.w<=0.0){continue;}
      let e1=tri.b.xyz-tri.a.xyz;let e2=tri.c.xyz-tri.a.xyz;let p=cross(direction,e2);let det=dot(e1,p);if(abs(det)<.0000001){continue;}
      let s=origin-tri.a.xyz;let u=dot(s,p)/det;if(u<0.0||u>1.0){continue;}
      let q=cross(s,e1);let v=dot(direction,q)/det;if(v<0.0||u+v>1.0){continue;}
      let t=dot(e2,q)/det;if(t>.001&&t<limit){tint*=sqrt(max(vec3f(.01),mix(vec3f(1),material.rgb,material.w)*(1.0-material.w)));}
    }
  }
  return tint;
}
fn direct(p:vec3f,n:vec3f)->vec3f {
  var value=vec3f(0);
  if(params.sun.w>0.0 && dot(n,params.sun.xyz)>0.0 && trace(p,params.sun.xyz,100.0).distance>=99.9){value+=params.sunColor.rgb*params.sun.w*max(0.0,dot(n,params.sun.xyz))*transmission(p,params.sun.xyz,100.0);}
  for(var i=0u;i<8u;i++) {
    let light=lights[i]; if(light.position.w<=0.0){continue;}
    let delta=light.position.xyz-p; let distance=length(delta); let l=delta/max(distance,.001);
    let cosine=dot(n,l); if(cosine<=0.0){continue;}
    if(light.color.w>0.5 && dot(-l,light.direction.xyz)<light.direction.w){continue;}
    if(trace(p,l,distance).distance<distance-.01){continue;}
    value+=light.color.rgb*light.position.w*cosine/max(distance*distance,.01)*transmission(p,l,distance);
  }
  return value;
}
fn hash(x:u32)->f32 {var v=x;v=(v^(v>>16u))*2246822519u;v=(v^(v>>13u))*3266489917u;return f32(v^(v>>16u))/4294967296.0;}
fn octDirection(uv:vec2f)->vec3f {var n=vec3f(uv,1.0-abs(uv.x)-abs(uv.y));if(n.z<0.0){n=vec3f((1.0-abs(n.yx))*select(vec2f(-1),vec2f(1),n.xy>=vec2f(0)),n.z);}return normalize(n);}
var<workgroup> radiances:array<vec3f,64>;
var<workgroup> directions:array<vec3f,64>;
var<workgroup> weights:array<f32,64>;
var<workgroup> invalid:array<f32,64>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32) {
  let probe=u32(params.update.x)+group.x;
  if(probe>=u32(params.dimensions.w)){return;}
  let dimensions=vec3u(params.dimensions.xyz);
  let cell=vec3u(probe%dimensions.x,(probe/dimensions.x)%dimensions.y,probe/(dimensions.x*dimensions.y));
  let position=params.grid.xyz+vec3f(cell)*params.grid.w;
  let epoch=params.update.z; let index=probe*64u+lane;
  let previous=history[index]; let count=select(0.0,previous.radiance.w,previous.moments.z==epoch);
  let seed=probe*7919u+lane*104729u+u32(count)*15485863u;
  let jitter=select(vec2f(.5),vec2f(hash(seed),hash(seed+17u)),count>0.0);
  let uv=(vec2f(f32(lane%8u),f32(lane/8u))+jitter)/4.0-1.0;
  let d=octDirection(uv);
  let h=trace(position,d,30.0);
  var light=sky(d)*transmission(position,d,h.distance); var backface=0.0;
  if(h.distance<30.0) {
    backface=select(0.0,1.0,dot(h.normal,d)>0.0);
    let n=select(h.normal,-h.normal,dot(h.normal,d)>0.0);
    let p=position+d*h.distance+n*.015;
    // A second ray estimates sky irradiance at the first hit. No cached extra bounce.
    let sy=hash(seed+73u)*2.0-1.0;let phi=hash(seed+193u)*6.2831853;
    var skyDirection=vec3f(sqrt(1.0-sy*sy)*cos(phi),sy,sqrt(1.0-sy*sy)*sin(phi));
    if(dot(skyDirection,n)<0.0){skyDirection=-skyDirection;}
    var skyLight=vec3f(0);
    if(trace(p,skyDirection,30.0).distance>=30.0){skyLight=sky(skyDirection)*6.2831853*max(0.0,dot(n,skyDirection))*transmission(p,skyDirection,30.0);}
    let tri=triangles[h.triangle];let uv=tri.uv0.xy*(1.0-h.barycentric.x-h.barycentric.y)+tri.uv0.zw*h.barycentric.x+tri.uv1.xy*h.barycentric.y;
    let albedo=textureSampleLevel(albedos,albedoSampler,fract(uv),i32(h.material),0.0).rgb*materials[h.material].rgb;
    light=(direct(p,n)+skyLight)*albedo/3.14159265*transmission(position,d,h.distance);
  }
  let amount=1.0/(min(count,15.0)+1.0);
  let filtered=mix(previous.radiance.rgb,light,select(1.0,amount,count>0.0));
  let moments=mix(previous.moments.xy,vec2f(h.distance,h.distance*h.distance),select(1.0,amount,count>0.0));
  var a0=select(vec4f(0),previous.a0,count>0.0);var b0=select(vec4f(0),previous.b0,count>0.0);var c0=select(vec4f(0),previous.c0,count>0.0);
  var a1=select(vec4f(0),previous.a1,count>0.0);var b1=select(vec4f(0),previous.b1,count>0.0);var c1=select(vec4f(0),previous.c1,count>0.0);
  var a2=select(vec4f(0),previous.a2,count>0.0);var b2=select(vec4f(0),previous.b2,count>0.0);var c2=select(vec4f(0),previous.c2,count>0.0);
  if(h.distance<30.0){
    let id=f32(h.triangle+1u);
    if(id!=a0.w && id!=a1.w && id!=a2.w){
      a2=a1;b2=b1;c2=c1;a1=a0;b1=b0;c1=c0;
      let tri=triangles[h.triangle];a0=vec4f(tri.a.xyz-position,id);b0=vec4f(tri.b.xyz-position,0);c0=vec4f(tri.c.xyz-position,0);
    }
  }
  history[index]=Sample(vec4f(filtered,count+1.0),vec4f(moments,epoch,backface),a0,b0,c0,a1,b1,c1,a2,b2,c2);
  let vertices=array<vec4f,9>(a0,b0,c0,a1,b1,c1,a2,b2,c2);
  for(var vertex=0u;vertex<9u;vertex++){textureStore(visibility,vec2i(i32(lane+(vertex+1u)*64u),i32(probe)),vertices[vertex]);}
  radiances[lane]=filtered; directions[lane]=d; invalid[lane]=backface;
  weights[lane]=pow(abs(d.x)+abs(d.y)+abs(d.z),3.0);
  textureStore(visibility,vec2i(i32(lane),i32(probe)),vec4f(moments,epoch,1));
  workgroupBarrier();
  if(lane==0u){
    var backfaces=0.0;for(var r=0u;r<64u;r++){backfaces+=invalid[r];}
    let valid=select(1.0,0.0,backfaces>32.0);
    let axes=array<vec3f,6>(vec3f(1,0,0),vec3f(-1,0,0),vec3f(0,1,0),vec3f(0,-1,0),vec3f(0,0,1),vec3f(0,0,-1));
    for(var face=0u;face<6u;face++){
      var sum=vec3f(0);var total=0.0;
      for(var r=0u;r<64u;r++){let w=max(0.0,dot(axes[face],directions[r]))*weights[r];sum+=radiances[r]*w;total+=w;}
      textureStore(irradiance,vec2i(i32(face),i32(probe)),vec4f(sum*3.14159265/max(total,.00001),valid));
    }
  }
}
