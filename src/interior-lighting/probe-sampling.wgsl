var probeIrradianceSampler: texture_2d<f32>;
var probeIrradianceSamplerSampler: sampler;
var probeVisibilitySampler: texture_2d<f32>;
var probeVisibilitySamplerSampler: sampler;
var probePlacementSampler: texture_2d<f32>;
var probePlacementSamplerSampler: sampler;
fn probeOct(d:vec3f)->vec2f {
  var p=d.xy/max(.00001,abs(d.x)+abs(d.y)+abs(d.z));
  if(d.z<0.0){p=(1.0-abs(p.yx))*select(vec2f(-1),vec2f(1),p>=vec2f(0));}
  return p*.5+.5;
}
fn probeWrap(value:vec2i)->vec2i {
  var p=value;
  if(p.x<0){p=vec2i(-p.x-1,15-p.y);}else if(p.x>15){p=vec2i(31-p.x,15-p.y);}
  if(p.y<0){p=vec2i(15-p.x,-p.y-1);}else if(p.y>15){p=vec2i(15-p.x,31-p.y);}
  return p;
}
fn probeMoments(direction:vec3f,index:i32)->vec2f {
  let uv=probeOct(direction)*16.0-.5;let base=vec2i(floor(uv));let f=fract(uv);
  var result=vec2f(0);
  for(var j=0;j<4;j++){
    let offset=vec2i(j&1,(j>>1)&1);let p=probeWrap(base+offset);
    let w=select(1.0-f,f,offset==vec2i(1));
    result+=textureLoad(probeVisibilitySampler,vec2i(p.x+p.y*16,index),0).xy*w.x*w.y;
  }
  return result;
}
struct ProbeResult { light:vec3f, count:f32, weight:f32, visibility:f32, inactive:f32, base:i32, rejected:u32 }
fn probeBlocked(index:i32,blocked0:vec4i,blocked1:vec4i)->bool {
  return any(blocked0==vec4i(index))||any(blocked1==vec4i(index));
}
fn probeLightCertified(p:vec3f,g:vec3f,n:vec3f,certified0:vec4i,certified1:vec4i,blocked0:vec4i,blocked1:vec4i)->ProbeResult {
  let dims=vec3i(uniforms.probeDimensions.xyz);
  let biased=p+g*.03;
  let grid=(biased-uniforms.probeGrid.xyz)/uniforms.probeGrid.w;
  let base=clamp(vec3i(floor(grid)),vec3i(0),dims-2);
  let fraction=clamp(grid-vec3f(base),vec3f(0),vec3f(1));
  var result=ProbeResult(vec3f(0),0,0,0,0,0,0u);var guardedSupport=false;
  result.base=base.x+dims.x*(base.y+dims.y*base.z);
  for(var i=0;i<8;i++){
    let offset=vec3i(i&1,(i>>1)&1,(i>>2)&1);let cell=base+offset;
    let index=cell.x+dims.x*(cell.y+dims.y*cell.z);
    let placement=textureLoad(probePlacementSampler,vec2i(0,index),0);
    if(placement.w<.5){result.inactive+=1.0;continue;}if(probeBlocked(index,blocked0,blocked1)){continue;}
    let delta=biased-placement.xyz;let distance=length(delta);let direction=delta/max(distance,.00001);
    let moments=probeMoments(direction,index);
    let difference=max(0.0,distance-moments.x);
    let variance=max(0.000001,moments.y-moments.x*moments.x);
    var visibility=pow(variance/(variance+difference*difference),3.0);
    if(uniforms.probeBypass.x>.5){visibility=1.0;}
    let trilinear=select(1.0-fraction,fraction,offset==vec3i(1));
    var wrap=pow(max(0.0,1.0-dot(g,direction))*.5,2.0);
    if(uniforms.probeBypass.y>.5){wrap=1.0;}
    var weight=visibility*wrap;
    if(weight<.2){weight*=weight*weight/.04;}
    weight*=trilinear.x*trilinear.y*trilinear.z;
    if(weight<=.000001){continue;}
    // Moments smooth weights; exact geometry decides whether support is visible.
    let certified=any(certified0==vec4i(index))||any(certified1==vec4i(index))||any(blocked0==vec4i(-index-2))||any(blocked1==vec4i(-index-2));
    if(!certified&&!probeSegmentClear(p+g*.001,placement.xyz)){result.rejected|=1u<<u32(i);continue;}
    let x=textureLoad(probeIrradianceSampler,vec2i(select(1,0,n.x>=0.0),index),0);
    if(x.a<.5){continue;}
    let y=textureLoad(probeIrradianceSampler,vec2i(select(3,2,n.y>=0.0),index),0);
    let z=textureLoad(probeIrradianceSampler,vec2i(select(5,4,n.z>=0.0),index),0);
    result.light+=(x.rgb*abs(n.x)+y.rgb*abs(n.y)+z.rgb*abs(n.z))/max(.001,abs(n.x)+abs(n.y)+abs(n.z))*weight;
    guardedSupport=guardedSupport||!certified;
    result.weight+=weight;result.visibility+=visibility;result.count+=select(0.0,1.0,weight>.000001);
  }
  result.light=select(vec3f(0),result.light/max(result.weight,.000001),result.weight>.000001);
  if(uniforms.probeDiagnostic>13.5){result.light=select(vec3f(0,.2,1),vec3f(1,.3,0),guardedSupport);if(result.weight<=.000001){result.light=vec3f(1,0,1);}}
  return result;
}


fn probeRejected(index:i32,result:ProbeResult)->bool {
  let d=index-result.base;
  if(d<0||result.rejected==0u){return false;}
  let dims=vec3i(uniforms.probeDimensions.xyz);
  let x=d%dims.x;let y=(d/dims.x)%dims.y;let z=d/(dims.x*dims.y);
  if(x>1||y>1||z>1){return false;}
  return (result.rejected&(1u<<u32(x+2*y+4*z)))!=0u;
}
fn probeLight(p:vec3f,g:vec3f,n:vec3f)->ProbeResult {return probeLightCertified(p,g,n,vec4i(-1),vec4i(-1),vec4i(-1),vec4i(-1));}
