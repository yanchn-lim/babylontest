import { partitionSurfaceMeshes } from "./surface-partition";
import { Vector3, type Mesh } from "@babylonjs/core";
import type { SurfaceLayout } from "./surface-layout";

/** Separate charts retain imported PBR attributes; cells stop at triangle boundaries. */
export function buildApartmentSurfaceLayout(meshes:Mesh[],resolution=.1):SurfaceLayout {
  partitionSurfaceMeshes(meshes);
  const cells:number[]=[],charts:number[]=[],clipped:number[]=[];let vertices=0;
  for(const mesh of meshes){
    mesh.computeWorldMatrix(true);
    const indices=Array.from(mesh.getIndices()!),positions=mesh.getVerticesData("position")!;
    const attributes=mesh.getVerticesDataKinds().map(kind=>({kind,size:mesh.getVertexBuffer(kind)!.getSize(),data:mesh.getVerticesData(kind)!,output:[] as number[]}));
    const surface:number[]=[];
    for(let i=0;i<indices.length;i+=3){
      const ids=indices.slice(i,i+3),points=ids.map(id=>Vector3.TransformCoordinates(Vector3.FromArray(positions,id*3),mesh.getWorldMatrix()));
      const lengths=points.map((p,j)=>Vector3.Distance(p,points[(j+1)%3]));const edge=lengths.indexOf(Math.max(...lengths));
      const a=points[edge],b=points[(edge+1)%3],c=points[(edge+2)%3],u=b.subtract(a).normalize();
      const n=Vector3.Cross(b.subtract(a),c.subtract(a)).normalize(),v=Vector3.Cross(n,u);
      const width=Vector3.Distance(a,b),height=Vector3.Dot(c.subtract(a),v);
      if(width<1e-8||height<1e-8)throw new Error("Degenerate apartment surface triangle");
      const tip=Vector3.Dot(c.subtract(a),u)/width;
      const nx=Math.max(1,Math.ceil(width/resolution)),ny=Math.max(1,Math.ceil(height/resolution));
      const normal=n.scale(mesh.getWorldMatrix().determinant()<0?-1:1).asArray();
      const axis=normal.findIndex(value=>Math.abs(value)>.999999);
      const normalCode=axis<0?0:(axis+1)*Math.sign(normal[axis]);
      const chart=charts.length/4;charts.push(cells.length/16,nx,ny,normalCode);
      const world=(x:number,y:number)=>a.add(u.scale(x*width)).add(v.scale(y*height));
      for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){
        let polygon=[[x/nx,y/ny],[(x+1)/nx,y/ny],[(x+1)/nx,(y+1)/ny],[x/nx,(y+1)/ny]];
        const triangle=[[0,0],[1,0],[tip,1]];
        for(let side=0;side<3;side++){
          const p=triangle[side],q=triangle[(side+1)%3],next:number[][]=[];
          const distance=(r:number[])=> (q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
          for(let j=0;j<polygon.length;j++){
            const start=polygon[j],end=polygon[(j+1)%polygon.length],ds=distance(start),de=distance(end);
            if(ds>=0)next.push(start);
            if((ds>=0)!==(de>=0)){const t=ds/(ds-de);next.push(start.map((value,k)=>value+t*(end[k]-value)));}
          }
          polygon=next;
        }
        polygon=polygon.filter((p,j)=>Math.hypot(...p.map((value,k)=>value-polygon[(j+polygon.length-1)%polygon.length][k]))>1e-8);
        if(polygon.length>6)throw new Error("Unexpected clipped surface polygon");
        cells.push(...world(x/nx,y/ny).asArray(),0,...u.scale(width/nx).asArray(),0,...v.scale(height/ny).asArray(),0,...normal,polygon.length<3?-1:0);
        clipped.push(polygon.length,0,0,0);
        for(let j=0;j<6;j++)clipped.push(...(polygon[j]?world(...polygon[j] as [number,number]).asArray():[0,0,0]),0);
      }
      for(let j=0;j<3;j++){
        const delta=points[j].subtract(a);surface.push(Vector3.Dot(delta,u)/width,Vector3.Dot(delta,v)/height,chart);
        for(const attribute of attributes)for(let k=0;k<attribute.size;k++)attribute.output.push(attribute.data[ids[j]*attribute.size+k]);
      }
    }
    mesh.makeGeometryUnique();for(const attribute of attributes)mesh.setVerticesData(attribute.kind,attribute.output,false,attribute.size);
    mesh.setIndices(Array.from({length:indices.length},(_,i)=>i));mesh.setVerticesData("probeSurface",surface,false,3);vertices+=indices.length;
    mesh.refreshBoundingInfo();
  }
  return{cells:new Float32Array(cells),charts:new Float32Array(charts),clipped:new Float32Array(clipped),boxes:[],count:cells.length/16,vertices};
}
