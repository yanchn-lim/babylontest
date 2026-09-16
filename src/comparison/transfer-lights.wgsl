// Apartment variant: cache visibility for up to eight fixed point lights.
@group(0) @binding(11) var<storage,read> fixedLights:array<vec4f>;

@compute @workgroup_size(64)
fn prepareTransfer(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=u32(params.update.y)){return;}
  let index=id.x+u32(params.update.x);
  let surface=surfaces[index];
  if(surface.position.w==0.0){return;}
  let origin=surface.position.xyz+surface.normal.xyz*.004;
  var open=0.0;
  for(var ray=0u;ray<SKY_RAYS;ray++) {
    let hit=trace(origin,hemisphere(surface.normal.xyz,ray,SKY_RAYS),24.0);
    transfer[id.x*SKY_RAYS+ray]=select(0xffffffffu,hit.pixel,hit.facing>0.0);
    open+=select(0.0,1.0,hit.facing==0.0);
  }
  var visible=0u;
  for(var lamp=0u;lamp<arrayLength(&fixedLights)/2u;lamp++) {
    let delta=fixedLights[lamp*2u].xyz-origin;
    if(trace(origin,normalize(delta),length(delta)-.004).facing==0.0){visible|=1u<<lamp;}
  }
  surfaceLight[index].visibility=vec4f(open/f32(SKY_RAYS),0,0,f32(visible));
}

@compute @workgroup_size(64)
fn shade(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=u32(params.update.y)){return;}
  let surface=surfaces[id.x];
  if(surface.position.w==0.0){return;}
  let visibility=surfaceLight[id.x].visibility;
  var irradiance=vec3f(0);
  let cosine=max(0.0,dot(surface.normal.xyz,params.sun.xyz));
  if(params.sun.w>0.0&&cosine>0.0) {
    let hit=trace(surface.position.xyz+surface.normal.xyz*.004,params.sun.xyz,24.0);
    if(hit.facing==0.0){irradiance+=params.sunColor.rgb*params.sun.w*cosine;}
  }
  if(params.sunColor.w>.5) {
    for(var lamp=0u;lamp<arrayLength(&fixedLights)/2u;lamp++) {
      let visible=f32((u32(visibility.w)>>lamp)&1u);
      irradiance+=lampIrradiance(surface,fixedLights[lamp*2u],fixedLights[lamp*2u+1u].rgb,visible);
    }
  }
  surfaceLight[id.x].radiance=vec4f(surface.color.rgb*(irradiance/PI+params.sky.rgb*visibility.x),1);
}
