@group(0) @binding(8) var<storage,read> surfaceClips:array<vec4f>;
var<private> polygon:array<vec3f,6>;
var<private> polygonCount:i32;
var<private> planes:array<vec4f,7>;
var<private> planeCount:i32;

fn surfacePlane(a:vec3f,b:vec3f,c:vec3f,inside:vec3f)->vec4f {
  let raw=cross(b-a,c-a);let n=raw/max(length(raw),.00000001);
  let oriented=select(-n,n,dot(n,inside-a)>=0.0);return vec4f(oriented,-dot(oriented,a));
}
fn triangleInPyramid(a:vec3f,b:vec3f,c:vec3f)->bool {
  var input:array<vec3f,10>;input[0]=a;input[1]=b;input[2]=c;var count=3;
  for(var plane=0;plane<planeCount;plane++){
    var output:array<vec3f,10>;var next=0;
    for(var j=0;j<count;j++){
      let start=input[j];let end=input[(j+1)%count];let ds=dot(planes[plane],vec4f(start,1))-surfaceProofMargin;let de=dot(planes[plane],vec4f(end,1))-surfaceProofMargin;
      if(ds>=0.0){if(next>=10){return true;}output[next]=start;next++;}
      if((ds>=0.0)!=(de>=0.0)){if(next>=10){return true;}output[next]=mix(start,end,ds/(ds-de));next++;}
    }
    if(next<3){return false;}input=output;count=next;
  }
  return true;
}
fn surfaceClear(points:array<vec3f,5>)->bool {
  if(polygonCount<3){return false;}
  let probe=points[4];var center=vec3f(0);
  for(var i=0;i<polygonCount;i++){center+=polygon[i];}
  let baseCenter=center/f32(polygonCount);
  if(!probeSegmentClear(baseCenter,probe)){return false;}
  center=(baseCenter+probe)*.5;
  planes[0]=surfacePlane(polygon[0],polygon[1],polygon[2],center);planeCount=polygonCount+1;
  if(abs(dot(planes[0],vec4f(probe,1)))<.00001){return false;}
  for(var i=0;i<polygonCount;i++){planes[i+1]=surfacePlane(polygon[i],polygon[(i+1)%polygonCount],probe,center);}
  var node=0;
  loop {
    if(node<0){break;}
    let lo=probeGeometry(node).xyz;let hi=probeGeometry(node+1).xyz;let entry=probeGeometry(node+2);
    var outside=false;
    for(var plane=0;plane<planeCount;plane++){
      let corner=select(lo,hi,planes[plane].xyz>=vec3f(0));
      if(dot(planes[plane],vec4f(corner,1))<=surfaceProofMargin){outside=true;break;}
    }
    if(outside){node=i32(entry.z);continue;}
    if(entry.y==0.0){node+=3;continue;}
    for(var i=0;i<i32(entry.y);i++){
      let address=i32(entry.x)+i*3;let a=probeGeometry(address);if(a.w>.5){continue;}
      if(triangleInPyramid(a.xyz,probeGeometry(address+1).xyz,probeGeometry(address+2).xyz)){return false;}
    }
    node=i32(entry.z);
  }
  return true;
}

fn reserveTriangleHit(origin:vec3f,endpoint:vec3f,a:vec3f,b:vec3f,c:vec3f)->bool {
  let delta=endpoint-origin;let distance=length(delta);if(distance<.0002){return false;}
  let e=b-a;let f=c-a;let h=cross(delta,f);let determinant=dot(e,h);
  if(abs(determinant)<.0000001*distance){return false;}
  let s=origin-a;let u=dot(s,h)/determinant;let q=cross(s,e);let v=dot(delta,q)/determinant;
  let t=dot(f,q)/determinant;
  return u>.000001&&v>.000001&&u+v<.999999&&t>.0001/distance&&t<1.0-.0001/distance;
}
// A triangle's shadow is convex: blocking all corners blocks the expanded cell.
fn surfaceReserveBlocked(probe:vec3f,bounds:array<vec3f,8>)->bool {
  let origin=(bounds[0]+bounds[7])*.5;
  if(probeSegmentClear(origin,probe)){return false;}
  let delta=probe-origin;let limit=length(delta);if(limit<.0002){return false;}let direction=delta/limit;
  var node=0;
  loop {
    if(node<0){break;}
    let lo=probeGeometry(node).xyz;let hi=probeGeometry(node+1).xyz;let entry=probeGeometry(node+2);
    var near=0.0;var far=limit;
    for(var axis=0;axis<3;axis++){
      if(abs(direction[axis])<.0000001){if(origin[axis]<lo[axis]||origin[axis]>hi[axis]){far=-1.0;}}
      else{let a=(lo[axis]-origin[axis])/direction[axis];let b=(hi[axis]-origin[axis])/direction[axis];near=max(near,min(a,b));far=min(far,max(a,b));}
    }
    if(far<near){node=i32(entry.z);continue;}
    if(entry.y==0.0){node+=3;continue;}
    for(var i=0;i<i32(entry.y);i++){
      let address=i32(entry.x)+i*3;let a=probeGeometry(address);if(a.w>.5){continue;}
      let b=probeGeometry(address+1).xyz;let c=probeGeometry(address+2).xyz;
      if(!reserveTriangleHit(origin,probe,a.xyz,b,c)){continue;}
      var covered=true;
      for(var corner=0;corner<8;corner++){if(!reserveTriangleHit(bounds[corner],probe,a.xyz,b,c)){covered=false;break;}}
      if(covered){return true;}
    }
    node=i32(entry.z);
  }
  return false;
}
fn surfaceReserveVisible(probe:vec3f)->bool {
  var center=vec3f(0);for(var i=0;i<polygonCount;i++){center+=polygon[i];}center/=f32(polygonCount);
  if(probeSegmentClear(center,probe)){return true;}
  for(var i=0;i<polygonCount;i++){
    if(probeSegmentClear(mix(polygon[i],center,.01),probe)){return true;}
    if(probeSegmentClear(mix((polygon[i]+polygon[(i+1)%polygonCount])*.5,center,.01),probe)){return true;}
  }
  return false;
}
