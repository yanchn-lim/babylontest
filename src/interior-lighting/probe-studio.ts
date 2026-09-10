import { arrangeFixtureSettings } from "../settings-layout";
import { Engine, Mesh, PBRMaterial, Ray, Vector3, WebGPUEngine, type Scene, type Camera, type DirectionalLight, type FrameGraphObjectRendererTask } from "@babylonjs/core";
import { ProbeGI } from "./probe-gi";
import { albedoLayers } from "./apartment";
import { buildApartmentSurfaceLayout } from "./surface-apartment";
import { FixtureLights } from "./fixture-lights";
import { LightingController, type Vec3 } from "./controller";
import type { Triangle } from "./bvh";

export function attachProbeLighting(scene:Scene,engine:Engine|WebGPUEngine,sun:DirectionalLight,meshes:Mesh[],camera:Camera,setBaked:(baked:boolean)=>void,renderTask?:FrameGraphObjectRendererTask){
  const mode=document.querySelector<HTMLSelectElement>("#gi-mode")!;
  const message=document.querySelector<HTMLElement>("#gi-status")!;
  const materials=[...new Set(meshes.map(m=>m.material))].filter((m):m is PBRMaterial=>m instanceof PBRMaterial);
  const controller=new LightingController(),fixtures=new FixtureLights(scene,meshes,renderTask),abort=new AbortController();
  let gi:ProbeGI|undefined,pending:Promise<void>|undefined,disposed=false,error="",lastLighting="",lastMaterials="";
  const panel=document.createElement("details");panel.className="settings-group";panel.open=true;
  panel.innerHTML=`<summary>Interior lights &amp; probe GI</summary><div class="group-body">
<p class="help">New surface-cache GI · experimental: coverage gaps remain. Baked lighting is the reference.</p>
<label>Fixture<select id="fixture"></select></label><div class="preset-actions"><button id="add-spot" type="button">Add downlight</button><button id="add-point" type="button">Add lamp</button><button id="remove-fixture" type="button">Remove selected</button></div>
<label>State<select id="fixture-enabled"><option value="on">On</option><option value="off">Off</option></select></label>
${[["lumens","Output (lm, uncalibrated)",0,2000,10],["kelvin","Color temperature (K)",2000,10000,100],["beamDegrees","Beam angle",15,120,1],["x","Position X (m)",-15,15,.05],["y","Position Y (m)",.1,3,.05],["z","Position Z (m)",-15,15,.05],["pitch","Tilt from downward",0,180,1],["yaw","Rotation",-180,180,1]].map(([id,label,min,max,step])=>`<label>${label}<input id="fixture-${id}" type="number" min="${min}" max="${max}" step="${step}"></label>`).join("")}
<label>Wall color<input id="probe-wall-color" type="color" value="#ffffff"></label>
<label title="1× preserves calculated energy. Applies only to real-time GI.">Indirect light strength <output id="probe-strength-value">1.00×</output>
<input id="probe-strength" type="range" min="0" max="2" step="0.05" value="1"></label>
<label>Inspect lighting<select id="probe-view"><option value="combined">Combined</option><option value="indirect">Indirect only</option></select></label>
<label>GI refinement<select id="probe-quality"><option value="64">Balanced · faster refinement</option><option value="32">Lower GPU load · slower refinement</option></select></label><button id="probe-reset" type="button">Reset accumulated lighting</button></div>`;
  arrangeFixtureSettings(panel);
  const control=(id:string)=>document.getElementById(id) as HTMLInputElement;
  const listen=(id:string,fn:()=>void,event="input")=>control(id).addEventListener(event,()=>{try{fn();error="";}catch(e){error=String(e)}},{signal:abort.signal});
  let serial=0;
  function show(){const f=controller.fixtures.find(f=>f.id===control("fixture").value);panel.dataset.empty=String(!f);(control("remove-fixture") as unknown as HTMLButtonElement).disabled=!f;for(const e of Array.from(panel.querySelectorAll<HTMLInputElement|HTMLSelectElement>('[id^="fixture-"]')))e.disabled=!f;if(!f)return;control("fixture-enabled").value=f.enabled?"on":"off";for(const key of ["lumens","kelvin","beamDegrees"] as const)control("fixture-"+key).value=String(f[key]);["x","y","z"].forEach((k,i)=>control("fixture-"+k).value=String(f.position[i]));control("fixture-pitch").value=String(f.rotation[0]);control("fixture-yaw").value=String(f.rotation[1]);control("fixture-beamDegrees").disabled=f.kind!=="spot";control("fixture-pitch").disabled=control("fixture-yaw").disabled=f.kind!=="spot";}
  function list(id=control("fixture").value){const select=control("fixture") as unknown as HTMLSelectElement;select.replaceChildren(...controller.fixtures.map(f=>new Option(f.id,f.id)));select.value=controller.fixtures.some(f=>f.id===id)?id:controller.fixtures[0]?.id??"";show();}
  for(const kind of ["spot","point"] as const)listen("add-"+kind,()=>{const id=(kind==="spot"?"Downlight ":"Lamp ")+(++serial);const p=camera.position;let y=1.2;if(kind==="spot"){
    const hit=scene.pickWithRay(new Ray(p.clone(),Vector3.Up(),10),mesh=>meshes.includes(mesh as Mesh)&&!!mesh.material&&!mesh.material.needAlphaBlending());
    if(!hit?.pickedPoint||(hit.getNormal(true)?.y??0)>-.5)throw new Error("Move below a ceiling before adding a downlight.");
    y=hit.pickedPoint.y-.05;
  }controller.addFixture({id,kind,position:[p.x,y,p.z],rotation:[0,0,0],enabled:true,lumens:500,kelvin:3000,beamDegrees:60});list(id);},"click");
  listen("remove-fixture",()=>{controller.removeFixture(control("fixture").value);list()},"click");listen("fixture",show,"change");
  for(const key of ["enabled","lumens","kelvin","beamDegrees","x","y","z","pitch","yaw"])listen("fixture-"+key,()=>{controller.updateFixture(control("fixture").value,{enabled:control("fixture-enabled").value==="on",lumens:+control("fixture-lumens").value,kelvin:+control("fixture-kelvin").value,beamDegrees:+control("fixture-beamDegrees").value,position:[+control("fixture-x").value,+control("fixture-y").value,+control("fixture-z").value],rotation:[+control("fixture-pitch").value,+control("fixture-yaw").value,0]})});
  const wall=materials.find(m=>m.name.includes("Paint"))??materials[0];control("probe-wall-color").value=wall.albedoColor.toGammaSpace().toHexString();listen("probe-wall-color",()=>{wall.albedoColor.copyFromFloats(...[1,3,5].map(i=>{const c=parseInt(control("probe-wall-color").value.slice(i,i+2),16)/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4}) as Vec3)});
  listen("probe-strength",()=>{const value=+control("probe-strength").value;document.getElementById("probe-strength-value")!.textContent=value.toFixed(2)+"×";if(gi)gi.strength=value;});
  listen("probe-reset",()=>gi?.reset(),"click");listen("probe-quality",()=>{if(gi)gi.updates=+control("probe-quality").value});list();
  async function prepare(){
    if(!(engine instanceof WebGPUEngine))throw new Error("New probe GI requires WebGPU; baked lighting remains available.");
    message.textContent="Preparing apartment probe textures…";
    const colors=await albedoLayers(materials);if(disposed)return;
    const triangles:Triangle[]=[],minimum=new Vector3(Infinity,Infinity,Infinity),maximum=new Vector3(-Infinity,-Infinity,-Infinity);
    for(const mesh of meshes){const p=mesh.getVerticesData("position")!,uv=mesh.getVerticesData("uv"),ix=mesh.getIndices()!,world=mesh.computeWorldMatrix(true),tm=(mesh.material as PBRMaterial).albedoTexture?.getTextureMatrix();const points:Vec3[]=[],coords:number[][]=[];
      for(let i=0;i<p.length;i+=3){const q=Vector3.TransformCoordinates(Vector3.FromArray(p,i),world);minimum.minimizeInPlace(q);maximum.maximizeInPlace(q);points.push(q.asArray() as Vec3);const t=new Vector3(uv?.[i/3*2]??0,uv?.[i/3*2+1]??0,1);if(tm)Vector3.TransformCoordinatesToRef(t,tm,t);coords.push([t.x,t.y]);}
      for(let i=0;i<ix.length;i+=3){const [a,b,c]=world.determinant()<0?[ix[i],ix[i+2],ix[i+1]]:[ix[i],ix[i+1],ix[i+2]];triangles.push({a:points[a],b:points[b],c:points[c],material:materials.indexOf(mesh.material as PBRMaterial),uv:[...coords[a],...coords[b],...coords[c]] as Triangle['uv']});}
    }
    let spacing=.75,dimensions:Vec3=[1,1,1];do{dimensions=[Math.ceil((maximum.x-minimum.x)/spacing),Math.floor(2.8/spacing+.5),Math.ceil((maximum.z-minimum.z)/spacing)];if(dimensions.reduce((a,b)=>a*b,1)<=512)break;spacing+=.05;}while(spacing<2);
    const grid={origin:[minimum.x+spacing/2,spacing/2,minimum.z+spacing/2] as Vec3,dimensions,spacing};
    const layout=buildApartmentSurfaceLayout(meshes);gi=new ProbeGI(scene,engine,triangles,materials,grid,colors,layout);gi.updates=+control("probe-quality").value;gi.strength=+control("probe-strength").value;
    lastLighting=lastMaterials="";
    gi.warmingFixtures=true;
    try {
      for(const material of materials)material.maxSimultaneousLights=9;
      for(const kind of ["point","spot"] as const){
        if(disposed||mode.value!=="realtime"||controller.fixtures.length)break;
        fixtures.sync([{id:"__warm_"+kind,kind,position:[camera.position.x,1.2,camera.position.z],rotation:[0,0,0],enabled:true,lumens:0,kelvin:3000,beamDegrees:60}]);
        for(let frame=0;frame<3;frame++){
          if(disposed||mode.value!=="realtime"||controller.fixtures.length)break;
          await new Promise<void>(resolve=>{
            const finish=()=>{
              scene.onAfterRenderObservable.remove(observer);
              abort.signal.removeEventListener("abort",finish);
              resolve();
            };
            const observer=scene.onAfterRenderObservable.addOnce(finish);
            abort.signal.addEventListener("abort",finish,{once:true});
            if(abort.signal.aborted)finish();
          });
        }
      }
    } finally {
      if(!disposed)fixtures.sync(controller.fixtures);
      gi.warmingFixtures=false;
    }

  }
  async function select(){
    const baked=mode.value!=="realtime";setBaked(baked);if(gi)gi.enabled=!baked;
    if(baked){message.textContent="Baked lighting · fixed reference";return;}
    try{if(!gi){pending??=prepare();await pending;}if(disposed)return;if(gi)gi.enabled=mode.value==="realtime";}
    catch(e){error=String(e);mode.value="baked";setBaked(true);message.textContent=error;}
    finally{pending=undefined;}
  }
  mode.addEventListener("change",()=>void select(),{signal:abort.signal});
  let inspecting=false;const saved=new Map<PBRMaterial,[number,number,number]>();
  const observer=scene.onBeforeRenderObservable.add(()=>{
    if(scene.frameGraph?.pausedExecution)return;
    const changes=controller.consumeChanges();if(changes){for(const m of materials)m.maxSimultaneousLights=9;fixtures.sync(controller.fixtures);}
    if(gi){const state=JSON.stringify([sun.direction.asArray(),sun.intensity,sun.diffuse.asArray(),controller.fixtures]);if(state!==lastLighting){gi.setLights(sun.direction.scale(-1).normalize().asArray() as Vec3,sun.intensity,sun.diffuse.asArray() as Vec3,controller.fixtures);lastLighting=state;}
      const mat=JSON.stringify(materials.map(m=>[m.albedoColor.asArray(),m.metallic,m.roughness,m.alpha,m.needAlphaBlending()]));if(mat!==lastMaterials){gi.setMaterials(materials);lastMaterials=mat;}gi.enabled=mode.value==="realtime";gi.tick();
      controller.status={phase:gi.phase,preparationProgress:gi.preparationProgress,inactiveProbes:gi.inactiveProbes,converged:gi.progress===1,progress:gi.progress,gpuMs:gi.gpuMs,error:gi.error};
      if(gi.enabled)message.textContent=error||gi.error||(gi.warmingFixtures?"Preparing light shaders…":gi.phase==="preparing"?`Preparing lighting · ${Math.round(gi.preparationProgress*100)}%`:gi.phase==="refining"?`Lighting updating · ${Math.round(gi.progress*100)}%`:"Lighting settled · experimental GI");
    }
    const indirect=mode.value==="realtime"&&control("probe-view").value==="indirect";
    if(indirect!==inspecting){for(const m of materials){if(indirect){saved.set(m,[m.directIntensity,m.specularIntensity,m.environmentIntensity]);m.directIntensity=m.specularIntensity=m.environmentIntensity=0;}else{const values=saved.get(m)!;[m.directIntensity,m.specularIntensity,m.environmentIntensity]=values;}}scene.getMeshByName("sky")?.setEnabled(!indirect);inspecting=indirect;}
    if(error)message.textContent=error;
  });
  Object.assign(window,{lighting:{controller,scene,camera,fixtures,get gi(){return gi;}}});
  scene.onDisposeObservable.add(()=>{disposed=true;abort.abort();scene.onBeforeRenderObservable.remove(observer);gi?.dispose();fixtures.dispose();panel.remove();});
  void select();
  return{diagnostics:()=>({mode:mode.value,probePhase:gi?.phase,probeProgress:gi?.progress,probeGpuMs:gi?.gpuMs,probeError:error||gi?.error})};
}
