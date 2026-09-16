// Distance intervals, not bounce levels. All geometry tests use the full scene.
struct Node { lo:vec3f, left:u32, hi:vec3f, right:u32, first:u32, count:u32, escape:u32, flags:u32 }
struct Triangle { a:vec4f, b:vec4f, c:vec4f, material:vec4u, uv0:vec4f, uv1:vec4f }
struct Surface { position:vec4f, normal:vec4f, color:vec4f }
struct SurfaceLight { radiance:vec4f, visibility:vec4f }
struct Params {
  sun:vec4f, sunColor:vec4f, sky:vec4f,
  lamp0:vec4f, lampColor0:vec4f, lamp1:vec4f, lampColor1:vec4f,
  origin:vec4f, dimensions:vec4f, range:vec4f, nextDimensions:vec4f, nextRange:vec4f, update:vec4f,
}
struct Hit { distance:f32, pixel:u32, facing:f32 }
@group(0) @binding(0) var<storage,read> nodes:array<Node>;
@group(0) @binding(1) var<storage,read> triangles:array<Triangle>;
@group(0) @binding(2) var<storage,read> surfaces:array<Surface>;
@group(0) @binding(3) var<uniform> params:Params;
@group(0) @binding(4) var<storage,read_write> hits:array<vec4f>;
@group(0) @binding(5) var<storage,read_write> surfaceLight:array<SurfaceLight>;
@group(0) @binding(6) var<storage,read_write> cascades:array<vec4f>;
@group(0) @binding(7) var output:texture_storage_2d<rgba16float,write>;
const PI:f32 = 3.14159265359;
const RAYS:u32 = 64u;
const SKY_RAYS:u32 = 1024u;

fn trace(origin:vec3f, direction:vec3f, limit:f32)->Hit {
  var hit=Hit(limit,0u,0.0);
  var node=0u;
  let inverse=1.0/select(select(vec3f(-1e-7),vec3f(1e-7),direction>=vec3f(0)),direction,abs(direction)>vec3f(1e-7));
  loop {
    if(node==0xffffffffu){break;}
    let n=nodes[node];
    let a=(n.lo-origin)*inverse; let b=(n.hi-origin)*inverse;
    let near=max(max(min(a,b).x,min(a,b).y),min(a,b).z);
    let far=min(min(max(a,b).x,max(a,b).y),max(a,b).z);
    if(far<max(near,0.0)||near>hit.distance){node=n.escape;continue;}
    if(n.count==0u){node=n.right;continue;}
    for(var i=0u;i<n.count;i++) {
      let tri=triangles[n.first+i]; let e1=tri.b.xyz-tri.a.xyz; let e2=tri.c.xyz-tri.a.xyz;
      let p=cross(direction,e2); let det=dot(e1,p);
      if(abs(det)<1e-7){continue;}
      let s=origin-tri.a.xyz; let u=dot(s,p)/det;
      if(u<0.0||u>1.0){continue;}
      let q=cross(s,e1); let v=dot(direction,q)/det;
      if(v<0.0||u+v>1.0){continue;}
      let t=dot(e2,q)/det;
      if(t>.001&&t<hit.distance){
        let uv=tri.uv0.xy*(1.0-u-v)+tri.uv0.zw*u+tri.uv1.xy*v;
        let pixel=vec2u(clamp(floor(uv*params.sky.w),vec2f(0),vec2f(params.sky.w-1.0)));
        hit=Hit(t,pixel.y*u32(params.sky.w)+pixel.x,select(-1.0,1.0,det>0.0));
      }
    }
    node=n.escape;
  }
  return hit;
}

fn hemisphere(normal:vec3f, ray:u32, count:u32)->vec3f {
  let u=(f32(ray)+.5)/f32(count);
  let phi=f32(ray)*2.39996322973;
  let helper=select(vec3f(0,1,0),vec3f(1,0,0),abs(normal.y)>.9);
  let tangent=normalize(cross(helper,normal)); let bitangent=cross(normal,tangent);
  return tangent*(sqrt(u)*cos(phi))+bitangent*(sqrt(u)*sin(phi))+normal*sqrt(1.0-u);
}

fn direction(uv:vec2f, resolution:f32)->vec3f {
  let y=1.0-2.0*uv.y/resolution;
  let phi=uv.x/(2.0*resolution)*2.0*PI;
  let r=sqrt(max(0.0,1.0-y*y));
  return vec3f(r*cos(phi),y,r*sin(phi));
}

fn record(hit:Hit)->vec4f { return vec4f(f32(hit.pixel),hit.facing,0,0); }
fn hitLight(hit:vec4f)->vec3f {
  if(hit.y<=0.0){return vec3f(0);}
  return surfaceLight[u32(hit.x)].radiance.rgb;
}

@compute @workgroup_size(64)
fn prepareSurfaces(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=u32(params.update.y)){return;}
  let index=id.x+u32(params.update.x); let surface=surfaces[index];
  if(surface.position.w==0.0){return;}
  let origin=surface.position.xyz+surface.normal.xyz*.004;
  for(var ray=0u;ray<RAYS;ray++) {
    let hit=trace(origin,hemisphere(surface.normal.xyz,ray,RAYS),params.origin.w);
    hits[u32(params.update.z)+index*RAYS+ray]=record(hit);
  }
  // Sky visibility is reused for every lighting state; spend samples once to avoid bands.
  var open=0.0;
  for(var ray=0u;ray<SKY_RAYS;ray++) {
    let hit=trace(origin,hemisphere(surface.normal.xyz,ray,SKY_RAYS),24.0);
    open+=select(0.0,1.0,hit.facing==0.0);
  }
  let delta0=params.lamp0.xyz-origin; let delta1=params.lamp1.xyz-origin;
  let visible0=trace(origin,normalize(delta0),length(delta0)-.004).facing==0.0;
  let visible1=trace(origin,normalize(delta1),length(delta1)-.004).facing==0.0;
  surfaceLight[index].visibility=vec4f(open/f32(SKY_RAYS),f32(visible0),f32(visible1),1);
}

@compute @workgroup_size(64)
fn prepareIntervals(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=u32(params.update.y)){return;}
  let index=id.x+u32(params.update.x);
  let n=u32(params.range.z); let directions=2u*n*n;
  let probe=index/directions; let ray=index%directions;
  let dims=vec3u(params.dimensions.xyz);
  let coordinate=vec3u(probe%dims.x,(probe/dims.x)%dims.y,probe/(dims.x*dims.y));
  let d=direction(vec2f(f32(ray%(2u*n))+.5,f32(ray/(2u*n))+.5),f32(n));
  let origin=params.origin.xyz+vec3f(coordinate)*params.dimensions.w+d*params.range.x;
  hits[u32(params.range.w)+index]=record(trace(origin,d,params.range.y-params.range.x));
}

fn lampIrradiance(surface:Surface, lamp:vec4f, color:vec3f, visible:f32)->vec3f {
  let delta=lamp.xyz-surface.position.xyz;
  return color*(lamp.w*visible*max(0.0,dot(surface.normal.xyz,normalize(delta)))/max(.01,dot(delta,delta)));
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
    irradiance+=lampIrradiance(surface,params.lamp0,params.lampColor0.rgb,visibility.y);
    irradiance+=lampIrradiance(surface,params.lamp1,params.lampColor1.rgb,visibility.z);
  }
  surfaceLight[id.x].radiance=vec4f(surface.color.rgb*(irradiance/PI+params.sky.rgb*visibility.x),1);
}

fn angular(probe:u32, uv:vec2i, n:u32, offset:u32)->vec3f {
  let x=u32((uv.x+i32(2u*n))%i32(2u*n));
  let y=u32(clamp(uv.y,0,i32(n)-1));
  return cascades[offset+probe*2u*n*n+y*2u*n+x].rgb;
}

fn sampleCascade(position:vec3f, d:vec3f, dimensions:vec4f, range:vec4f)->vec3f {
  let dims=vec3u(dimensions.xyz); let n=u32(range.z);
  let grid=clamp((position-params.origin.xyz)/dimensions.w,vec3f(0),dimensions.xyz-vec3f(1.001));
  let lo=vec3u(floor(grid)); let fraction=fract(grid);
  let phi=fract(atan2(d.z,d.x)/(2.0*PI)+1.0);
  let uv=vec2f(phi*2.0*range.z,(1.0-d.y)*.5*range.z)-.5;
  let texel=vec2i(floor(uv)); let blend=fract(uv);
  var result=vec3f(0);
  for(var corner=0u;corner<8u;corner++) {
    let step=vec3u(corner&1u,(corner>>1u)&1u,(corner>>2u)&1u);
    let p=lo+step; let weight=mix(vec3f(1)-fraction,fraction,vec3f(step));
    let index=(p.z*dims.y+p.y)*dims.x+p.x;
    let a=mix(angular(index,texel,n,u32(range.w)),angular(index,texel+vec2i(1,0),n,u32(range.w)),blend.x);
    let b=mix(angular(index,texel+vec2i(0,1),n,u32(range.w)),angular(index,texel+vec2i(1,1),n,u32(range.w)),blend.x);
    result+=mix(a,b,blend.y)*weight.x*weight.y*weight.z;
  }
  return result;
}

@compute @workgroup_size(64)
fn merge(@builtin(global_invocation_id) id:vec3u) {
  let n=u32(params.range.z); let directions=2u*n*n;
  let dims=vec3u(params.dimensions.xyz);
  if(id.x>=dims.x*dims.y*dims.z*directions){return;}
  let index=u32(params.range.w)+id.x; let hit=hits[index];
  var radiance=hitLight(hit);
  if(hit.y==0.0) {
    // Sky's direct contribution uses the exact cached surface visibility below.
    radiance=vec3f(0);
    if(params.update.w<.5) {
      let probe=id.x/directions; let ray=id.x%directions;
      let coordinate=vec3u(probe%dims.x,(probe/dims.x)%dims.y,probe/(dims.x*dims.y));
      let origin=params.origin.xyz+vec3f(coordinate)*params.dimensions.w;
      let uv=vec2f(f32(ray%(2u*n)),f32(ray/(2u*n)));
      radiance=vec3f(0);
      // Four directional children cover the parent interval's solid angle.
      for(var child=0u;child<4u;child++) {
        let sub=vec2f(f32(child&1u),f32(child>>1u));
        let d=direction(uv*2.0+sub+.5,f32(n)*2.0);
        radiance+=sampleCascade(origin,d,params.nextDimensions,params.nextRange)*.25;
      }
    }
  }
  cascades[index]=vec4f(radiance,select(0.0,1.0,hit.y==0.0));
}

@compute @workgroup_size(64)
fn gather(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=u32(params.update.y)){return;}
  let surface=surfaces[id.x]; var radiance=vec3f(0);
  if(surface.position.w>0.0) {
    let origin=surface.position.xyz+surface.normal.xyz*.004;
    for(var ray=0u;ray<RAYS;ray++) {
      let hit=hits[u32(params.update.z)+id.x*RAYS+ray];
      if(hit.y==0.0) {
        radiance+=sampleCascade(origin,hemisphere(surface.normal.xyz,ray,RAYS),params.dimensions,params.range);
      }else{radiance+=hitLight(hit);}
    }
    radiance*=surface.color.rgb/f32(RAYS);
    radiance+=surface.color.rgb*params.sky.rgb*surfaceLight[id.x].visibility.x;
  }
  let size=u32(params.sky.w);
  textureStore(output,vec2u(id.x%size,id.x/size),vec4f(radiance,1));
}
