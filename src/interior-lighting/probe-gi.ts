import { ComputeShader, Constants, MaterialPluginBase, RawTexture, RawTexture2DArray, ShaderLanguage, StorageBuffer, Texture, UniformBuffer, type PBRMaterial, type Scene, type WebGPUEngine } from "@babylonjs/core";
import { buildBvh, packBvh, type Triangle } from "./bvh";
import { candela } from "./solar";
import { fixtureDirection, LIGHT_SCALE, temperature } from "./lighting-model";
import type { Fixture, Vec3 } from "./controller";
import source from "./probe-trace.wgsl?raw";

import common from "./probe-common.wgsl?raw";
import preparation from "./probe-prepare.wgsl?raw";
import pluginCode from "./probe-sampling.wgsl?raw";
import guardCode from "./probe-guard.wgsl?raw";
import { packVisibilityGeometry } from "./probe-visibility";
import { SurfaceCache } from "./surface-cache";
import type { SurfaceLayout } from "./surface-layout";
import surfaceSampling from "./surface-sampling.wgsl?raw";
export type ProbeDiagnostic = "off" | "contributors" | "weight" | "visibility" | "inactive" | "world-x" | "world-y" | "world-z" | "surface-u" | "surface-v" | "surface-id" | "normal-x" | "normal-y" | "normal-z" | "support";
const diagnostics:ProbeDiagnostic[]=["off","contributors","weight","visibility","inactive","world-x","world-y","world-z","surface-u","surface-v","surface-id","normal-x","normal-y","normal-z","support"];
class ProbeMaterial extends MaterialPluginBase {
  constructor(material: PBRMaterial, private probes: ProbeGI) {
    super(material, "SceneProbeGI", 210, {}, false, false);
    // Hooks read probes, so register after the subclass fields are initialized.
    this._pluginManager._addPlugin(this);this._enable(true);
    this.doNotSerialize = true;
  }
  isCompatible(language: ShaderLanguage) { return language === ShaderLanguage.WGSL; }
  getAttributes(names:string[]){if(this.probes.surfaceCache)names.push("probeSurface");}
  getSamplers(names: string[]) { if(this.probes.surfaceCache)names.push("probeSurfaceSampler","probeChartSampler");names.push("probeIrradianceSampler", "probeVisibilitySampler", "probePlacementSampler", "probeGeometrySampler"); }
  getUniforms() { return { ubo: [{ name: "probeGrid", size: 4, type: "vec4" }, { name: "probeDimensions", size: 4, type: "vec4" }, { name: "probeEnabled", size: 1, type: "float" }, {name:"probeDiagnostic",size:1,type:"float"}, {name:"probeBypass",size:2,type:"vec2"}, {name:"probeSurfaceEnabled",size:1,type:"float"}, {name:"probeStrength",size:1,type:"float"}] }; }
  bindForSubMesh(buffer: UniformBuffer) {
    buffer.updateFloat4("probeGrid", ...this.probes.origin, this.probes.spacing);
    buffer.updateFloat4("probeDimensions", ...this.probes.dimensions, this.probes.epoch);
    buffer.updateFloat("probeEnabled", this.probes.enabled && !this.probes.error && this.probes.preparationProgress===1 ? 1 : 0);
    buffer.setTexture("probeIrradianceSampler", this.probes.irradiance);
    buffer.setTexture("probeVisibilitySampler", this.probes.visibility);
    buffer.setTexture("probePlacementSampler",this.probes.placement);
    buffer.setTexture("probeGeometrySampler",this.probes.geometry);
    buffer.updateFloat("probeStrength",this.probes.strength);
    buffer.updateFloat("probeSurfaceEnabled",this.probes.surfaceCache?.enabled?1:0);
    if(this.probes.surfaceCache){buffer.setTexture("probeSurfaceSampler",this.probes.surfaceCache.texture);buffer.setTexture("probeChartSampler",this.probes.surfaceCache.charts);}
    buffer.updateFloat("probeDiagnostic",diagnostics.indexOf(this.probes.diagnostic));
    buffer.updateFloat2("probeBypass",Number(this.probes.bypass.moments),Number(this.probes.bypass.normal));
  }
  getCustomCode(type: string):Record<string,string>|null {
    if(type==="vertex"&&this.probes.surfaceCache)return{CUSTOM_VERTEX_DEFINITIONS:"attribute probeSurface:vec3f;\nvarying vProbeSurface:vec3f;",CUSTOM_VERTEX_MAIN_END:"vertexOutputs.vProbeSurface=vertexInputs.probeSurface;"};
    if(type!=="fragment") return null;
    return { CUSTOM_FRAGMENT_DEFINITIONS: guardCode+pluginCode+(this.probes.surfaceCache?surfaceSampling:""), CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
var probeResult=ProbeResult(vec3f(0),0,0,0,0,0,0u);
if(uniforms.probeEnabled>0.5){
  ${this.probes.surfaceCache?"if(uniforms.probeSurfaceEnabled>.5){probeResult=surfaceLight(fragmentInputs.vProbeSurface,fragmentInputs.vPositionW,geometricNormalW,normalW);}else":""}
  {probeResult=probeLight(fragmentInputs.vPositionW,geometricNormalW,normalW);}
  finalDiffuse+=(surfaceAlbedo*probeResult.light/3.14159265)*uniforms.probeStrength;
  #ifdef REFLECTION
  finalIrradiance=vec3f(0);
  #endif
}`, CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
if(uniforms.probeDiagnostic>.5){
  var color=vec3f(probeResult.count/8.0);
  if(uniforms.probeDiagnostic>1.5){color=vec3f(clamp(probeResult.weight,0.0,1.0));}
  if(uniforms.probeDiagnostic>2.5){color=vec3f(probeResult.visibility/8.0);}
  if(uniforms.probeDiagnostic>3.5){color=vec3f(probeResult.inactive/8.0,0,0);}
  if(probeResult.weight<=.000001){color=vec3f(1,0,1);}
  finalColor=vec4f(color,1);
  if(uniforms.probeDiagnostic>13.5){finalColor=vec4f(select(vec3f(.25),probeResult.light,uniforms.probeSurfaceEnabled>.5&&uniforms.probeEnabled>.5),1);}
  else if(uniforms.probeDiagnostic>4.5){
    let values=array<f32,9>(
      fragmentInputs.vPositionW.x,fragmentInputs.vPositionW.y,fragmentInputs.vPositionW.z,
      ${this.probes.surfaceCache?"fragmentInputs.vProbeSurface.x,fragmentInputs.vProbeSurface.y,fragmentInputs.vProbeSurface.z":"0.0,0.0,0.0"},
      geometricNormalW.x,geometricNormalW.y,geometricNormalW.z);
    let bits=bitcast<u32>(values[clamp(i32(uniforms.probeDiagnostic)-5,0,8)]);
    finalColor=vec4f(f32(bits&255u),f32((bits>>8u)&255u),f32((bits>>16u)&255u),f32(bits>>24u));
  }
}` };
  }
}
export class ProbeGI {
  readonly origin:Vec3;
  readonly dimensions:Vec3;
  readonly spacing:number;
  readonly count:number;
  readonly irradiance:RawTexture;
  readonly visibility:RawTexture;
  readonly placement:RawTexture;
  geometry:RawTexture;
  readonly surfaceCache?:SurfaceCache;
  private geometryTriangles:Triangle[];
  private transmitting:boolean[]=[];
  epoch=1;
  enabled=true;
  private strengthValue=1;
  get strength(){return this.strengthValue;}
  set strength(value:number){
    if(!Number.isFinite(value)||value<0||value>2)throw new RangeError("GI strength must be between 0 and 2");
    this.strengthValue=value;
  }
  error="";
  diagnostic:ProbeDiagnostic="off";
  readonly bypass={moments:false,normal:false};
  updates=128;
  elapsedMs=0;
  preparationMs=0;
  inactiveProbes=0;
  geometryRevision=0;
  private buffers:StorageBuffer[]=[];
  private params:UniformBuffer;
  private prepParams:UniformBuffer;
  private shader:ComputeShader;
  private prepareShader:ComputeShader;
  private atlas:RawTexture2DArray;
  private materialBuffer:StorageBuffer;
  private lightBuffer:StorageBuffer;
  private history:StorageBuffer;
  private positions:StorageBuffer;
  private cursor=0;
  private processed=0;
  private prepCursor=0;
  private prepPass=0;
  private start=performance.now();
  private prepStart=performance.now();
  warmingFixtures=false;
  private disposed=false;
  private classification="";
  private hasTransmission=false;
  private sunColor:Vec3=[1,1,1];
  private get probePreparationProgress(){return Math.min(1,(this.prepPass+this.prepCursor/this.count)/6);}
  get preparationProgress(){return this.surfaceCache?(this.probePreparationProgress+this.surfaceCache.progress)/2:this.probePreparationProgress;}
  get progress(){return this.preparationProgress<1?0:Math.min(1,this.processed/(this.count*16));}
  get phase():"preparing"|"refining"|"settled"|"error"{return this.error?"error":this.warmingFixtures||this.preparationProgress<1?"preparing":this.progress<1?"refining":"settled";}
  get gpuMs(){const counter=this.shader.gpuTimeInFrame?.counter;return counter&&counter.count>0?counter.current/1e6:null;}
  get preparationGpuMs(){const counter=this.prepareShader.gpuTimeInFrame?.counter;return counter&&counter.count>0?counter.current/1e6:null;}
  constructor(scene:Scene,private engine:WebGPUEngine,triangles:Triangle[],materials:PBRMaterial[],grid={origin:[.375,.375,.375] as Vec3,dimensions:[11,4,5] as Vec3,spacing:.75},colorData?:Uint8Array,surfaceLayout?:SurfaceLayout){
    this.origin=grid.origin;this.dimensions=grid.dimensions;this.spacing=grid.spacing;this.count=grid.dimensions.reduce((a,b)=>a*b,1);
    if(this.count>512||grid.dimensions.some(n=>!Number.isInteger(n)||n<2))throw new Error("Invalid probe grid");
    if(materials.length<1||materials.length>64)throw new Error("Prototype material budget exceeded");
    const colors=colorData??new Uint8Array(materials.length*128*128*4).fill(255);
    this.atlas=new RawTexture2DArray(colors,128,128,materials.length,Constants.TEXTUREFORMAT_RGBA,scene,false,false,Texture.BILINEAR_SAMPLINGMODE);this.atlas.gammaSpace=false;
    if(!triangles.length)throw new Error("GI requires geometry");
    this.geometryTriangles=triangles.map(t=>structuredClone(t));
    const packed=packBvh(buildBvh(triangles));
    this.buffer(new Uint8Array(packed.nodes));this.buffer(new Uint8Array(packed.triangles));
    this.materialBuffer=this.buffer(new Float32Array(64*4));this.lightBuffer=this.buffer(new Float32Array(8*12));
    this.history=this.buffer(new Float32Array(this.count*6*4));this.positions=this.buffer(new Float32Array(this.count*4));
    const texture=(width:number,full=false)=>new RawTexture(full?new Float32Array(width*this.count*4):new Uint16Array(width*this.count*4),width,this.count,Constants.TEXTUREFORMAT_RGBA,scene,false,false,Texture.NEAREST_SAMPLINGMODE,full?Constants.TEXTURETYPE_FLOAT:Constants.TEXTURETYPE_HALF_FLOAT,Constants.TEXTURE_CREATIONFLAG_STORAGE);
    const geometry=packVisibilityGeometry(this.geometryTriangles,[]);
    this.geometry=new RawTexture(geometry.data,geometry.width,geometry.height,Constants.TEXTUREFORMAT_RGBA,scene,false,false,Texture.NEAREST_SAMPLINGMODE,Constants.TEXTURETYPE_FLOAT);
    this.irradiance=texture(6);this.visibility=texture(256,true);this.placement=texture(1,true);
    const uniform=()=>{const result=new UniformBuffer(engine);for(const name of ["sun","sunColor","grid","dimensions","update"])result.addUniform(name,4);result.create();result.updateFloat4("grid",...this.origin,this.spacing);result.updateFloat4("dimensions",...this.dimensions,this.count);return result;};
    this.params=uniform();this.prepParams=uniform();
    this.shader=new ComputeShader("SceneProbeTrace",engine,{computeSource:common+source},{bindingsMapping:{nodes:{group:0,binding:0},triangles:{group:0,binding:1},materials:{group:0,binding:2},lights:{group:0,binding:3},params:{group:0,binding:4},history:{group:0,binding:5},irradiance:{group:0,binding:6},positions:{group:0,binding:7},albedos:{group:0,binding:9}}});
    this.prepareShader=new ComputeShader("SceneProbePrepare",engine,{computeSource:common+preparation},{bindingsMapping:{nodes:{group:0,binding:0},triangles:{group:0,binding:1},materials:{group:0,binding:2},positions:{group:0,binding:3},params:{group:0,binding:4},visibility:{group:0,binding:5},placement:{group:0,binding:6}}});
    for(const shader of [this.shader,this.prepareShader]){shader.setStorageBuffer("nodes",this.buffers[0]);shader.setStorageBuffer("triangles",this.buffers[1]);shader.setStorageBuffer("materials",this.materialBuffer);shader.setStorageBuffer("positions",this.positions);shader.onError=(_effect,error)=>{this.error=error;this.enabled=false;};}
    this.shader.setStorageBuffer("lights",this.lightBuffer);this.shader.setStorageBuffer("history",this.history);this.shader.setTexture("albedos",this.atlas);this.shader.setUniformBuffer("params",this.params);this.shader.setStorageTexture("irradiance",this.irradiance);
    this.prepareShader.setUniformBuffer("params",this.prepParams);this.prepareShader.setStorageTexture("visibility",this.visibility);this.prepareShader.setStorageTexture("placement",this.placement);
    if(surfaceLayout)this.surfaceCache=new SurfaceCache(scene,engine,surfaceLayout,grid,this.irradiance,this.visibility,this.placement);
    this.setMaterials(materials);for(const material of materials)new ProbeMaterial(material,this);
  }
  private buffer(data:ArrayBufferView){const result=new StorageBuffer(this.engine,data.byteLength);result.update(data);this.buffers.push(result);return result;}
  setMaterials(materials:PBRMaterial[]){
    if(materials.length>64)throw new Error("Prototype material budget exceeded");
    const data=new Float32Array(64*4);
    materials.forEach((m,i)=>data.set([m.albedoColor.r*(1-(m.metallic??0)),m.albedoColor.g*(1-(m.metallic??0)),m.albedoColor.b*(1-(m.metallic??0)),m.needAlphaBlending()?Math.max(.0001,Math.min(.99,m.alpha)):0],i*4));
    this.transmitting=materials.map(m=>m.needAlphaBlending());
    const classification=this.transmitting.map(Number).join();
    this.hasTransmission=materials.some(m=>m.needAlphaBlending());this.params.updateFloat4("sunColor",...this.sunColor,Number(this.hasTransmission));this.materialBuffer.update(data);
    if(classification!==this.classification){this.classification=classification;this.invalidateGeometry();}else this.reset(false);
  }
  setLights(sun:Vec3,intensity:number,color:Vec3,fixtures:Fixture[]){
    this.sunColor=[...color];this.params.updateFloat4("sun",...sun,intensity);this.params.updateFloat4("sunColor",...color,Number(this.hasTransmission));
    const data=new Float32Array(8*12);
    fixtures.filter(f=>f.enabled).forEach((f,i)=>{if(i>=8)throw new Error("Fixture budget exceeded");data.set([...f.position,candela(f.lumens,f.kind==="spot"?f.beamDegrees:undefined)*LIGHT_SCALE,...temperature(f.kelvin),f.kind==="spot"?1:0,...fixtureDirection(f.rotation),Math.cos(f.beamDegrees*Math.PI/360)],i*12);});
    this.lightBuffer.update(data);this.reset(false);
  }
  setGeometry(triangles:Triangle[]){
    if(this.surfaceCache)throw new Error("Surface-cache prototype requires a new scene/atlas for geometry edits");
    if(this.disposed)return;
    if(!triangles.length)throw new Error("GI requires geometry");
    this.geometryTriangles=triangles.map(t=>structuredClone(t));
    const packed=packBvh(buildBvh(triangles));
    [packed.nodes,packed.triangles].forEach((data,i)=>{const next=new StorageBuffer(this.engine,data.byteLength);next.update(new Uint8Array(data));for(const shader of [this.shader,this.prepareShader])shader.setStorageBuffer(i===0?"nodes":"triangles",next);this.buffers[i].dispose();this.buffers[i]=next;});
    this.invalidateGeometry();
  }
  private invalidateGeometry(){
    const lighting=packBvh(buildBvh(this.geometryTriangles),this.transmitting);
    this.buffers[0].update(new Uint8Array(lighting.nodes));
    const packed=packVisibilityGeometry(this.geometryTriangles,this.transmitting);
    const previous=this.geometry;
    this.geometry=new RawTexture(packed.data,packed.width,packed.height,Constants.TEXTUREFORMAT_RGBA,previous.getScene(),false,false,Texture.NEAREST_SAMPLINGMODE,Constants.TEXTURETYPE_FLOAT);
    this.surfaceCache?.invalidate(this.transmitting,this.geometry);
    previous.dispose();
    this.geometryRevision++;this.prepCursor=0;this.prepPass=0;this.prepStart=performance.now();this.preparationMs=0;this.inactiveProbes=0;this.reset();}
  reset(clear=true){
    if(this.disposed)return;
    this.epoch++;
    if(this.epoch>262143){this.epoch=1;this.history.update(new Float32Array(this.count*6*4));}
    if(clear){this.irradiance.update(new Uint16Array(6*this.count*4));this.cursor=0;}
    this.processed=0;this.start=performance.now();this.elapsedMs=0;
  }
  tick(){
    if(this.disposed||!this.enabled||this.error)return;
    if(this.probePreparationProgress<1){
      const count=Math.min(this.prepPass<5?32:4,this.count-this.prepCursor);
      this.prepParams.updateFloat4("update",this.prepCursor,this.prepPass,Number(this.prepPass===5),0);this.prepParams.update();
      if(!this.prepareShader.dispatch(count))return;
      this.prepCursor+=count;if(this.prepCursor===this.count){this.prepCursor=0;this.prepPass++;}
      this.preparationMs=performance.now()-this.prepStart;
      if(this.probePreparationProgress===1){
        this.start=performance.now();const revision=this.geometryRevision;
        void this.positions.read().then(data=>{if(this.disposed||revision!==this.geometryRevision)return;const values=new Float32Array(data.buffer,data.byteOffset,data.byteLength/4);this.inactiveProbes=Array.from({length:this.count},(_,i)=>values[i*4+3]).filter(v=>v<.5).length;}).catch(error=>{if(!this.disposed&&revision===this.geometryRevision)this.error=String(error);});
      }
      return;
    }
    if(this.surfaceCache&&this.surfaceCache.progress<1){
      this.surfaceCache.tick();if(this.surfaceCache.error)this.error=this.surfaceCache.error;
      this.preparationMs=performance.now()-this.prepStart;
      if(this.surfaceCache.progress===1)this.start=performance.now();
      return;
    }
    if(this.progress>=1)return;
    const count=Math.min(this.updates,this.count,this.count*16-this.processed);
    this.params.updateFloat4("update",this.cursor,count,this.epoch,0);this.params.update();
    if(!this.shader.dispatch(count))return;
    this.cursor=(this.cursor+count)%this.count;this.processed+=count;this.elapsedMs=performance.now()-this.start;
  }
  async readIrradiance(){return this.irradiance.readPixels();}
  async readPlacement(){return this.positions.read();}
  dispose(){if(this.disposed)return;this.disposed=true;for(const buffer of this.buffers)buffer.dispose();this.params.dispose();this.prepParams.dispose();this.atlas.dispose();this.irradiance.dispose();this.visibility.dispose();this.placement.dispose();this.geometry.dispose();this.surfaceCache?.dispose();}
}






