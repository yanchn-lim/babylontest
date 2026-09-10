import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes("/interior-lighting/") && (specifier.startsWith("./") || specifier.startsWith("../")) && !specifier.endsWith(".ts")) return next(specifier + ".ts", context);
  return next(specifier, context);
} });
const { NullEngine, Scene } = await import("@babylonjs/core");
const { FixtureLights } = await import("../src/interior-lighting/fixture-lights.ts");
const fixture = (id, kind="point") => ({ id, kind, position:[0,1,0], rotation:[0,0,0], enabled:true, lumens:300, kelvin:3000, beamDegrees:60 });
function setup(run) {
  const engine=new NullEngine(),scene=new Scene(engine),lights=new FixtureLights(scene,[]);
  try {run(scene,lights);} finally {lights.dispose();scene.dispose();engine.dispose();}
}
test("fixture toggles retain light and shadow resources; removal releases them", () => setup((scene,lights) => {
  const f=fixture("lamp");lights.sync([f]);const light=scene.getLightByName(f.id),shadow=light.getShadowGenerator();
  lights.sync([{...f,enabled:false}]);assert.equal(scene.getLightByName(f.id),light);assert.equal(light.intensity,0);assert.equal(light.getShadowGenerator(),shadow);
  lights.sync([f]);assert.equal(scene.getLightByName(f.id),light);assert.ok(light.intensity>0);assert.equal(light.getShadowGenerator(),shadow);
  lights.sync([]);assert.equal(scene.getLightByName(f.id),null);
}));
test("radiometric fixture edits preserve cached shadows; geometry edits refresh them", () => setup((scene,lights) => {
  for(const kind of ["point","spot"]){
    let f=fixture(kind,kind);lights.sync([f]);const map=scene.getLightByName(kind).getShadowGenerator().getShadowMap();let refreshes=0;
    map.resetRefreshCounter=()=>{refreshes++;};
    f={...f,lumens:600,kelvin:4000};lights.sync([f]);assert.equal(refreshes,0);
    lights.sync([{...f,enabled:false}]);lights.sync([f]);assert.equal(refreshes,0);
    f={...f,position:[1,1,0]};lights.sync([f]);assert.equal(refreshes,1);
    f={...f,beamDegrees:45};lights.sync([f]);assert.equal(refreshes,kind==="spot"?2:1);
    lights.invalidateCasters();assert.equal(refreshes,kind==="spot"?3:2);
  }
}));
test("disabled cache entries are evicted before exceeding eight fixture lights", () => setup((scene,lights) => {
  const old=Array.from({length:8},(_,i)=>fixture("old"+i));lights.sync(old);
  const disabled=old.map(f=>({...f,enabled:false}));lights.sync(disabled);
  const next=Array.from({length:8},(_,i)=>fixture("next"+i,i%2?"spot":"point"));lights.sync([...disabled,...next]);
  assert.equal(scene.lights.length,8);for(const f of old)assert.equal(scene.getLightByName(f.id),null);for(const f of next)assert.ok(scene.getLightByName(f.id));
  lights.dispose();assert.equal(scene.lights.length,0);
}));
