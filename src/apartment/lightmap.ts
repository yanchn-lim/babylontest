import { MaterialPluginBase, ShaderLanguage, type MaterialDefines, type PBRMaterial, type Texture, type UniformBuffer } from '@babylonjs/core';

export interface ApartmentLightmapState { texture: Texture; ready: boolean; sky: number }

/** Received diffuse light can use the native material colour at each visible pixel. */
export class ApartmentLightmap extends MaterialPluginBase {
  constructor(material: PBRMaterial, private state: ApartmentLightmapState, private receivedDiffuse = false) {
    super(material, 'ApartmentLightmap', 200, {}, true, true);
  }
  isCompatible() { return true; }
  prepareDefinesBeforeAttributes(defines: MaterialDefines) {
    defines._needUVs = true;
    (defines as MaterialDefines & { MAINUV3: boolean }).MAINUV3 = true;
  }
  getSamplers(names: string[]) { names.push('diffuseTransfer'); }
  getUniforms(language?: ShaderLanguage) {
    return { ubo: [{ name: 'transferState', size: 4, type: 'vec4' }],
      fragment: language === ShaderLanguage.WGSL ? '' : '#ifndef UNIFORMBUFFERS\nuniform vec4 transferState;\n#endif' };
  }
  bindForSubMesh(buffer: UniformBuffer) {
    const { width, height } = this.state.texture.getSize();
    buffer.updateFloat4('transferState', Number(this.state.ready), this.state.sky, 1, width / Math.max(1, height));
    buffer.setTexture('diffuseTransfer', this.state.texture);
  }
  getCustomCode(type: string, language?: ShaderLanguage) {
    if (type !== 'fragment') return null;
    const wgsl = language === ShaderLanguage.WGSL;
    const state = wgsl ? 'uniforms.transferState' : 'transferState';
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: wgsl ? 'var diffuseTransfer: texture_2d<f32>; var diffuseTransferSampler: sampler;'
        : 'uniform sampler2D diffuseTransfer;',
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
        #ifdef LIGHTMAP
        if (${state}.x > 0.5) {
          lightmapColor = ${wgsl ? 'textureSample(diffuseTransfer, diffuseTransferSampler, fragmentInputs.vMainUV3 * uniforms.transferState.zw)' : 'texture2D(diffuseTransfer, vMainUV3 * transferState.zw)'};
          ${this.receivedDiffuse ? `
          // RGB is premultiplied by sample validity before bilinear filtering.
          lightmapColor = ${wgsl ? 'vec4f' : 'vec4'}(lightmapColor.rgb / max(lightmapColor.a, 0.0001), 1.0);
          #if defined(METALLICWORKFLOW) && !defined(UNLIT)
          lightmapColor = ${wgsl ? 'vec4f' : 'vec4'}(lightmapColor.rgb * baseColor * (1.0 - reflectivityOut.metallic), 1.0);
          #else
          lightmapColor = ${wgsl ? 'vec4f' : 'vec4'}(lightmapColor.rgb * surfaceAlbedo, 1.0);
          #endif` : ''}
        } else { lightmapColor = ${wgsl ? 'vec4f' : 'vec4'}(lightmapColor.rgb * ${state}.y, 1.0); }
        #endif`,
    };
  }
}
