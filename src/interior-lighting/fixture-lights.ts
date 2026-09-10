import { enableTwoSidedShadows } from "../two-sided-shadows";
import { Color3, Light, PointLight, ShadowGenerator, SpotLight, Vector3, type AbstractMesh, type FrameGraphObjectRendererTask, type Scene } from "@babylonjs/core";
import type { Fixture } from "./controller";
import { candela } from "./solar";
import { fixtureDirection, LIGHT_SCALE, temperature } from "./lighting-model";
export class FixtureLights {
  private entries=new Map<string,{light:PointLight|SpotLight;shadow:ShadowGenerator;state:string;shadowState:string}>();
  private detach?:()=>void;
  private scene: Scene;
  private casters: AbstractMesh[];
  constructor(scene: Scene, casters: AbstractMesh[], task?:FrameGraphObjectRendererTask) {
    this.scene = scene;
    this.casters = casters;
    if(task&&scene.frameGraph){
      const graph=scene.frameGraph,renderer=task.objectRenderer;
      const observer=renderer.onBeforeRenderObservable.add(()=>{
        for(const {light} of this.entries.values())light.shadowEnabled=!task.disableShadows;
      });
      const reorder=()=>renderer.onBeforeRenderObservable.makeObserverBottomPriority(observer);
      const built=graph.onBuildObservable.add(reorder);reorder();
      this.detach=()=>{renderer.onBeforeRenderObservable.remove(observer);graph.onBuildObservable.remove(built);};
    }
  }
  sync(fixtures:Fixture[]) {
    for(const [id,entry] of this.entries)if(!fixtures.some(f=>f.id===id)){entry.shadow.dispose();entry.light.dispose();this.entries.delete(id);}
    const enabled=new Set(fixtures.filter(f=>f.enabled).map(f=>f.id));
    for(const fixture of fixtures){
      let entry=this.entries.get(fixture.id);
      if(!entry&&!fixture.enabled)continue;
      if(!entry){
        if(this.entries.size>=8){
          const spare=[...this.entries].find(([id])=>!enabled.has(id));
          if(!spare)throw new Error("Fixture shadow cache budget exceeded");
          spare[1].shadow.dispose();spare[1].light.dispose();this.entries.delete(spare[0]);
        }
        const light=fixture.kind==="point"?new PointLight(fixture.id,Vector3.Zero(),this.scene):new SpotLight(fixture.id,Vector3.Zero(),Vector3.Down(),Math.PI/3,0,this.scene);
        light.intensityMode=Light.INTENSITYMODE_LUMINOUSINTENSITY;
        light.falloffType=Light.FALLOFF_GLTF;
        light.shadowMinZ=.005;light.shadowMaxZ=20;
        const shadow=new ShadowGenerator(fixture.kind==="point"?512:1024,light);
        if(fixture.kind==="point")shadow.usePoissonSampling=true;else shadow.usePercentageCloserFiltering=true;
        shadow.bias=.0005;shadow.normalBias=.001;shadow.transparencyShadow=true;
        enableTwoSidedShadows(shadow);
        for(const mesh of this.casters)shadow.addShadowCaster(mesh);
        shadow.getShadowMap()!.refreshRate=0;
        if(this.scene.frameGraph)this.scene.customRenderTargets.push(shadow.getShadowMap()!);
        entry={light,shadow,state:"",shadowState:""};this.entries.set(fixture.id,entry);
      }
      const state=JSON.stringify(fixture);if(state===entry.state)continue;
      entry.state=state;
      const light=entry.light;
      light.position.set(...fixture.position);
      light.intensity=fixture.enabled?candela(fixture.lumens,fixture.kind==="spot"?fixture.beamDegrees:undefined)*LIGHT_SCALE:0;
      light.diffuse=new Color3(...temperature(fixture.kelvin));light.specular=light.diffuse;
      if(light instanceof SpotLight){light.direction.set(...fixtureDirection(fixture.rotation));light.angle=fixture.beamDegrees*Math.PI/180;light.innerAngle=light.angle*.98;}
      const shadowState=JSON.stringify([fixture.position,fixture.kind==="spot"?[fixture.rotation,fixture.beamDegrees]:null]);
      if(shadowState!==entry.shadowState){entry.shadowState=shadowState;entry.shadow.getShadowMap()!.resetRefreshCounter();}
    }
  }
  invalidateCasters() {for(const entry of this.entries.values())entry.shadow.getShadowMap()!.resetRefreshCounter();}
  dispose() {this.detach?.();this.detach=undefined;for(const entry of this.entries.values()){entry.shadow.dispose();entry.light.dispose();}this.entries.clear();}
}
