struct Node { lo:vec3f, left:u32, hi:vec3f, right:u32, first:u32, count:u32, escape:u32, flags:u32 }
struct Triangle { a:vec4f, b:vec4f, c:vec4f, material:vec4u, uv0:vec4f, uv1:vec4f }
struct Fixture { position:vec4f, color:vec4f, direction:vec4f }
struct Params { sun:vec4f, sunColor:vec4f, grid:vec4f, dimensions:vec4f, update:vec4f }
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
  var node=0u;
  loop {
    if(node==0xffffffffu){break;} let n=nodes[node];
    if((n.flags&1u)==0u || !intersects(origin,direction,n.lo,n.hi,hit.distance)){node=n.escape;continue;}
    if(n.count==0u){node=n.right;continue;}
    for(var i=0u;i<n.count;i++) {
      let tri=triangles[n.first+i]; if(materials[tri.material.x].w>0.0){continue;} let e1=tri.b.xyz-tri.a.xyz; let e2=tri.c.xyz-tri.a.xyz;
      let p=cross(direction,e2); let det=dot(e1,p);
      if(abs(det)<.0000001){continue;}
      let s=origin-tri.a.xyz; let u=dot(s,p)/det; if(u<0.0||u>1.0){continue;}
      let q=cross(s,e1); let v=dot(direction,q)/det; if(v<0.0||u+v>1.0){continue;}
      let t=dot(e2,q)/det;
      if(t>.001 && t<hit.distance){hit=Hit(t,normalize(cross(e1,e2)),tri.material.x,n.first+i,vec2f(u,v));}
    }
    node=n.escape;
  }
  return hit;
}
fn occluded(origin:vec3f,direction:vec3f,limit:f32)->bool {
  var node=0u;
  loop {
    if(node==0xffffffffu){break;}let n=nodes[node];
    if((n.flags&1u)==0u||!intersects(origin,direction,n.lo,n.hi,limit)){node=n.escape;continue;}
    if(n.count==0u){node=n.right;continue;}
    for(var i=0u;i<n.count;i++){
      let tri=triangles[n.first+i];if(materials[tri.material.x].w>0.0){continue;}
      let e1=tri.b.xyz-tri.a.xyz;let e2=tri.c.xyz-tri.a.xyz;
      let p=cross(direction,e2);let det=dot(e1,p);if(abs(det)<.0000001){continue;}
      let s=origin-tri.a.xyz;let u=dot(s,p)/det;if(u<0.0||u>1.0){continue;}
      let q=cross(s,e1);let v=dot(direction,q)/det;if(v<0.0||u+v>1.0){continue;}
      let t=dot(e2,q)/det;if(t>.001&&t<limit){return true;}
    }
    node=n.escape;
  }
  return false;
}
fn hash(x:u32)->f32 {var v=x;v=(v^(v>>16u))*2246822519u;v=(v^(v>>13u))*3266489917u;return f32(v^(v>>16u))/4294967296.0;}
fn octDirection(uv:vec2f)->vec3f {var n=vec3f(uv,1.0-abs(uv.x)-abs(uv.y));if(n.z<0.0){n=vec3f((1.0-abs(n.yx))*select(vec2f(-1),vec2f(1),n.xy>=vec2f(0)),n.z);}return normalize(n);}
