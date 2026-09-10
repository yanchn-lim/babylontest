// Frozen comparison baseline. Keep until the filtered candidate passes acceptance.
import { ComputeShader, Constants, MaterialPluginBase, RawTexture, RawTexture2DArray, ShaderLanguage, StorageBuffer, Texture, UniformBuffer, type PBRMaterial, type Scene, type WebGPUEngine } from "@babylonjs/core";
import { buildBvh, packBvh, type Triangle } from "./bvh";
import { candela } from "./solar";
import { fixtureDirection, LIGHT_SCALE, temperature } from "./lighting-model";
import type { Fixture, Vec3 } from "./controller";
import source from "./probe-baseline.wgsl?raw";

const pluginCode = `
var probeIrradianceSampler: texture_2d<f32>;
var probeIrradianceSamplerSampler: sampler;
var probeVisibilitySampler: texture_2d<f32>;
var probeVisibilitySamplerSampler: sampler;
fn probeOct(d:vec3f)->vec2f {
  var p=d.xy/(abs(d.x)+abs(d.y)+abs(d.z));
  if(d.z<0.0){p=(1.0-abs(p.yx))*select(vec2f(-1),vec2f(1),p>=vec2f(0));}
  return p*.5+.5;
}
fn probeLight(p:vec3f,n:vec3f)->vec3f {
  let dims=vec3i(uniforms.probeDimensions.xyz);
  let grid=clamp((p+n*.03-uniforms.probeGrid.xyz)/uniforms.probeGrid.w,vec3f(0),vec3f(dims)-1.001);
  let base=vec3i(floor(grid));let fraction=fract(grid);
  var result=vec3f(0);var total=0.0;
  for(var i=0;i<8;i++) {
    let offset=vec3i(i&1,(i>>1)&1,(i>>2)&1);let cell=base+offset;
    let index=cell.x+dims.x*(cell.y+dims.y*cell.z);
    let position=uniforms.probeGrid.xyz+vec3f(cell)*uniforms.probeGrid.w;
    let delta=p+n*.03-position;let distance=length(delta);
    let direction=delta/max(distance,.0001);
    let oct=clamp(vec2i(probeOct(direction)*8.0),vec2i(0),vec2i(7));
    let moments=textureLoad(probeVisibilitySampler,vec2i(oct.x+oct.y*8,index),0);
    if(moments.z!=uniforms.probeDimensions.w){continue;}
    var blocked=false;
    for(var triangleIndex=0;triangleIndex<3;triangleIndex++){
      let slot=oct.x+oct.y*8+(1+triangleIndex*3)*64;
      let a=textureLoad(probeVisibilitySampler,vec2i(slot,index),0);
      if(a.w<.5){continue;}
      let b=textureLoad(probeVisibilitySampler,vec2i(slot+64,index),0).xyz;
      let c=textureLoad(probeVisibilitySampler,vec2i(slot+128,index),0).xyz;
      let e1=b-a.xyz;let e2=c-a.xyz;let q=cross(delta,e2);let det=dot(e1,q);
      if(abs(det)<.000001){continue;}
      let u=dot(-a.xyz,q)/det;if(u<0.0||u>1.0){continue;}
      let r=cross(-a.xyz,e1);let v=dot(delta,r)/det;if(v<0.0||u+v>1.0){continue;}
      let t=dot(e2,r)/det;
      if(t>0.0 && t<1.0-.005/max(distance,.01)){blocked=true;break;}
    }
    if(blocked){continue;}
    let difference=max(0.0,distance-.08-moments.x);
    let variance=max(.0001,moments.y-moments.x*moments.x);
    let visibility=pow(variance/(variance+difference*difference),3.0);
    if(visibility<.2){continue;}
    let trilinear=select(1.0-fraction,fraction,offset==vec3i(1));
    let weight=trilinear.x*trilinear.y*trilinear.z*visibility*pow(max(.05,1.0-dot(n,direction))*.5,2.0);
    let x=textureLoad(probeIrradianceSampler,vec2i(select(1,0,n.x>=0.0),index),0);
    if(x.a<.5){continue;}
    let y=textureLoad(probeIrradianceSampler,vec2i(select(3,2,n.y>=0.0),index),0);
    let z=textureLoad(probeIrradianceSampler,vec2i(select(5,4,n.z>=0.0),index),0);
    result+=(x.rgb*abs(n.x)+y.rgb*abs(n.y)+z.rgb*abs(n.z))/max(.001,abs(n.x)+abs(n.y)+abs(n.z))*weight;
    total+=weight;
  }
  return result/max(total,.00001);
}`;
class ProbeMaterial extends MaterialPluginBase {
  constructor(material: PBRMaterial, private probes: BaselineProbeGI) {
    super(material, "SceneBaselineProbeGI", 210, {}, true, true);
    this.doNotSerialize = true;
  }
  isCompatible(language: ShaderLanguage) { return language === ShaderLanguage.WGSL; }
  getSamplers(names: string[]) { names.push("probeIrradianceSampler", "probeVisibilitySampler"); }
  getUniforms() { return { ubo: [{ name: "probeGrid", size: 4, type: "vec4" }, { name: "probeDimensions", size: 4, type: "vec4" }, { name: "probeEnabled", size: 1, type: "float" }] }; }
  bindForSubMesh(buffer: UniformBuffer) {
    buffer.updateFloat4("probeGrid", ...this.probes.origin, this.probes.spacing);
    buffer.updateFloat4("probeDimensions", ...this.probes.dimensions, this.probes.epoch);
    buffer.updateFloat("probeEnabled", this.probes.enabled && !this.probes.error ? 1 : 0);
    buffer.setTexture("probeIrradianceSampler", this.probes.irradiance);
    buffer.setTexture("probeVisibilitySampler", this.probes.visibility);
  }
  getCustomCode(type: string) {
    if(type!=="fragment") return null;
    return { CUSTOM_FRAGMENT_DEFINITIONS: pluginCode, CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
if(uniforms.probeEnabled>0.5){
  finalDiffuse+=surfaceAlbedo*probeLight(fragmentInputs.vPositionW,normalW)/3.14159265;
  #ifdef REFLECTION
  finalIrradiance=vec3f(0);
  #endif
}` };
  }
}
export class BaselineProbeGI {
  readonly origin: Vec3;
  readonly dimensions: Vec3;
  readonly spacing: number;
  readonly count: number;
  readonly irradiance: RawTexture;
  readonly visibility: RawTexture;
  get preparationProgress(){return 1;}
  readonly inactiveProbes=0;
  get phase():"preparing"|"refining"|"settled"|"error"{return this.error?"error":this.progress<1?"refining":"settled";}
  epoch = 1;
  enabled = true;
  error = "";
  private buffers: StorageBuffer[] = [];
  private params: UniformBuffer;
  private shader: ComputeShader;
  private atlas: RawTexture2DArray;
  private hasTransmission = false;
  private materialBuffer: StorageBuffer;
  private lightBuffer: StorageBuffer;
  private history: StorageBuffer;
  private cursor = 0;
  private sweep = 0;
  private start = performance.now();
  private disposed = false;
  updates = 128;
  elapsedMs = 0;
  get progress() { return Math.min(1,(this.sweep+this.cursor/this.count)/16); }
  get gpuMs() { const counter=this.shader.gpuTimeInFrame?.counter; return counter && counter.count>0 ? counter.current/1e6 : null; }
  constructor(scene: Scene, private engine: WebGPUEngine, triangles: Triangle[], materials: PBRMaterial[], grid={origin:[.375,.375,.375] as Vec3,dimensions:[11,4,5] as Vec3,spacing:.75}, colorData?:Uint8Array) {
    this.origin=grid.origin;this.dimensions=grid.dimensions;this.spacing=grid.spacing;this.count=grid.dimensions.reduce((a,b)=>a*b,1);
    if(this.count>512||this.count<1)throw new Error("Probe budget exceeded");
    const colors=colorData??new Uint8Array(materials.length*128*128*4).fill(255);
    this.atlas=new RawTexture2DArray(colors,128,128,materials.length,Constants.TEXTUREFORMAT_RGBA,scene,false,false,Texture.BILINEAR_SAMPLINGMODE);
    this.atlas.gammaSpace=false;
    const bvh = packBvh(buildBvh(triangles));
    const buffer = (data: ArrayBufferView) => { const result=new StorageBuffer(engine,data.byteLength); result.update(data); this.buffers.push(result); return result; };
    const nodes=buffer(new Uint8Array(bvh.nodes)), geometry=buffer(new Uint8Array(bvh.triangles));
    this.materialBuffer=buffer(new Float32Array(64*4)); this.lightBuffer=buffer(new Float32Array(8*12));
    this.history=buffer(new Float32Array(this.count*64*44));
    const texture=(width:number,fullPrecision=false)=>new RawTexture(fullPrecision?new Float32Array(width*this.count*4):new Uint16Array(width*this.count*4),width,this.count,Constants.TEXTUREFORMAT_RGBA,scene,false,false,Texture.NEAREST_SAMPLINGMODE,fullPrecision?Constants.TEXTURETYPE_FLOAT:Constants.TEXTURETYPE_HALF_FLOAT,Constants.TEXTURE_CREATIONFLAG_STORAGE);
    this.irradiance=texture(6); this.visibility=texture(640,true);
    this.params=new UniformBuffer(engine); for(const name of ["sun","sunColor","grid","dimensions","update"]) this.params.addUniform(name,4); this.params.create();
    this.params.updateFloat4("grid",...this.origin,this.spacing); this.params.updateFloat4("dimensions",...this.dimensions,this.count);
    this.shader=new ComputeShader("SceneProbeTrace",engine,{computeSource:source},{bindingsMapping:{nodes:{group:0,binding:0},triangles:{group:0,binding:1},materials:{group:0,binding:2},lights:{group:0,binding:3},params:{group:0,binding:4},history:{group:0,binding:5},irradiance:{group:0,binding:6},visibility:{group:0,binding:7},albedos:{group:0,binding:9}}});
    this.shader.setStorageBuffer("nodes",nodes); this.shader.setStorageBuffer("triangles",geometry);
    this.shader.setStorageBuffer("materials",this.materialBuffer); this.shader.setStorageBuffer("lights",this.lightBuffer); this.shader.setStorageBuffer("history",this.history);
    this.shader.setTexture("albedos",this.atlas);
    this.shader.setUniformBuffer("params",this.params); this.shader.setStorageTexture("irradiance",this.irradiance); this.shader.setStorageTexture("visibility",this.visibility);
    this.shader.onError=(_effect,error)=>{this.error=error;this.enabled=false;};
    for(const material of materials) new ProbeMaterial(material,this);
    this.setMaterials(materials);
  }
  setMaterials(materials: PBRMaterial[]) {
    if(materials.length>64) throw new Error("Prototype material budget exceeded");
    const data=new Float32Array(64*4);
    materials.forEach((m,i)=>data.set([m.albedoColor.r*(1-(m.metallic??0)),m.albedoColor.g*(1-(m.metallic??0)),m.albedoColor.b*(1-(m.metallic??0)),m.needAlphaBlending()?Math.min(.99,m.alpha):0],i*4));
    this.hasTransmission=materials.some(m=>m.needAlphaBlending());
    this.materialBuffer.update(data); this.reset();
  }
  setLights(sun:Vec3,intensity:number,color:Vec3,fixtures:Fixture[]) {
    this.params.updateFloat4("sun",...sun,intensity);this.params.updateFloat4("sunColor",...color,this.hasTransmission?1:0);
    const data=new Float32Array(8*12);
    fixtures.filter(f=>f.enabled).forEach((f,i)=>{ if(i>=8) throw new Error("Fixture budget exceeded"); data.set([...f.position,candela(f.lumens,f.kind==="spot"?f.beamDegrees:undefined)*LIGHT_SCALE,...temperature(f.kelvin),f.kind==="spot"?1:0,...fixtureDirection(f.rotation),Math.cos(f.beamDegrees*Math.PI/360)],i*12); });
    this.lightBuffer.update(data); this.reset();
  }
  reset() {
    this.epoch++; if(this.epoch>1024){this.epoch=1;this.history.clear();this.visibility.update(new Float32Array(640*this.count*4));}
    this.cursor=0;this.sweep=0;this.start=performance.now();this.elapsedMs=0;
  }
  tick() {
    if(this.disposed||!this.enabled||this.error||this.progress>=1) return;
    this.params.updateFloat4("update",this.cursor,this.updates,this.epoch,this.sweep);this.params.update();
    const count=Math.min(this.updates,this.count-this.cursor);
    if(!this.shader.dispatch(count)) return;
    this.cursor+=count;if(this.cursor>=this.count){this.cursor=0;this.sweep++;}
    this.elapsedMs=performance.now()-this.start;
  }
  async readIrradiance() { return this.irradiance.readPixels(); }
  dispose() { if(this.disposed)return;this.disposed=true;for(const b of this.buffers)b.dispose();this.params.dispose();this.atlas.dispose();this.irradiance.dispose();this.visibility.dispose(); }
}
