import { Constants, HDRFiltering, RawCubeTexture, SphericalPolynomial, Texture, type Scene, type PBRMaterial, type Mesh } from "@babylonjs/core";
import { skyRadiance } from "./lighting-model";
import type { Vec3 } from "./controller";
export class DaylightSky {
  texture: RawCubeTexture;
  private skybox: Mesh;
  private due = Infinity;
  private running = false;
  private disposed = false;
  private revision = 0;
  private sun: Vec3 = [0,1,0];
  error = "";
  constructor(private scene: Scene) {
    this.texture = new RawCubeTexture(scene,this.faces(),32,Constants.TEXTUREFORMAT_RGBA,Constants.TEXTURETYPE_FLOAT,true,false,Texture.TRILINEAR_SAMPLINGMODE);
    this.texture.gammaSpace=false;
    this.texture.sphericalPolynomial=new SphericalPolynomial();
    scene.environmentTexture=this.texture;
    this.skybox=scene.createDefaultSkybox(this.texture,true,100)!;
    const skyMaterial=this.skybox.material as PBRMaterial;
    skyMaterial.reflectionTexture!.sphericalPolynomial=new SphericalPolynomial();
  }
  setVisible(visible:boolean) {this.skybox.setEnabled(visible);}
  setSun(sun: Vec3) { this.sun=[...sun];this.revision++;this.due=performance.now()+250; }
  private faces() {
    return Array.from({length:6},(_,face)=>{
      const data=new Float32Array(32*32*4);
      for(let y=0;y<32;y++)for(let x=0;x<32;x++){
        const u=(x+.5)/16-1,v=(y+.5)/16-1;
        const directions:Vec3[]=[[1,-v,-u],[-1,-v,u],[u,1,v],[u,-1,-v],[u,-v,1],[-u,-v,-1]];
        const d=directions[face],length=Math.hypot(...d);
        data.set([...skyRadiance(d.map(n=>n/length) as Vec3,this.sun),1],(y*32+x)*4);
      }
      return data;
    });
  }
  tick() {
    if(this.disposed||this.running||performance.now()<this.due)return;
    const revision=this.revision;this.running=true;this.due=Infinity;
    const next=new RawCubeTexture(this.scene,this.faces(),32,Constants.TEXTUREFORMAT_RGBA,Constants.TEXTURETYPE_FLOAT,true,false,Texture.TRILINEAR_SAMPLINGMODE);
    next.gammaSpace=false;next.sphericalPolynomial=new SphericalPolynomial();
    // Serialized native GGX prefiltering. Rapid edits replace the pending state.
    void new HDRFiltering(this.scene.getEngine(),{quality:64}).prefilter(next).then(()=>{
      if(this.disposed||this.revision!==revision){next.dispose();return;}
      next.sphericalPolynomial=new SphericalPolynomial();
      const skyMaterial=this.skybox.material as PBRMaterial,previousSky=skyMaterial.reflectionTexture;
      const previous=this.texture;this.texture=next;this.scene.environmentTexture=next;skyMaterial.reflectionTexture=next;
      if(previousSky&&previousSky!==previous)previousSky.dispose();
      previous.dispose();
    }).catch(e=>{next.dispose();this.error=String(e);}).finally(()=>{
      this.running=false;
      if(this.disposed){this.texture.dispose();return;}
      if(this.revision!==revision)this.due=performance.now()+250;
    });
  }
  dispose() {this.disposed=true;this.skybox.dispose();if(!this.running)this.texture.dispose();}
}
