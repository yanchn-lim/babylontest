import { buildBvh, type Triangle } from "./bvh";

/** Float texture layout: three texels per node or triangle; preorder escape links. */
export function packVisibilityGeometry(triangles:Triangle[],transmitting:readonly boolean[]){
  if(!triangles.length)throw new Error("GI requires geometry");
  const bvh=buildBvh(triangles.filter(t=>!transmitting[t.material]),"surface-area"),width=1024;
  const height=Math.max(1,Math.ceil((bvh.nodes.length+bvh.triangles.length)*3/width));
  const data=new Float32Array(width*height*4);
  function write(index:number,escape:number){
    const n=bvh.nodes[index],o=index*12;
    data.set([...n.min,0,...n.max,0,(bvh.nodes.length+n.first)*3,n.count,escape,0],o);
    if(!n.count){write(n.left,n.right*3);write(n.right,escape);}
  }
  if(bvh.nodes.length)write(0,-1);
  else {
    data[8]=3;data[9]=1;data[10]=-1;
    data[15]=1;
  }
  bvh.triangles.forEach((t,i)=>data.set([...t.a,Number(transmitting[t.material]??false),...t.b,0,...t.c,0],(bvh.nodes.length+i)*12));
  return{data,width,height};
}

