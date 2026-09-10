import { Vector3, type Mesh } from "@babylonjs/core";

type Point = [number,number,number];
interface Plane { normal: Vector3; distance: number; min: Vector3; max: Vector3 }

/** Partition receiver triangles where other surfaces cross them, preserving PBR attributes. */
export function partitionSurfaceMeshes(meshes:Mesh[]) {
  const planes:Plane[]=[];
  for(const mesh of meshes){
    const positions=mesh.getVerticesData('position')!,indices=mesh.getIndices()!,world=mesh.computeWorldMatrix(true);
    for(let i=0;i<indices.length;i+=3){
      const p=[0,1,2].map(k=>Vector3.TransformCoordinates(Vector3.FromArray(positions,indices[i+k]*3),world));
      const normal=Vector3.Cross(p[1].subtract(p[0]),p[2].subtract(p[0]));if(normal.lengthSquared()<1e-16)continue;normal.normalize();
      const axis=[Math.abs(normal.x),Math.abs(normal.y),Math.abs(normal.z)];if(normal.asArray()[axis.indexOf(Math.max(...axis))]<0)normal.negateInPlace();
      planes.push({normal,distance:Vector3.Dot(normal,p[0]),min:Vector3.Minimize(p[0],Vector3.Minimize(p[1],p[2])),max:Vector3.Maximize(p[0],Vector3.Maximize(p[1],p[2]))});
    }
  }
  let originalTriangles=0,partitionedTriangles=0;
  for(const mesh of meshes){
    const indices=mesh.getIndices()!,positions=mesh.getVerticesData('position')!,world=mesh.getWorldMatrix();
    const attributes=mesh.getVerticesDataKinds().map(kind=>({kind,size:mesh.getVertexBuffer(kind)!.getSize(),data:mesh.getVerticesData(kind)!,output:[] as number[]}));
    for(let i=0;i<indices.length;i+=3){
      originalTriangles++;const ids=[indices[i],indices[i+1],indices[i+2]],points=ids.map(id=>Vector3.TransformCoordinates(Vector3.FromArray(positions,id*3),world));
      const min=Vector3.Minimize(points[0],Vector3.Minimize(points[1],points[2])),max=Vector3.Maximize(points[0],Vector3.Maximize(points[1],points[2]));
      const cuts=new Map<string,number[]>();
      for(const plane of planes){
        if(min.x>plane.max.x+1e-6||max.x<plane.min.x-1e-6||min.y>plane.max.y+1e-6||max.y<plane.min.y-1e-6||min.z>plane.max.z+1e-6||max.z<plane.min.z-1e-6)continue;
        const distances=points.map(p=>Vector3.Dot(plane.normal,p)-plane.distance);
        if(Math.min(...distances)>=-1e-6||Math.max(...distances)<=1e-6)continue;
        const key=[...plane.normal.asArray(),plane.distance].map(v=>Math.round(v*1e6)).join(',');cuts.set(key,distances);
      }
      let polygons:Point[][]=[[[1,0,0],[0,1,0],[0,0,1]]];
      for(const distances of cuts.values()){
        const next:Point[][]=[];
        for(const polygon of polygons){
          const values=polygon.map(p=>p.reduce((s,v,k)=>s+v*distances[k],0));
          if(Math.min(...values)>=-1e-7||Math.max(...values)<=1e-7){next.push(polygon);continue;}
          for(const sign of [-1,1]){
            const clipped:Point[]=[];
            for(let j=0;j<polygon.length;j++){
              const a=polygon[j],b=polygon[(j+1)%polygon.length],da=values[j]*sign,db=values[(j+1)%polygon.length]*sign;
              if(da>=0)clipped.push(a);
              if((da>=0)!==(db>=0)){const t=da/(da-db);clipped.push(a.map((v,k)=>v+(b[k]-v)*t) as Point);}
            }
            if(clipped.length>=3)next.push(clipped);
          }
        }
        polygons=next;
      }
      for(const polygon of polygons)for(let j=1;j<polygon.length-1;j++){
        const bary=[polygon[0],polygon[j],polygon[j+1]];
        const determinant=(bary[1][1]-bary[0][1])*(bary[2][2]-bary[0][2])-(bary[1][2]-bary[0][2])*(bary[2][1]-bary[0][1]);
        if(Math.abs(determinant)<1e-12)continue;
        for(const weights of bary)for(const attribute of attributes)for(let k=0;k<attribute.size;k++)attribute.output.push(weights.reduce((s,w,corner)=>s+w*attribute.data[ids[corner]*attribute.size+k],0));
        partitionedTriangles++;
      }
    }
    mesh.makeGeometryUnique();for(const attribute of attributes)mesh.setVerticesData(attribute.kind,attribute.output,false,attribute.size);
    mesh.setIndices(Array.from({length:attributes.find(a=>a.kind==='position')!.output.length/3},(_,i)=>i));
    mesh.refreshBoundingInfo();
  }
  return{originalTriangles,partitionedTriangles};
}
