import { VertexData, type Mesh } from "@babylonjs/core";
import type { Vec3 } from "./controller";

export interface SurfaceBox { min:Vec3; max:Vec3; material:number; mesh:Mesh }
export interface SurfaceLayout { cells:Float32Array; charts:Float32Array; clipped?:Float32Array; boxes:SurfaceBox[]; count:number; vertices:number }

/** Prototype atlas for axis-aligned boxes only. Charts split at every solid boundary. */
export function buildSurfaceLayout(boxes:SurfaceBox[],grid:{origin:Vec3;dimensions:Vec3;spacing:number},resolution=.1):SurfaceLayout {
  if(!(resolution>0))throw new Error("Invalid surface resolution");
  const cuts=[0,1,2].map(axis=>[...new Set([
    ...boxes.flatMap(b=>[b.min[axis],b.max[axis]]),
    ...Array.from({length:grid.dimensions[axis]},(_,i)=>grid.origin[axis]+i*grid.spacing),
  ].map(v=>Math.round(v*1e6)/1e6))].sort((a,b)=>a-b));
  const cells:number[]=[],charts:number[]=[];let vertices=0;
  for(const box of boxes){
    const positions:number[]=[],normals:number[]=[],uvs:number[]=[],indices:number[]=[],surface:number[]=[];
    for(let axis=0;axis<3;axis++)for(const sign of [-1,1]){
      const u=(axis+1)%3,v=(axis+2)%3,n=[0,0,0];n[axis]=sign;
      const split=(a:number)=>[box.min[a],...cuts[a].filter(x=>x>box.min[a]+1e-5&&x<box.max[a]-1e-5),box.max[a]];
      const us=split(u),vs=split(v);
      for(let j=0;j<vs.length-1;j++)for(let i=0;i<us.length-1;i++){
        const du=us[i+1]-us[i],dv=vs[j+1]-vs[j];
        const nx=Math.max(1,Math.ceil(du/resolution)),ny=Math.max(1,Math.ceil(dv/resolution));
        const chart=charts.length/4,first=cells.length/16;
        charts.push(first,nx,ny,0);
        const point=(s:number,t:number)=>{const p=[0,0,0];p[axis]=sign>0?box.max[axis]:box.min[axis];p[u]=us[i]+s*du;p[v]=vs[j]+t*dv;return p;};
        for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){
          const stepU=[0,0,0],stepV=[0,0,0];stepU[u]=du/nx;stepV[v]=dv/ny;
          cells.push(...point(x/nx,y/ny),0,...stepU,0,...stepV,0,...n,0);
        }
        const base=positions.length/3;
        for(const [s,t] of [[0,0],[1,0],[1,1],[0,1]]){
          const p=point(s,t);positions.push(...p.map((x,a)=>x-box.mesh.position.asArray()[a]));normals.push(...n);
          uvs.push((p[u]-box.min[u])/(box.max[u]-box.min[u]),(p[v]-box.min[v])/(box.max[v]-box.min[v]));surface.push(s,t,chart);
        }
        indices.push(...(sign>0?[0,2,1,0,3,2]:[0,1,2,0,2,3]).map(x=>base+x));
      }
    }
    const data=new VertexData();Object.assign(data,{positions,normals,uvs,indices});data.applyToMesh(box.mesh);
    box.mesh.setVerticesData("probeSurface",surface,false,3);vertices+=positions.length/3;
  }
  return{cells:new Float32Array(cells),charts:new Float32Array(charts),boxes,count:cells.length/16,vertices};
}

