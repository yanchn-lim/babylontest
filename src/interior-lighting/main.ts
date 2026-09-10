import {
  Color3, Color4, DefaultRenderingPipeline, DirectionalLight, Engine, EngineInstrumentation,
  MeshBuilder, PBRMaterial, Scene, SceneInstrumentation, ShadowGenerator, UniversalCamera,
  Vector3, WebGPUEngine, type AbstractEngine,
} from "@babylonjs/core";
import { LightingController, type Vec3 } from "./controller";
import { solarPosition } from "./solar";
import { boxTriangles, type Triangle } from "./bvh";
import { srgbToLinear, temperature } from "./lighting-model";
import { DaylightSky } from "./daylight-sky";
import { FixtureLights } from "./fixture-lights";
import { ProbeGI } from "./probe-gi";
import { BaselineProbeGI } from "./probe-baseline";
import { loadApartment, albedoLayers } from "./apartment";
import { buildSurfaceLayout, type SurfaceBox } from "./surface-layout";
import { buildApartmentSurfaceLayout } from "./surface-apartment";

const el=(id:string)=>document.getElementById(id)!;
const input=(id:string)=>el(id) as HTMLInputElement;
const number=(id:string)=>Number(input(id).value);
const canvas=el("scene") as HTMLCanvasElement;
const controller=new LightingController();
const apartment=new URLSearchParams(location.search).get("scene")==="apartment";
const probeMode=new URLSearchParams(location.search).get("probe");
const surfaceMode=probeMode==="surface";
const abort=new AbortController();
let uiError="";
let engine:AbstractEngine|undefined,scene:Scene|undefined,disposed=false;
let instrumentation:EngineInstrumentation|undefined,cpu:SceneInstrumentation|undefined;
let gi:ProbeGI|BaselineProbeGI|undefined,sky:DaylightSky|undefined,fixtures:FixtureLights|undefined;
function dispose(){
  if(disposed)return;disposed=true;abort.abort();
  gi?.dispose();fixtures?.dispose();sky?.dispose();cpu?.dispose();instrumentation?.dispose();scene?.dispose();engine?.dispose();
}
function fail(error:unknown){const message=String(error);console.error(error);el("status").textContent=message;canvas.dataset.error=message;dispose();}
window.addEventListener("pagehide",dispose,{once:true});
window.addEventListener("pageshow",e=>{if(e.persisted)location.reload();});
window.addEventListener("unhandledrejection",e=>fail(e.reason),{signal:abort.signal});
function listen(id:string,handler:()=>void,event="input"){
  el(id).addEventListener(event,()=>{try{handler();uiError="";}catch(e){uiError=String(e);}},{signal:abort.signal});
}
async function main(){
  let fallback="";
  if(new URLSearchParams(location.search).get("backend")!=="webgl" && await WebGPUEngine.IsSupportedAsync){
    const gpu=new WebGPUEngine(canvas,{antialias:false,enableAllFeatures:true});
    try{await gpu.initAsync();engine=gpu;gpu.enableGPUTimingMeasurements=true;}catch(e){gpu.dispose();fallback=`WebGPU initialization failed: ${String(e)}`;}
  }
  if(!engine){engine=new Engine(canvas,false,{stencil:true},false);fallback||="Scene probe GI requires WebGPU. Direct lighting and shadows remain available.";}
  if(disposed){engine.dispose();return;}
  const activeEngine=engine;
  scene=new Scene(engine);const activeScene=scene;
  scene.useRightHandedSystem=true;scene.clearColor=new Color4(0,0,0,1);
  scene.imageProcessingConfiguration.exposure=1;scene.imageProcessingConfiguration.toneMappingEnabled=true;
  const camera=new UniversalCamera("preview",new Vector3(2,1.65,3.5),scene);
  camera.setTarget(new Vector3(1.3,1.2,1));camera.minZ=.05;camera.maxZ=50;camera.speed=.4;camera.inertia=0;
  camera.keysUp=[87,38];camera.keysDown=[83,40];camera.keysLeft=[65,37];camera.keysRight=[68,39];camera.keysUpward=[32];camera.keysDownward=[16];camera.attachControl(canvas,true);
  const materials:PBRMaterial[]=[];
  function material(name:string,color:Vec3,roughness:number){const m=new PBRMaterial(name,activeScene);m.albedoColor=new Color3(...color);m.roughness=roughness;m.metallic=0;m.maxSimultaneousLights=9;materials.push(m);return m;}
  const surfaceBoxes:SurfaceBox[]=[];
  let colored:PBRMaterial;
  let grid={origin:[.375,.375,.375] as Vec3,dimensions:[11,4,5] as Vec3,spacing:.75};
  const meshes:ReturnType<typeof MeshBuilder.CreateBox>[]=[],triangles:Triangle[]=[];
  if(apartment){
    el("status").textContent="Loading apartment geometry and PBR materials…";
    const loaded=await loadApartment(scene);if(disposed)return;meshes.push(...loaded.meshes);triangles.push(...loaded.triangles);materials.push(...loaded.materials);grid=loaded.grid;
    colored=materials.find(m=>m.name.includes("Paint"))??materials[0];
    camera.position.set(10.5,1.65,-5.8);camera.setTarget(new Vector3(10.5,1.65,-8.4));
  }else{
  const white=material("white",[.72,.72,.72],.8),floor=material("floor",[.28,.2,.12],.65);colored=material("colored wall",[.43,.076,.053],.8);
  function box(name:string,p:Vec3,size:Vec3,m=white){
    const mesh=MeshBuilder.CreateBox(name,{width:size[0],height:size[1],depth:size[2]},activeScene);mesh.position.set(...p);mesh.material=m;mesh.receiveShadows=true;meshes.push(mesh);
    surfaceBoxes.push({mesh,material:materials.indexOf(m),min:p.map((v,i)=>v-size[i]/2) as Vec3,max:p.map((v,i)=>v+size[i]/2) as Vec3});
    triangles.push(...boxTriangles(p.map((v,i)=>v-size[i]/2) as Vec3,p.map((v,i)=>v+size[i]/2) as Vec3,materials.indexOf(m)));
  }
  box("floor",[4,-.1,2],[8.4,.2,4.4],floor);box("ceiling",[4,3.1,2],[8.4,.2,4.4]);
  box("west",[-.1,1.5,2],[.2,3,4.4],colored);box("east",[8.1,1.5,2],[.2,3,4.4]);
  box("closed dividing wall",[4,1.5,2],[.2,3,4.4]);box("south",[4,1.5,4.1],[8.4,3,.2]);
  box("second room north",[6.1,1.5,-.1],[4,3,.2]);box("window left",[.4,1.5,-.1],[.8,3,.2]);
  box("window right",[3.6,1.5,-.1],[.8,3,.2]);box("window sill",[2,.4,-.1],[2.4,.8,.2]);box("window lintel",[2,2.8,-.1],[2.4,.4,.2]);
  }
  const surfaceLayout=surfaceMode&&engine instanceof WebGPUEngine?(apartment?buildApartmentSurfaceLayout(meshes):buildSurfaceLayout(surfaceBoxes,grid)):undefined;
  input("wall-color").value=colored.albedoColor.toGammaSpace().toHexString();input("roughness").value=String(colored.roughness??.8);
  input("scene-select").value=apartment?"apartment":"rooms";
  const filtered=probeMode==="filtered"||probeMode==="surface";
  el("variant").textContent=surfaceMode?"Surface visibility cache · not accepted: coverage, weights and GPU limits.":filtered?"Exact visibility candidate · not accepted: coverage and frame cost.":"Previous probe baseline · known interpolation patches.";
  const comparison=new URL(location.href);comparison.searchParams.set("probe",filtered?"baseline":"filtered");
  (el("compare-probes") as HTMLAnchorElement).href=comparison.href;el("compare-probes").textContent=filtered?"Return to previous probes":"Inspect filtered candidate";
  listen("scene-select",()=>{const url=new URL(location.href);url.searchParams.set("scene",input("scene-select").value);location.assign(url.href);},"change");
  const sun=new DirectionalLight("sun",new Vector3(0,-1,0),scene);sun.shadowMinZ=.1;sun.shadowMaxZ=60;
  const sunShadow=new ShadowGenerator(2048,sun);sunShadow.usePercentageCloserFiltering=true;sunShadow.bias=.0005;sunShadow.normalBias=.015;sunShadow.transparencyShadow=true;
  for(const mesh of meshes)sunShadow.addShadowCaster(mesh);sunShadow.getShadowMap()!.refreshRate=0;
  fixtures=new FixtureLights(scene,meshes);sky=new DaylightSky(scene);
  controller.addFixture({id:"Downlight 1",kind:"spot",position:apartment?[10.5,2.65,-6.5]:[2,2.85,2],rotation:[0,0,0],enabled:true,lumens:800,kelvin:3000,beamDegrees:60});
  controller.addFixture({id:"Lamp 1",kind:"point",position:apartment?[10,1.2,-6]:[1,1.2,1.3],rotation:[0,0,0],enabled:true,lumens:500,kelvin:2700,beamDegrees:60});
  const pipeline=new DefaultRenderingPipeline("interior-hdr",true,scene,[camera]);pipeline.imageProcessingEnabled=true;
  instrumentation=new EngineInstrumentation(engine);instrumentation.captureGPUFrameTime=true;
  cpu=new SceneInstrumentation(scene);cpu.captureFrameTime=true;
  if(engine instanceof WebGPUEngine){
    el("status").textContent="Preparing scene probe colors…";
    try{const colors=await albedoLayers(materials);if(disposed)return;gi=filtered?new ProbeGI(scene,engine,triangles,materials,grid,colors,surfaceLayout):new BaselineProbeGI(scene,engine,triangles,materials,grid,colors);}catch(error){fallback=`GI unavailable: ${String(error)}`;}
  }
  if(!gi){input("gi-mode").value="off";input("gi-mode").disabled=true;el("support").textContent=fallback;}
  el("probe-description").textContent=`${gi?.count??0} probes · ${grid.spacing.toFixed(2)} m spacing · 64 rays per update · one bounce`;
  if(apartment&&gi){controller.setQuality({updates:64});input("quality").value="64";}
  if(apartment){input("fixture-x").max="12.2";input("fixture-z").min="-8.8";input("fixture-z").max="-.2";el("room-2").hidden=true;el("room-1").textContent="Reset view";}
  window.addEventListener("resize",()=>activeEngine.resize(),{signal:abort.signal});
  function updateDay(){
    const minutes=Math.round(number("time")*60),time=`${String(Math.floor(minutes/60)).padStart(2,"0")}:${String(minutes%60).padStart(2,"0")}`;
    el("time-value").textContent=time;
    controller.setDaylight({...controller.daylight,northDegrees:-90,instant:`2026-03-20T${time}:00+08:00`});
  }
  listen("time",updateDay);listen("exposure",()=>controller.setExposure(number("exposure")));
  const select=el("fixture") as HTMLSelectElement;
  function showFixture(){
    const f=controller.fixtures.find(f=>f.id===select.value);
    for(const id of ["enabled","lumens","kelvin","beam","fixture-x","fixture-y","fixture-z","pitch","yaw","remove-fixture"]) (el(id) as HTMLInputElement).disabled=!f;
    if(!f)return;
    input("enabled").value=f.enabled?"on":"off";input("lumens").value=String(f.lumens);input("kelvin").value=String(f.kelvin);input("beam").value=String(f.beamDegrees);input("beam").disabled=f.kind!=="spot";
    ["x","y","z"].forEach((axis,i)=>input(`fixture-${axis}`).value=String(f.position[i]));
    input("pitch").value=String(f.rotation[0]);input("yaw").value=String(f.rotation[1]);input("pitch").disabled=input("yaw").disabled=f.kind!=="spot";
  }
  function listFixtures(id=select.value){select.replaceChildren(...controller.fixtures.map(f=>new Option(f.id,f.id)));select.value=controller.fixtures.some(f=>f.id===id)?id:controller.fixtures[0]?.id??"";showFixture();}
  listen("fixture",showFixture,"change");
  function updateFixture(){controller.updateFixture(select.value,{enabled:input("enabled").value==="on",lumens:number("lumens"),kelvin:number("kelvin"),beamDegrees:number("beam"),position:[number("fixture-x"),number("fixture-y"),number("fixture-z")],rotation:[number("pitch"),number("yaw"),0]});}
  for(const id of ["enabled","lumens","kelvin","beam","fixture-x","fixture-y","fixture-z","pitch","yaw"])listen(id,updateFixture);
  let serial=2;
  for(const kind of ["point","spot"] as const)listen(`add-${kind}`,()=>{const id=`${kind==="point"?"Lamp":"Downlight"} ${serial++}`;controller.addFixture({id,kind,position:[apartment?10.5:2,kind==="point"?1.2:2.65,apartment?-6.5:2],rotation:[0,0,0],enabled:true,lumens:500,kelvin:3000,beamDegrees:60});listFixtures(id);},"click");
  listen("remove-fixture",()=>{controller.removeFixture(select.value);listFixtures();},"click");
  for(const id of ["wall-color","roughness"])listen(id,()=>{const color=input("wall-color").value;colored.albedoColor=new Color3(...[1,3,5].map(i=>srgbToLinear(parseInt(color.slice(i,i+2),16)/255)) as Vec3);colored.roughness=number("roughness");controller.notifyMaterialChange("west",{min:[-.2,0,-.2],max:[0,3,4.2]});});
  listen("reset-gi",()=>controller.reset(),"click");
  listen("gi-mode",()=>{if(gi){gi.enabled=input("gi-mode").value==="probes";if(gi.enabled)gi.reset();}},"change");
  listen("quality",()=>controller.setQuality({updates:number("quality")}),"change");
  for(const room of [1,2])listen(`room-${room}`,()=>{camera.position.set(apartment?10.5:room===1?2:6,1.65,apartment?-5.8:3.5);camera.setTarget(new Vector3(apartment?10.5:room===1?1.3:5.3,apartment?1.65:1.2,apartment?-8.4:1));},"click");
  listFixtures();updateDay();
  const samples:{frame:number;cpu:number;gpu:number|null;gi:number|null}[]=[];let measuring=false,warmup=0,previous=performance.now();
  listen("benchmark",()=>{samples.length=0;warmup=60;measuring=true;el("metrics").textContent="Measuring 300 frames after warmup…";},"click");
  const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.floor((values.length-1)*p)]??0;
  let lastMaterial=0,lastLighting=0,lastSun="";
  scene.onBeforeRenderObservable.add(()=>{
    const now=performance.now(),frame=now-previous;previous=now;
    const changes=controller.consumeChanges();
    if(changes){
      if(gi)gi.updates=controller.quality.updates;
      const solar=solarPosition(controller.daylight),intensity=solar.elevation>0?4*Math.max(0,solar.toSun[1])**.35:0,color=temperature(3500+2500*Math.max(0,solar.toSun[1]));
      sun.direction.set(...solar.toSun.map(v=>-v) as Vec3);sun.position.set(...solar.toSun.map(v=>v*25) as Vec3);sun.intensity=intensity;sun.diffuse=new Color3(...color);sun.specular=sun.diffuse;
      fixtures!.sync(controller.fixtures);
      if(changes.material!==lastMaterial){gi?.setMaterials(materials);lastMaterial=changes.material;}
      if(changes.lighting!==lastLighting){gi?.setLights(solar.toSun,intensity,color,controller.fixtures);lastLighting=changes.lighting;}
      const sunState=JSON.stringify(controller.daylight);
      if(sunState!==lastSun){sky!.setSun(solar.toSun);sunShadow.getShadowMap()!.resetRefreshCounter();lastSun=sunState;}
    }
    const view=input("view").value;
    for(const m of materials){m.directIntensity=view==="indirect"?0:1;m.environmentIntensity=view==="combined"?1:0;m.specularIntensity=view==="indirect"?0:1;}
    if(gi){gi.enabled=input("gi-mode").value==="probes"&&view!=="direct";gi.tick();controller.status={phase:gi.phase,preparationProgress:gi.preparationProgress,inactiveProbes:gi.inactiveProbes,converged:gi.progress>=1,progress:gi.progress,gpuMs:gi.gpuMs,error:gi.error};}
    sky!.setVisible(view!=="indirect");sky!.tick();activeScene.imageProcessingConfiguration.exposure=controller.exposure;
    const error=uiError||gi?.error||sky?.error;
    el("status").textContent=error?`Lighting error: ${error}`:gi?.enabled?gi.preparationProgress<1?`Preparing lighting · ${Math.round(gi.preparationProgress*100)}%`:gi.progress<1?`Lighting updating · ${Math.round(gi.progress*100)}%`:`Lighting settled · ${(gi.elapsedMs/1000).toFixed(2)} s · GI ${gi.gpuMs?.toFixed(2)??"unavailable"} ms`:`Direct lighting · ${activeEngine.isWebGPU?"WebGPU":"WebGL"}`;
    if(measuring&&warmup--<=0){
      const gpuNs=instrumentation!.gpuFrameTimeCounter.current;
      samples.push({frame,cpu:cpu!.frameTimeCounter.current,gpu:gpuNs>0?gpuNs/1e6:null,gi:gi?.gpuMs??null});
      if(samples.length===300){measuring=false;el("metrics").textContent=`Frame p50 ${percentile(samples.map(s=>s.frame),.5).toFixed(2)} / p95 ${percentile(samples.map(s=>s.frame),.95).toFixed(2)} ms · CPU p95 ${percentile(samples.map(s=>s.cpu),.95).toFixed(2)} ms · GPU p50 ${percentile(samples.flatMap(s=>s.gpu===null?[]:[s.gpu]),.5).toFixed(2)} ms. GI is idle after convergence.`;}
    }
  });
  // Development harness and renderer-facing controller, not a production editor API.
  Object.assign(window,{lighting:{controller,camera,scene,gi,fixtures,sky,samples,dispose}});
  await scene.whenReadyAsync();if(disposed)return;
  engine.runRenderLoop(()=>activeScene.render());canvas.dataset.ready="true";
}
void main().catch(fail);



