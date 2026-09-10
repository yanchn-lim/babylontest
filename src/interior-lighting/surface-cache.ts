import { ComputeShader, Constants, RawTexture, RawTexture2DArray, StorageBuffer, Texture, UniformBuffer, type Scene, type WebGPUEngine } from "@babylonjs/core";
import type { Vec3 } from "./controller";
import type { SurfaceLayout } from "./surface-layout";
import sampling from "./probe-sampling.wgsl?raw";
import preparation from "./surface-prepare.wgsl?raw";
import trianglePreparation from "./surface-triangles.wgsl?raw";
import guard from "./probe-guard.wgsl?raw";

export class SurfaceCache {
  readonly texture:RawTexture2DArray;
  readonly charts:RawTexture;
  readonly bytes:number;
  enabled=true;
  error="";
  elapsedMs=0;
  uncoveredCells=0;
  recoveredCells=0;
  certifiedLinks=0;
  revision=0;
  private cursor=0;
  private started=0;
  private disposed=false;
  private shader:ComputeShader;
  private uniforms:UniformBuffer;
  private cells:StorageBuffer;
  private boxes:StorageBuffer;
  private stats:StorageBuffer;
  private clipped?:StorageBuffer;
  get progress(){return this.cursor/this.layout.count;}
  get gpuMs(){const c=this.shader.gpuTimeInFrame?.counter;return c&&c.count>0?c.current/1e6:null;}
  constructor(scene:Scene,engine:WebGPUEngine,readonly layout:SurfaceLayout,grid:{origin:Vec3;dimensions:Vec3;spacing:number},irradiance:RawTexture,visibility:RawTexture,placement:RawTexture){
    const height=Math.ceil(layout.count/256);
    this.texture=new RawTexture2DArray(null,256,height,14,Constants.TEXTUREFORMAT_RGBA,scene,false,false,Texture.NEAREST_SAMPLINGMODE,Constants.TEXTURETYPE_FLOAT,Constants.TEXTURE_CREATIONFLAG_STORAGE);
    const chartHeight=Math.ceil(layout.charts.length/1024),chartData=new Float32Array(256*chartHeight*4);chartData.set(layout.charts);
    this.charts=new RawTexture(chartData,256,chartHeight,Constants.TEXTUREFORMAT_RGBA,scene,false,false,Texture.NEAREST_SAMPLINGMODE,Constants.TEXTURETYPE_FLOAT);
    this.cells=new StorageBuffer(engine,layout.cells.byteLength);this.cells.update(layout.cells);
    this.boxes=new StorageBuffer(engine,Math.max(32,layout.boxes.length*32));this.stats=new StorageBuffer(engine,12);
    if(layout.clipped){this.clipped=new StorageBuffer(engine,layout.clipped.byteLength);this.clipped.update(layout.clipped);}
    this.bytes=256*height*14*16+chartData.byteLength+layout.cells.byteLength+Math.max(32,layout.boxes.length*32)+12+(layout.clipped?.byteLength??0);
    this.uniforms=new UniformBuffer(engine);for(const name of ["probeGrid","probeDimensions","surfaceInfo"])this.uniforms.addUniform(name,4);this.uniforms.create();
    this.uniforms.updateFloat4("probeGrid",...grid.origin,grid.spacing);this.uniforms.updateFloat4("probeDimensions",...grid.dimensions,0);
    let source=sampling.slice(0,sampling.indexOf("struct ProbeResult")).replace(/^var .*SamplerSampler: sampler;\r?\n/gm,"");
    for(const [i,name] of ["probeIrradianceSampler","probeVisibilitySampler","probePlacementSampler"].entries())source=source.replace(`var ${name}:`,`@group(0) @binding(${i}) var ${name}:`);
    let algorithm=preparation;
    if(layout.clipped){
      source+=guard.replace(/^var .*SamplerSampler: sampler;\r?\n/gm,"").replace("var probeGeometrySampler:","@group(0) @binding(4) var probeGeometrySampler:");
      algorithm=algorithm.slice(0,algorithm.indexOf("fn surfaceClear"))+trianglePreparation+algorithm.slice(algorithm.indexOf("fn surfaceWeight"));
      algorithm=algorithm.replace(/^@group\(0\) @binding\(4\).*\r?\n/m,"").replace(/^  for\(var b=0u.*hidden=.*\r?\n/m,"");
      algorithm=algorithm.replace("  let center=p+",`  polygonCount=i32(surfaceClips[address*7u].x);
  if(polygonCount<3){let xy=vec2i(i32(address)%256,i32(address)/256);for(var layer=0;layer<14;layer++){textureStore(cache,xy,layer,select(vec4f(0),vec4f(-1),layer<2||layer>=10));}return;}
  for(var i=0;i<polygonCount;i++){polygon[i]=surfaceClips[address*7u+1u+u32(i)].xyz+n*.001;}
  let center=p+`);
    }
    this.shader=new ComputeShader("SurfaceVisibilityPrepare",engine,{computeSource:source+algorithm},{bindingsMapping:{probeVisibilitySampler:{group:0,binding:1},probePlacementSampler:{group:0,binding:2},cells:{group:0,binding:3},...(layout.clipped?{probeGeometrySampler:{group:0,binding:4},surfaceClips:{group:0,binding:8}}:{boxes:{group:0,binding:4}}),cache:{group:0,binding:5},stats:{group:0,binding:6},uniforms:{group:0,binding:7}}});
    this.shader.setTexture("probeVisibilitySampler",visibility,false);this.shader.setTexture("probePlacementSampler",placement,false);
    this.shader.setStorageBuffer("cells",this.cells);if(this.clipped)this.shader.setStorageBuffer("surfaceClips",this.clipped);else this.shader.setStorageBuffer("boxes",this.boxes);this.shader.setStorageBuffer("stats",this.stats);this.shader.setStorageTexture("cache",this.texture);this.shader.setUniformBuffer("uniforms",this.uniforms);
    this.shader.onError=(_effect,error)=>this.error=error;
  }
  invalidate(transmitting:readonly boolean[],geometry?:RawTexture){
    if(this.disposed)return;this.revision++;this.cursor=0;this.started=0;this.elapsedMs=0;this.uncoveredCells=0;this.recoveredCells=0;this.certifiedLinks=0;
    this.stats.update(new Uint32Array(3));
    if(this.clipped&&geometry)this.shader.setTexture("probeGeometrySampler",geometry,false);
    if(this.layout.boxes.length)this.boxes.update(new Float32Array(this.layout.boxes.flatMap(b=>[...b.min,Number(transmitting[b.material]??false),...b.max,0])));
  }
  tick(){
    if(this.disposed||this.error||this.progress===1)return;
    if(!this.started)this.started=performance.now();
    const count=Math.min(2048,this.layout.count-this.cursor);
    this.uniforms.updateFloat4("surfaceInfo",this.cursor,this.layout.count,count,0);this.uniforms.update();
    if(!this.shader.dispatch(Math.ceil(count/64)))return;
    this.cursor+=count;this.elapsedMs=performance.now()-this.started;
    if(this.progress===1){const revision=this.revision;void this.stats.read().then(data=>{if(this.disposed||revision!==this.revision)return;const values=new Uint32Array(data.buffer,data.byteOffset,3);[this.uncoveredCells,this.recoveredCells,this.certifiedLinks]=values;}).catch(error=>{if(!this.disposed&&revision===this.revision)this.error=String(error);});}
  }
  dispose(){if(this.disposed)return;this.disposed=true;this.texture.dispose();this.charts.dispose();this.cells.dispose();this.boxes.dispose();this.stats.dispose();this.uniforms.dispose();this.clipped?.dispose();}
}


