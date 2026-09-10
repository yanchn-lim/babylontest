import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {NullEngine,Scene,Mesh,Vector3,Ray} from '@babylonjs/core';
import {partitionSurfaceMeshes} from '../src/interior-lighting/surface-partition.ts';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/interior-lighting/') && specifier.startsWith('./') && !specifier.endsWith('.ts')) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
const { buildApartmentSurfaceLayout } = await import('../src/interior-lighting/surface-apartment.ts');
test('apartment surface partition preserves geometry and material UV interpolation',()=>{
const dir=fileURLToPath(new URL('../public/models/bukit-merah/pbr/',import.meta.url)),g=JSON.parse(fs.readFileSync(dir+'/Apartment.gltf')),buffers=g.buffers.map(b=>fs.readFileSync(path.resolve(dir,b.uri)));
function read(id){const a=g.accessors[id],v=g.bufferViews[a.bufferView],b=buffers[v.buffer],size={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type],bytes=a.componentType===5126||a.componentType===5125?4:2;return Array.from({length:a.count*size},(_,i)=>{const o=(v.byteOffset||0)+(a.byteOffset||0)+Math.floor(i/size)*(v.byteStride||size*bytes)+(i%size)*bytes;return a.componentType===5126?b.readFloatLE(o):bytes===4?b.readUInt32LE(o):b.readUInt16LE(o)})}
const engine=new NullEngine(),scene=new Scene(engine),meshes=[];for(const mesh of g.meshes)for(const p of mesh.primitives){const m=new Mesh('apartment'+meshes.length,scene);for(const [key,kind] of Object.entries({POSITION:'position',NORMAL:'normal',TEXCOORD_0:'uv',TEXCOORD_1:'uv2',TEXCOORD_2:'uv3',TANGENT:'tangent'}))if(p.attributes[key]!==undefined)m.setVerticesData(kind,read(p.attributes[key]));m.setIndices(read(p.indices));m.computeWorldMatrix(true);meshes.push(m)}
function area(){return meshes.map(m=>{const p=m.getVerticesData('position'),ix=m.getIndices();let sum=0;for(let i=0;i<ix.length;i+=3){const [a,b,c]=ix.slice(i,i+3).map(j=>Vector3.FromArray(p,j*3));sum+=Vector3.Cross(b.subtract(a),c.subtract(a)).length()/2}return sum})}
const rays=[];for(let x=.317;x<12;x+=.6)for(let z=-.281;z>-8.5;z-=.6)rays.push(new Ray(new Vector3(x,1.65,z),Vector3.Down()));
function hits(){return meshes.flatMap(m=>rays.map(ray=>{const pick=m.intersects(ray);return pick.hit?{distance:pick.distance,uv:['uv','uv2','uv3'].flatMap(kind=>pick.getTextureCoordinates(kind)?.asArray()??[])}:null}))}
const references=meshes.map(m=>({positions:m.getVerticesData('position'),indices:m.getIndices(),uvs:['uv','uv2','uv3'].map(kind=>m.getVerticesData(kind)).filter(Boolean)}));
const beforeArea=area(),beforeHits=hits();const begin=performance.now(),stats=partitionSurfaceMeshes(meshes),elapsed=performance.now()-begin,afterArea=area(),afterHits=hits();let maxDistance=0,maxUV=0,coincidentSamples=0;
for(let i=0;i<beforeHits.length;i++){
  assert.equal(!!beforeHits[i],!!afterHits[i]);if(!beforeHits[i])continue;
  const actual=afterHits[i],reference=references[Math.floor(i/rays.length)],ray=rays[i%rays.length];
  maxDistance=Math.max(maxDistance,Math.abs(beforeHits[i].distance-actual.distance));
  let best=Infinity,matches=0;
  // Overlapping original faces may have different baked atlas islands at the same depth.
  for(let face=0;face<reference.indices.length;face+=3){
    const ids=reference.indices.slice(face,face+3),points=ids.map(id=>Vector3.FromArray(reference.positions,id*3));
    const hit=ray.intersectsTriangle(...points);if(!hit||Math.abs(hit.distance-actual.distance)>1e-5)continue;
    const weights=[hit.bu,hit.bv,1-hit.bu-hit.bv],expected=reference.uvs.flatMap(uv=>[0,1].map(k=>ids.reduce((sum,id,j)=>sum+uv[id*2+k]*weights[j],0)));
    assert.equal(expected.length,actual.uv.length);best=Math.min(best,Math.max(0,...expected.map((v,k)=>Math.abs(v-actual.uv[k]))));matches++;
  }
  if(matches>1)coincidentSamples++;maxUV=Math.max(maxUV,best);
}
const maxAreaError=Math.max(...beforeArea.map((a,i)=>Math.abs(a-afterArea[i])));console.log({stats,elapsed,rays:rays.length,maxDistance,maxUV,maxAreaError,coincidentSamples});assert.ok(maxDistance<1e-5);assert.ok(maxUV<1e-4);assert.ok(maxAreaError<1e-3);
for (const mesh of meshes) {
  mesh.scaling.x = -1;
  mesh.freezeWorldMatrix();
}
const bounds = () => meshes.map(mesh =>
  mesh.getBoundingInfo().boundingBox.vectorsWorld.map(v => v.asArray())
);
const expectedBounds = bounds();
partitionSurfaceMeshes(meshes);
assert.deepEqual(bounds(), expectedBounds);
buildApartmentSurfaceLayout(meshes);
assert.deepEqual(bounds(), expectedBounds);
assert.ok(meshes.every(mesh => mesh.isWorldMatrixFrozen));
scene.dispose();engine.dispose();
});