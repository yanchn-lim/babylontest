varying vProbeSurface:vec3f;
var probeSurfaceSampler:texture_2d_array<f32>;
var probeSurfaceSamplerSampler:sampler;
var probeChartSampler:texture_2d<f32>;
var probeChartSamplerSampler:sampler;
fn surfaceLight(coordinates:vec3f,p:vec3f,g:vec3f,n:vec3f)->ProbeResult {
  let chartId=i32(round(coordinates.z));
  let chart=textureLoad(probeChartSampler,vec2i(chartId%256,chartId/256),0);
  let uv=clamp(coordinates.xy,vec2f(0),vec2f(1))*chart.yz;
  let cell=min(vec2i(floor(uv)),vec2i(chart.yz)-1);let f=clamp(uv-vec2f(cell),vec2f(0),vec2f(1));
  let address=i32(chart.x)+cell.x+i32(chart.y)*cell.y;
  let xy=vec2i(address%256,address/256);
  let ids0=textureLoad(probeSurfaceSampler,xy,0,0);let ids1=textureLoad(probeSurfaceSampler,xy,1,0);
  var aligned=false;
  if(chart.w!=0.0){aligned=g[i32(abs(chart.w))-1]*sign(chart.w)>.99999;}
  let occluded0=select(vec4i(-1),vec4i(textureLoad(probeSurfaceSampler,xy,12,0)),aligned);let occluded1=select(vec4i(-1),vec4i(textureLoad(probeSurfaceSampler,xy,13,0)),aligned);
  let point=probeLightCertified(p,g,n,vec4i(ids0),vec4i(ids1),occluded0,occluded1);
  if(point.weight>.000001){return point;}
  let blend=vec4f((1.0-f.x)*(1.0-f.y),f.x*(1.0-f.y),(1.0-f.x)*f.y,f.x*f.y);
  var result=ProbeResult(vec3f(0),0,0,0,0,0,0u);var support=0u;var rejected=0u;
  for(var i=0;i<8;i++){
    let stored=i32(select(ids0[i%4],ids1[i%4],i>=4));if(stored==-1){continue;}
    let guarded=stored<-1;let index=select(stored,-stored-2,guarded);if(probeBlocked(index,occluded0,occluded1)||probeRejected(index,point)){continue;}
    let weight=dot(textureLoad(probeSurfaceSampler,xy,i+2,0),blend);if(weight<=.000001){continue;}
    if(guarded&&!probeSegmentClear(p+g*.001,textureLoad(probePlacementSampler,vec2i(0,index),0).xyz)){rejected|=1u<<u32(i);continue;}
    let x=textureLoad(probeIrradianceSampler,vec2i(select(1,0,n.x>=0.0),index),0);
    if(x.a<.5){continue;}
    let y=textureLoad(probeIrradianceSampler,vec2i(select(3,2,n.y>=0.0),index),0);
    let z=textureLoad(probeIrradianceSampler,vec2i(select(5,4,n.z>=0.0),index),0);
    result.light+=(x.rgb*abs(n.x)+y.rgb*abs(n.y)+z.rgb*abs(n.z))/max(.001,abs(n.x)+abs(n.y)+abs(n.z))*weight;
    result.weight+=weight;result.count+=1.0;support=select(1u,2u,guarded);
  }
  // Preserve primary interpolation; only unsupported pixels consult the reserve list.
  if(result.weight<=.000001){
    let blocked0=select(vec4i(-1),-vec4i(ids0)-2,(vec4u(rejected)&vec4u(1,2,4,8))!=vec4u(0));
    let blocked1=select(vec4i(-1),-vec4i(ids1)-2,(vec4u(rejected)&vec4u(16,32,64,128))!=vec4u(0));
    let reserve0=textureLoad(probeSurfaceSampler,xy,10,0);let reserve1=textureLoad(probeSurfaceSampler,xy,11,0);
    for(var i=0;i<8;i++){
      let index=i32(select(reserve0[i%4],reserve1[i%4],i>=4));if(index<0||probeBlocked(index,occluded0,occluded1)||probeRejected(index,point)){continue;}if(any(blocked0==vec4i(index))||any(blocked1==vec4i(index))){continue;}
      let placement=textureLoad(probePlacementSampler,vec2i(0,index),0);if(placement.w<.5){continue;}
      let delta=placement.xyz-p;let d=max(.001,length(delta));let weight=max(0.0,dot(g,delta/d))/(d*d);if(weight<=.000001){continue;}
      let x=textureLoad(probeIrradianceSampler,vec2i(select(1,0,n.x>=0.0),index),0);if(x.a<.5){continue;}
      if(!probeSegmentClear(p+g*.001,placement.xyz)){continue;}
      let y=textureLoad(probeIrradianceSampler,vec2i(select(3,2,n.y>=0.0),index),0);
      let z=textureLoad(probeIrradianceSampler,vec2i(select(5,4,n.z>=0.0),index),0);
      result.light+=(x.rgb*abs(n.x)+y.rgb*abs(n.y)+z.rgb*abs(n.z))/max(.001,abs(n.x)+abs(n.y)+abs(n.z))*weight;
      result.weight+=weight;result.count+=1.0;support=3u;
    }
  }
  result.visibility=result.count;
  result.light=select(vec3f(0),result.light/max(result.weight,.000001),result.weight>.000001);
  if(uniforms.probeDiagnostic>13.5){result.light=array<vec3f,4>(vec3f(1,0,1),vec3f(0,.2,1),vec3f(1,.3,0),vec3f(0,1,.2))[support];}
  return result;
}
