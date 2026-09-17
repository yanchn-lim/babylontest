// Room-scale floating-point tolerance, independent of triangle count.
fn surfaceMinimum(surface:Surface)->f32 {
  let p=abs(surface.position.xyz);
  return max(.00001,max(p.x,max(p.y,p.z))*.000001);
}

fn surfaceOffset(surface:Surface)->f32 {
  let minimum=surfaceMinimum(surface);
  // Both sides detect nearby obstructions and the thickness of closed parts.
  let front=traceMinimum(surface.position.xyz,surface.normal.xyz,.016,minimum);
  let back=traceMinimum(surface.position.xyz,-surface.normal.xyz,.016,minimum);
  return max(minimum*4.0,min(.004,min(front.distance,back.distance)*.25));
}

fn traceSurface(origin:vec3f,surface:Surface,direction:vec3f,limit:f32)->Hit {
  return traceMinimum(origin,direction,limit,surfaceMinimum(surface));
}

// Interval probes keep their original tolerance; this experiment uses cached GI.
fn trace(origin:vec3f,direction:vec3f,limit:f32)->Hit {
  return traceMinimum(origin,direction,limit,.001);
}
