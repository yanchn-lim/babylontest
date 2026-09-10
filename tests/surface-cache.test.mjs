import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NullEngine, Scene, MeshBuilder, Vector3, Ray } from '@babylonjs/core';
import { buildSurfaceLayout } from '../src/interior-lighting/surface-layout.ts';

test('surface charts split at solid and probe-grid boundaries without moving box surfaces',()=>{
  const engine=new NullEngine(),scene=new Scene(engine);scene.useRightHandedSystem=true;
  const mesh=MeshBuilder.CreateBox('floor',{width:2,height:.2,depth:2},scene);mesh.position.set(1,-.1,1);mesh.computeWorldMatrix(true);
  const divider=MeshBuilder.CreateBox('wall',{width:.2,height:2,depth:2},scene);divider.position.set(1,1,1);divider.computeWorldMatrix(true);
  const rays=Array.from({length:20},(_,i)=>new Ray(new Vector3(.05+i*.095,1,.5),new Vector3(0,-1,0)));
  const before=rays.map(r=>mesh.intersects(r).distance);
  const layout=buildSurfaceLayout([{mesh,min:[0,-.2,0],max:[2,0,2],material:0},{mesh:divider,min:[.9,0,0],max:[1.1,2,2],material:0}],{origin:[.375,.375,.375],dimensions:[3,3,3],spacing:.75});
  assert.equal(layout.cells.length,layout.count*16);
  assert.ok(layout.count>0&&layout.charts.length>0);
  for(let i=0;i<layout.cells.length;i+=16){
    const p=layout.cells.slice(i,i+3),u=layout.cells.slice(i+4,i+7),v=layout.cells.slice(i+8,i+11);
    assert.ok(Math.hypot(...u)<=.100001&&Math.hypot(...v)<=.100001);
    for(const boundary of [.375,.9,1.1,1.125])assert.ok(!(p[0]<boundary-1e-6&&p[0]+u[0]+v[0]>boundary+1e-6));
  }
  const after=rays.map(r=>mesh.intersects(r).distance);
  for(let i=0;i<before.length;i++)assert.ok(Math.abs(before[i]-after[i])<1e-6);
  for(const m of [mesh,divider])assert.equal(m.getVerticesData('probeSurface').length,m.getTotalVertices()*3);
  scene.dispose();engine.dispose();
});
