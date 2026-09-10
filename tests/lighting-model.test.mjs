import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { NullEngine, Scene, MeshBuilder, PointLight, ShadowGenerator } from "@babylonjs/core";
registerHooks({resolve(specifier,context,next){if(context.parentURL?.includes('/interior-lighting/')&&(specifier.startsWith('./')||specifier.startsWith('../'))&&!specifier.endsWith('.ts'))return next(specifier+'.ts',context);return next(specifier,context);}});
const { skyRadiance, temperature, fixtureDirection }=await import('../src/interior-lighting/lighting-model.ts');
const { FixtureLights }=await import('../src/interior-lighting/fixture-lights.ts');
test('analytic sky is dark at night and changes angular distribution with the sun',()=>{
  assert.deepEqual(skyRadiance([0,1,0],[0,-1,0]),[0,0,0]);
  const a=skyRadiance([1,0,0],[1,0,0]),b=skyRadiance([1,0,0],[-1,0,0]);
  assert.ok(a[0]>b[0]);
  assert.ok(skyRadiance([0,1,0],[0,1,0]).every(Number.isFinite));
});
test('color temperature preserves photopic luminance and rotation produces unit directions',()=>{
  for(const k of [2000,2700,4000,6500,10000]){const c=temperature(k);assert.ok(Math.abs(c[0]*.2126+c[1]*.7152+c[2]*.0722-1)<1e-10);}
  for(const pitch of [0,45,90,180]){const d=fixtureDirection([pitch,30,0]);assert.ok(Math.abs(Math.hypot(...d)-1)<1e-10);}
  assert.deepEqual(fixtureDirection([0,0,0]),[0,-1,0]);
});
test('point fixtures retain native cube shadows while disabled and release them on removal',()=>{
  const engine=new NullEngine();const scene=new Scene(engine);const box=MeshBuilder.CreateBox('wall',{},scene);const fixtures=new FixtureLights(scene,[box]);
  const lamp={id:'lamp',kind:'point',position:[1,1,1],rotation:[0,0,0],enabled:true,lumens:500,kelvin:2700,beamDegrees:60};
  fixtures.sync([lamp]);const light=scene.lights[0];assert.ok(light instanceof PointLight);
  const shadow=light.getShadowGenerator();assert.ok(light.needCube());assert.equal(shadow.filter,ShadowGenerator.FILTER_POISSONSAMPLING);assert.equal(shadow.getShadowMap().refreshRate,0);
  fixtures.sync([{...lamp,lumens:1000}]);assert.equal(scene.lights[0],light);assert.ok(light.intensity>0);
  fixtures.sync([{...lamp,enabled:false}]);assert.equal(scene.lights.length,1);assert.equal(scene.lights[0],light);assert.equal(light.intensity,0);assert.equal(light.getShadowGenerator(),shadow);
  fixtures.sync([lamp]);assert.equal(scene.lights.length,1);fixtures.sync([]);assert.equal(scene.lights.length,0);
  fixtures.dispose();scene.dispose();engine.dispose();
});
