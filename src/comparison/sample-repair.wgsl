@group(0) @binding(12) var<storage,read> rayOrigins:array<vec4f>;
@group(0) @binding(13) var<storage,read> sampleRemap:array<u32>;

fn trace(origin:vec3f,direction:vec3f,limit:f32)->Hit {
  let minimum=max(.00001,max(abs(origin.x),max(abs(origin.y),abs(origin.z)))*.000001);
  return traceMinimum(origin,direction,limit,minimum);
}
