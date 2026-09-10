import type { Vec3, Bounds } from "./controller";
export interface Triangle { a: Vec3; b: Vec3; c: Vec3; material: number; uv?: [number,number,number,number,number,number] }
export interface BvhNode extends Bounds { left: number; right: number; first: number; count: number }
export function buildBvh(input: readonly Triangle[], split:"median"|"surface-area"="median") {
  const triangles = input.map(t => structuredClone(t));
  const nodes: BvhNode[] = [];
  function build(first: number, count: number): number {
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = first; i < first + count; i++) for (const p of [triangles[i].a, triangles[i].b, triangles[i].c]) for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], p[axis]); max[axis] = Math.max(max[axis], p[axis]);
    }
    const index = nodes.length;
    nodes.push({ min, max, left: -1, right: -1, first, count });
    if (count <= 4) return index;
    const extent = max.map((v, i) => v - min[i]);
    const axis = extent.indexOf(Math.max(...extent));
    const slice=triangles.slice(first,first+count);
    const {ordered,half}=split==="surface-area" ? surfaceAreaSplit(slice) : {
      ordered:slice.sort((a,b)=>(a.a[axis]+a.b[axis]+a.c[axis])-(b.a[axis]+b.b[axis]+b.c[axis])),
      half:Math.floor(count/2)
    };
    for(let i=0;i<count;i++)triangles[first+i]=ordered[i];
    nodes[index].left = build(first, half); nodes[index].right = build(first + half, count - half); nodes[index].count = 0;
    return index;
  }
  if (triangles.length) build(0, triangles.length);
  return { nodes, triangles };
}
function surfaceAreaSplit(input:Triangle[]){
  let ordered=input,half=Math.floor(input.length/2),best=Infinity;
  const margin=Math.max(1,Math.floor(input.length/8));
  const area=(lo:number[],hi:number[])=>{
    const d=hi.map((v,i)=>v-lo[i]);
    return d[0]*d[1]+d[1]*d[2]+d[2]*d[0];
  };
  for(let axis=0;axis<3;axis++){
    const sorted=[...input].sort((a,b)=>(a.a[axis]+a.b[axis]+a.c[axis])-(b.a[axis]+b.b[axis]+b.c[axis]));
    const prefix:number[]=[];
    let lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
    const include=(t:Triangle)=>{
      for(const p of [t.a,t.b,t.c])for(let k=0;k<3;k++){
        lo[k]=Math.min(lo[k],p[k]);hi[k]=Math.max(hi[k],p[k]);
      }
    };
    for(let i=0;i<sorted.length;i++){include(sorted[i]);prefix[i]=area(lo,hi);}
    lo=[Infinity,Infinity,Infinity];hi=[-Infinity,-Infinity,-Infinity];
    for(let i=sorted.length-1;i>=margin;i--){
      include(sorted[i]);
      if(i>sorted.length-margin)continue;
      const cost=prefix[i-1]*i+area(lo,hi)*(sorted.length-i);
      if(cost<best){best=cost;ordered=sorted;half=i;}
    }
  }
  return {ordered,half};
}
export function boxTriangles(min: Vec3, max: Vec3, material: number): Triangle[] {
  const p = Array.from({ length: 8 }, (_, i) => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]] as Vec3);
  // Outward winding on all six faces.
  return [[0,4,6,2],[1,3,7,5],[0,1,5,4],[2,6,7,3],[0,2,3,1],[4,5,7,6]].flatMap(([a,b,c,d]) => [{a:p[a],b:p[b],c:p[c],material},{a:p[a],b:p[c],c:p[d],material}]);
}
export function packBvh(bvh: ReturnType<typeof buildBvh>, transmitting: readonly boolean[] = []) {
  const nodes = new ArrayBuffer(Math.max(1, bvh.nodes.length) * 48);
  const nf = new Float32Array(nodes), nu = new Uint32Array(nodes);
  bvh.nodes.forEach((n, i) => {
    const o = i * 12;
    nf.set(n.min, o); nf.set(n.max, o + 4);
    nu[o + 3] = n.left < 0 ? 0 : n.left; nu[o + 7] = n.right < 0 ? 0 : n.right;
    nu[o + 8] = n.first; nu[o + 9] = n.count;
  });
  // Match the existing stack's right-child-first traversal, including hit ties.
  function escape(index:number,next:number):number{
    const n=bvh.nodes[index];nu[index*12+10]=next;
    let flags=0;
    if(n.count){
      for(let i=n.first;i<n.first+n.count;i++)flags|=transmitting[bvh.triangles[i].material]?2:1;
    }else{
      flags=escape(n.right,n.left)|escape(n.left,next);
    }
    nu[index*12+11]=flags;
    return flags;
  }
  if(bvh.nodes.length)escape(0,0xffffffff);
  const triangles = new ArrayBuffer(Math.max(1, bvh.triangles.length) * 96);
  const tf = new Float32Array(triangles), tu = new Uint32Array(triangles);
  bvh.triangles.forEach((t, i) => {
    const o = i * 24; tf.set(t.a, o); tf.set(t.b, o + 4); tf.set(t.c, o + 8); tu[o + 12] = t.material; tf.set(t.uv ?? [0,0,0,0,0,0], o + 16);
  });
  return { nodes, triangles };
}
