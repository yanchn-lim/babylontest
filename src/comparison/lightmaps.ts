import { MaterialPluginBase, ShaderLanguage, type PBRMaterial, type Texture, type UniformBuffer } from '@babylonjs/core';

export interface LightmapState {
  sky: number;
  fixtures: number;
  blend: number;
  lower: Texture;
  upper: Texture;
  fixtureMap: Texture;
  cascadeMap: Texture;
  useCascades: boolean;
}

/** RGBM stores linear baked radiance, including the fixed surface colour. */
export class ComparisonLightmaps extends MaterialPluginBase {
  constructor(material: PBRMaterial, private state: LightmapState) {
    super(material, 'ComparisonLightmaps', 200, {}, true, true);
  }
  isCompatible() { return true; }
  getSamplers(names: string[]) { names.push('basisLower', 'basisUpper', 'basisFixtures', 'cascadeMap'); }
  getUniforms(language?: ShaderLanguage) {
    return {
      ubo: [{ name: 'basisWeights', size: 4, type: 'vec4' }],
      fragment: language === ShaderLanguage.WGSL ? '' : '#ifndef UNIFORMBUFFERS\nuniform vec4 basisWeights;\n#endif',
    };
  }
  bindForSubMesh(buffer: UniformBuffer) {
    buffer.updateFloat4('basisWeights', this.state.sky, this.state.fixtures, this.state.blend, Number(this.state.useCascades));
    buffer.setTexture('basisLower', this.state.lower);
    buffer.setTexture('basisUpper', this.state.upper);
    buffer.setTexture('basisFixtures', this.state.fixtureMap);
    buffer.setTexture('cascadeMap', this.state.cascadeMap);
  }
  getCustomCode(type: string, language?: ShaderLanguage) {
    if (type !== 'fragment') return null;
    const wgsl = language === ShaderLanguage.WGSL;
    const names = ['basisLower', 'basisUpper', 'basisFixtures', 'cascadeMap'];
    const sample = (name: string) => wgsl
      ? `textureSample(${name}, ${name}Sampler, fragmentInputs.vLightmapUV)`
      : `texture2D(${name}, vLightmapUV)`;
    const weights = wgsl ? 'uniforms.basisWeights' : 'basisWeights';
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: names.map(name => wgsl
        ? `var ${name}: texture_2d<f32>; var ${name}Sampler: sampler;`
        : `uniform sampler2D ${name};`).join('\n'),
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
        #ifdef LIGHTMAP
        if (${weights}.w > 0.5) {
          lightmapColor = ${sample('cascadeMap')};
        } else {
        ${wgsl ? 'let' : 'vec4'} basisA = ${sample('basisLower')};
        ${wgsl ? 'let' : 'vec4'} basisB = ${sample('basisUpper')};
        ${wgsl ? 'let' : 'vec4'} basisF = ${sample('basisFixtures')};
        lightmapColor = ${wgsl ? 'vec4f' : 'vec4'}(16.0 * (
          lightmapColor.rgb * lightmapColor.a * ${weights}.x +
          mix(basisA.rgb * basisA.a, basisB.rgb * basisB.a, ${weights}.z) +
          basisF.rgb * basisF.a * ${weights}.y), 1.0);
        }
        #endif`,
    };
  }
}
