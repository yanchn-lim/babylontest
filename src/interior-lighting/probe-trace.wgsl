@group(0) @binding(0) var<storage,read> nodes:array<Node>;
@group(0) @binding(1) var<storage,read> triangles:array<Triangle>;
@group(0) @binding(2) var<storage,read> materials:array<vec4f>;
@group(0) @binding(3) var<storage,read> lights:array<Fixture>;
@group(0) @binding(4) var<uniform> params:Params;
@group(0) @binding(5) var<storage,read_write> history:array<vec4f>;
@group(0) @binding(6) var irradiance:texture_storage_2d<rgba16float,write>;
@group(0) @binding(7) var<storage,read> positions:array<vec4f>;
@group(0) @binding(8) var albedoSampler:sampler;
@group(0) @binding(9) var albedos:texture_2d_array<f32>;
fn sky(d:vec3f)->vec3f {
  let day=clamp((params.sun.y+.08)/.25,0.0,1.0);
  let horizon=pow(1.0-max(0.0,d.y),3.0);
  let forward=pow(max(0.0,dot(d,params.sun.xyz)),16.0);
  return (vec3f(.12,.22,.4)+vec3f(.25,.2,.1)*horizon+vec3f(.2,.14,.06)*forward)*day*select(.08,1.0,d.y>=0.0);
}
fn transmission(origin:vec3f,direction:vec3f,limit:f32)->vec3f {
  if(params.sunColor.w<.5){return vec3f(1);}
  var tint=vec3f(1);var node=0u;
  loop{
    if(node==0xffffffffu){break;}let n=nodes[node];
    if((n.flags&2u)==0u || !intersects(origin,direction,n.lo,n.hi,limit)){node=n.escape;continue;}
    if(n.count==0u){node=n.right;continue;}
    for(var i=0u;i<n.count;i++){
      let tri=triangles[n.first+i];let material=materials[tri.material.x];if(material.w<=0.0){continue;}
      let e1=tri.b.xyz-tri.a.xyz;let e2=tri.c.xyz-tri.a.xyz;let p=cross(direction,e2);let det=dot(e1,p);if(abs(det)<.0000001){continue;}
      let s=origin-tri.a.xyz;let u=dot(s,p)/det;if(u<0.0||u>1.0){continue;}
      let q=cross(s,e1);let v=dot(direction,q)/det;if(v<0.0||u+v>1.0){continue;}
      let t=dot(e2,q)/det;if(t>.001&&t<limit){tint*=sqrt(max(vec3f(.01),mix(vec3f(1),material.rgb,material.w)*(1.0-material.w)));}
    }
    node=n.escape;
  }
  return tint;
}
fn direct(p:vec3f,n:vec3f)->vec3f {
  var value=vec3f(0);
  if(params.sun.w>0.0 && dot(n,params.sun.xyz)>0.0 && !occluded(p,params.sun.xyz,99.9)){value+=params.sunColor.rgb*params.sun.w*max(0.0,dot(n,params.sun.xyz))*transmission(p,params.sun.xyz,100.0);}
  for(var i=0u;i<8u;i++) {
    let light=lights[i]; if(light.position.w<=0.0){continue;}
    let delta=light.position.xyz-p; let distance=length(delta); let l=delta/max(distance,.001);
    let cosine=dot(n,l); if(cosine<=0.0){continue;}
    if(light.color.w>0.5 && dot(-l,light.direction.xyz)<light.direction.w){continue;}
    if(occluded(p,l,distance-.01)){continue;}
    value+=light.color.rgb*light.position.w*cosine/max(distance*distance,.01)*transmission(p,l,distance);
  }
  return value;
}

var<workgroup> radiances:array<vec3f,64>;
var<workgroup> directions:array<vec3f,64>;
var<workgroup> weights:array<f32,64>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32) {
  let probe=(u32(params.update.x)+group.x)%u32(params.dimensions.w);
  if(probe>=u32(params.dimensions.w)||positions[probe].w<.5){return;}
  let position=positions[probe].xyz;
  // Each probe restarts its own history when lighting changes.
  let metadata=history[probe*6u].w;
  let count=select(0.0,metadata%32.0,floor(metadata/32.0)==params.update.z);
  let seed=probe*7919u+lane*104729u+u32(count)*15485863u;
  let jitter=vec2f(hash(seed),hash(seed+17u));
  let stratum=(u32(count)*5u+u32(hash(probe*7919u+lane*104729u+43u)*16.0))&15u;
  let offset=(vec2f(f32(stratum&3u),f32(stratum>>2u))+clamp(jitter,vec2f(.00001),vec2f(.99999)))*.25;
  let uv=(vec2f(f32(lane%8u),f32(lane/8u))+offset)/4.0-1.0;
  let d=octDirection(uv);
  let h=trace(position,d,30.0);
  var light=sky(d)*transmission(position,d,h.distance);
  if(h.distance<30.0) {
    let n=select(h.normal,-h.normal,dot(h.normal,d)>0.0);
    let p=position+d*h.distance+n*.001;
    let u=hash(seed+73u);let phi=hash(seed+193u)*6.2831853;
    let tangent=normalize(cross(select(vec3f(0,1,0),vec3f(1,0,0),abs(n.y)>.9),n));
    let bitangent=cross(n,tangent);
    let skyDirection=tangent*(sqrt(u)*cos(phi))+bitangent*(sqrt(u)*sin(phi))+n*sqrt(1.0-u);
    var skyLight=vec3f(0);
    if(!occluded(p,skyDirection,30.0)){skyLight=sky(skyDirection)*3.14159265*transmission(p,skyDirection,30.0);}
    let tri=triangles[h.triangle];let uv=tri.uv0.xy*(1.0-h.barycentric.x-h.barycentric.y)+tri.uv0.zw*h.barycentric.x+tri.uv1.xy*h.barycentric.y;
    let albedo=textureSampleLevel(albedos,albedoSampler,fract(uv),i32(h.material),0.0).rgb*materials[h.material].rgb;
    light=(direct(p,n)+skyLight)*albedo/3.14159265*transmission(position,d,h.distance);
  }
  radiances[lane]=light;directions[lane]=d;
  weights[lane]=pow(abs(d.x)+abs(d.y)+abs(d.z),3.0);
  workgroupBarrier();
  if(lane<6u){
    let axes=array<vec3f,6>(vec3f(1,0,0),vec3f(-1,0,0),vec3f(0,1,0),vec3f(0,-1,0),vec3f(0,0,1),vec3f(0,0,-1));
    var sum=vec3f(0);var total=0.0;
    for(var r=0u;r<64u;r++){let w=max(0.0,dot(axes[lane],directions[r]))*weights[r];sum+=radiances[r]*w;total+=w;}
    let batch=sum*3.14159265/max(total,.00001);
    let index=probe*6u+lane;
    let filtered=select(batch,(history[index].rgb*count+batch)/(count+1.0),count>0.0);
    history[index]=vec4f(filtered,params.update.z*32.0+count+1.0);
    textureStore(irradiance,vec2i(i32(lane),i32(probe)),vec4f(filtered,1.0));
  }
}
