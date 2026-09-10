var probeGeometrySampler: texture_2d<f32>;
var probeGeometrySamplerSampler: sampler;
fn probeGeometry(address:i32)->vec4f {
  return textureLoad(probeGeometrySampler,vec2i(address%1024,address/1024),0);
}
var<private> probeLastBlocker:i32 = -1;
fn probeTriangleBlocks(address:i32,origin:vec3f,direction:vec3f,limit:f32)->bool {
  let a=probeGeometry(address);
  if(a.w>.5){return false;}
  let e=probeGeometry(address+1).xyz-a.xyz;let f=probeGeometry(address+2).xyz-a.xyz;
  let h=cross(direction,f);let determinant=dot(e,h);
  if(abs(determinant)<.0000001){return false;}
  let s=origin-a.xyz;let u=dot(s,h)/determinant;
  let q=cross(s,e);let v=dot(direction,q)/determinant;
  let distance=dot(f,q)/determinant;
  return u>=0.0&&v>=0.0&&u+v<=1.0&&distance>.0001&&distance<limit-.0001;
}
fn probeSegmentClear(origin:vec3f,endpoint:vec3f)->bool {
  let delta=endpoint-origin;let limit=length(delta);
  if(limit<.0002){return true;}
  let direction=delta/limit;
  if(probeLastBlocker>=0&&probeTriangleBlocks(probeLastBlocker,origin,direction,limit)){return false;}
  let parallel=abs(direction)<vec3f(.0000001);
  let inverse=1.0/select(direction,vec3f(1),parallel);
  var node=0;
  loop {
    if(node<0){break;}
    let lo=probeGeometry(node).xyz;let hi=probeGeometry(node+1).xyz;
    let entry=probeGeometry(node+2);
    let a=(lo-origin)*inverse;let b=(hi-origin)*inverse;
    let nearAxis=select(min(a,b),vec3f(0),parallel);
    let farAxis=select(max(a,b),vec3f(limit),parallel);
    let outside=any(parallel&((origin<lo)|(origin>hi)));
    let near=max(0.0,max(nearAxis.x,max(nearAxis.y,nearAxis.z)));
    let far=min(limit,min(farAxis.x,min(farAxis.y,farAxis.z)));
    if(outside||far<near){node=i32(entry.z);continue;}
    if(entry.y==0.0){node+=3;continue;}
    for(var i=0;i<i32(entry.y);i++){
      let address=i32(entry.x)+i*3;
      if(probeTriangleBlocks(address,origin,direction,limit)){probeLastBlocker=address;return false;}
    }
    node=i32(entry.z);
  }
  return true;
}

