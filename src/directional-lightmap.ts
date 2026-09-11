import {
  MaterialPluginBase, ShaderLanguage, type PBRMaterial, type Texture, type BaseTexture,
  type UniformBuffer, type Scene, type AbstractEngine, type SubMesh,
} from "@babylonjs/core";
const directionalLightmapCode = `
#if defined(LIGHTMAP) && defined(BUMP) && defined(NORMAL)
if (directionalLightmapStrength > 0.0) {
    vec3 bakedMoment = texture2D(directionalLightmapSampler, vLightmapUV).rgb * 2.0 - 1.0;
    float momentLength = length(bakedMoment);
    float directionality = smoothstep(0.01, 0.05, momentLength);
    vec3 worldMoment = (directionalLightmapWorld * vec4(bakedMoment, 0.0)).xyz;
    vec3 lightDirection = worldMoment / max(length(worldMoment), 0.0001);
    float baseResponse = max(dot(lightDirection, normalize(geometricNormalW)), 0.2);
    float normalResponse = max(dot(lightDirection, normalW), 0.2);
    float response = min(normalResponse / baseResponse, 4.0);
    lightmapColor.rgb *= mix(1.0, response, directionality * directionalLightmapStrength);
}
#endif
`;

export class DirectionalLightmapPlugin extends MaterialPluginBase {
  strength = 1;
  private texture: Texture;

  constructor(material: PBRMaterial, texture: Texture) {
    super(material, "DirectionalLightmap", 200, {}, true, true);
    this.texture = texture;
    this.doNotSerialize = true;
  }

  isCompatible() { return true; }

  getClassName() { return "DirectionalLightmapPlugin"; }
  isReadyForSubMesh() { return this.texture.isReady(); }
  getSamplers(samplers: string[]) { samplers.push("directionalLightmapSampler"); }
  getActiveTextures(textures: BaseTexture[]) { textures.push(this.texture); }
  hasTexture(texture: BaseTexture) { return texture === this.texture; }

  getUniforms(language?: ShaderLanguage) {
    return {
      ubo: [
        { name: "directionalLightmapStrength", size: 1, type: "float" },
        { name: "directionalLightmapWorld", size: 16, type: "mat4" },
      ],
      fragment: language === ShaderLanguage.WGSL ? "" : `#ifndef UNIFORMBUFFERS
        uniform float directionalLightmapStrength;
        uniform mat4 directionalLightmapWorld;
      #endif`,
    };
  }

  bindForSubMesh(buffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh) {
    buffer.updateFloat("directionalLightmapStrength", this.strength);
    buffer.updateMatrix("directionalLightmapWorld", subMesh.getRenderingMesh().getWorldMatrix());
    buffer.setTexture("directionalLightmapSampler", this.texture);
  }

  getCustomCode(shaderType: string, language?: ShaderLanguage) {
    if (shaderType !== "fragment") return null;
    if (language === ShaderLanguage.WGSL) return {
      CUSTOM_FRAGMENT_DEFINITIONS: "var directionalLightmapSampler: texture_2d<f32>; var directionalLightmapSamplerSampler: sampler;",
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: directionalLightmapCode
        .replace(
          "lightmapColor.rgb *= mix(1.0, response, directionality * directionalLightmapStrength);",
          "lightmapColor = vec4f(lightmapColor.rgb * mix(1.0, response, directionality * directionalLightmapStrength), lightmapColor.a);")
        .replace(/vec3 /g, "var ").replace(/float /g, "var ")
        .replace("texture2D(directionalLightmapSampler, vLightmapUV)", "textureSample(directionalLightmapSampler, directionalLightmapSamplerSampler, fragmentInputs.vLightmapUV)")
        .replace(/directionalLightmapStrength/g, "uniforms.directionalLightmapStrength")
        .replace(/directionalLightmapWorld/g, "uniforms.directionalLightmapWorld")
        .replace("vec4(", "vec4f("),
    };
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: "uniform sampler2D directionalLightmapSampler;",
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: directionalLightmapCode,
    };
  }
}
