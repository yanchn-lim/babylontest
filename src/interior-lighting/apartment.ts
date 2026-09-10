import { BaseTexture, Mesh, PBRMaterial, SceneLoader, Vector3, VertexBuffer, type Scene } from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import type { Triangle } from "./bvh";
import type { Vec3 } from "./controller";
import { srgbToLinear } from "./lighting-model";
export async function loadApartment(scene:Scene){
  const url = new URL(import.meta.env.BASE_URL + "models/bukit-merah/pbr/Apartment.gltf", document.baseURI);
  const response = await fetch(url);
  if (!response.ok) throw new Error("Could not load apartment model");
  const model = await response.json();
  for (const asset of [...(model.images ?? []), ...(model.buffers ?? [])]) {
    if (asset.uri) asset.uri = new URL(asset.uri, url).href;
  }
  const asset = await SceneLoader.ImportMeshAsync("", "", "data:" + JSON.stringify(model), scene, undefined, ".gltf");
  const meshes=asset.meshes.filter((m):m is Mesh=>m instanceof Mesh&&m.getTotalVertices()>0&&m.material instanceof PBRMaterial);
  const materials=[...new Set(meshes.map(m=>m.material as PBRMaterial))];
  const triangles:Triangle[]=[];
  const minimum=new Vector3(Infinity,Infinity,Infinity),maximum=new Vector3(-Infinity,-Infinity,-Infinity);
  for(const mesh of meshes){
    mesh.computeWorldMatrix(true);mesh.receiveShadows=true;
    const material=mesh.material as PBRMaterial;material.maxSimultaneousLights=9;
    // This preview never combines the bake with scene probes.
    material.lightmapTexture=null;
    const positions=mesh.getVerticesData(VertexBuffer.PositionKind)!,uvs=mesh.getVerticesData(VertexBuffer.UVKind),indices=mesh.getIndices()!;
    const world=mesh.getWorldMatrix(),textureMatrix=material.albedoTexture?.getTextureMatrix();
    const points:Vec3[]=[],coordinates:[number,number][]=[];
    for(let i=0;i<positions.length;i+=3){
      const p=Vector3.TransformCoordinates(Vector3.FromArray(positions,i),world);minimum.minimizeInPlace(p);maximum.maximizeInPlace(p);points.push(p.asArray() as Vec3);
      const uv=new Vector3(uvs?.[i/3*2]??0,uvs?.[i/3*2+1]??0,1);
      if(textureMatrix)Vector3.TransformCoordinatesToRef(uv,textureMatrix,uv);
      coordinates.push([uv.x,uv.y]);
    }
    for(let i=0;i<indices.length;i+=3){const [a,b,c]=[indices[i],indices[i+1],indices[i+2]];triangles.push({a:points[a],b:points[b],c:points[c],material:materials.indexOf(material),uv:[...coordinates[a],...coordinates[b],...coordinates[c]]});}
  }
  let spacing=.75,dimensions:Vec3=[1,1,1];
  do{dimensions=[Math.ceil((maximum.x-minimum.x)/spacing),Math.floor(2.8/spacing+.5),Math.ceil((maximum.z-minimum.z)/spacing)];if(dimensions.reduce((a,b)=>a*b,1)<=512)break;spacing+=.05;}while(spacing<2);
  const origin:Vec3=[minimum.x+spacing/2,spacing/2,minimum.z+spacing/2];
  return{meshes,materials,triangles,grid:{origin,dimensions,spacing}};
}
/** Compact linear-color atlas used by ray hits. Native PBR retains full-resolution maps. */
export async function albedoLayers(materials:PBRMaterial[]){
  const size=128,data=new Uint8Array(materials.length*size*size*4);data.fill(255);
  const cache=new Map<BaseTexture,Uint8Array>();
  await new Promise<void>(resolve=>BaseTexture.WhenAllReady(materials.flatMap(m=>m.albedoTexture?[m.albedoTexture]:[]),resolve));
  for(let layer=0;layer<materials.length;layer++){
    const texture=materials[layer].albedoTexture;if(!texture)continue;
    let small=cache.get(texture);
    if(!small){
      const pixels=await texture.readPixels();
      if(!(pixels instanceof Uint8Array))throw new Error(`Unsupported GI color texture: ${texture.name}`);
      const {width,height}=texture.getSize(),sum=new Float32Array(size*size*3),count=new Uint32Array(size*size);
      const decode=Array.from({length:256},(_,v)=>texture.gammaSpace?srgbToLinear(v/255):v/255);
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const target=Math.min(size-1,Math.floor(y*size/height))*size+Math.min(size-1,Math.floor(x*size/width));const source=(y*width+x)*4;
        for(let channel=0;channel<3;channel++)sum[target*3+channel]+=decode[pixels[source+channel]];count[target]++;
      }
      small=new Uint8Array(size*size*4);
      for(let i=0;i<size*size;i++){for(let c=0;c<3;c++)small[i*4+c]=Math.round(sum[i*3+c]/Math.max(1,count[i])*255);small[i*4+3]=255;}
      cache.set(texture,small);
    }
    data.set(small,layer*size*size*4);
  }
  return data;
}
