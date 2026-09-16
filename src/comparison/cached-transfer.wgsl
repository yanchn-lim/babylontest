// Appended to the cascade source to share tracing, sampling and direct lighting.
@group(0) @binding(9) var<storage,read_write> transfer:array<u32>;
@group(0) @binding(10) var<storage,read> offsets:array<u32>;

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
  let delta0=params.lamp0.xyz-origin; let delta1=params.lamp1.xyz-origin;
  let visible0=trace(origin,normalize(delta0),length(delta0)-.004).facing==0.0;
  let visible1=trace(origin,normalize(delta1),length(delta1)-.004).facing==0.0;
  surfaceLight[index].visibility=vec4f(open/f32(SKY_RAYS),f32(visible0),f32(visible1),1);
}

@compute @workgroup_size(64)
fn gatherTransfer(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=u32(params.update.y)){return;}
  let surface=surfaces[id.x];
  var radiance=vec3f(0);
  for(var entry=offsets[id.x];entry<offsets[id.x+1u];entry++) {
    // Atlas index and integer hit count: no weight quantization or dropped hits.
    let packed=transfer[entry];
    radiance+=surfaceLight[packed&65535u].radiance.rgb*f32(packed>>16u);
  }
  radiance*=surface.color.rgb/f32(SKY_RAYS);
  bounceLight[id.x].radiance=vec4f(radiance,1);
  var total=radiance;
  if(params.bounce.x==0.0) {
    total+=surface.color.rgb*params.sky.rgb*surfaceLight[id.x].visibility.x;
  }else{total+=bounceLight[id.x].total.rgb;}
  bounceLight[id.x].total=vec4f(total,1);
  if(params.bounce.y>.5) {
    let size=u32(params.sky.w);
    textureStore(output,vec2u(id.x%size,id.x/size),vec4f(total,1));
  }
}
