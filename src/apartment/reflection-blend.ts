import { MaterialPluginBase, ShaderLanguage, type BaseTexture, type RenderTargetTexture, type PBRMaterial, type UniformBuffer } from '@babylonjs/core';

/** Meet at the shared hall capture, then fade to each room's local reflection. */
export class ApartmentReflectionBlend extends MaterialPluginBase {
  constructor(material: PBRMaterial, private bounds: number[], private hall: () => BaseTexture | null) {
    super(material, 'ApartmentReflectionBlend', 220, { APARTMENT_REFLECTION_BLEND: true }, true, true);
  }
  setBounds(bounds: number[]) { this.bounds = bounds; }
  isCompatible() { return true; }
  getSamplers(names: string[]) { names.push('boundaryReflection'); }
  getUniforms(language?: ShaderLanguage) {
    return { ubo: [
      { name: 'reflectionBounds', size: 4, type: 'vec4' },
      { name: 'boundaryPosition', size: 3, type: 'vec3' },
      { name: 'boundarySize', size: 3, type: 'vec3' },
      { name: 'boundaryReady', size: 1, type: 'float' },
    ], fragment: language === ShaderLanguage.WGSL ? '' : `#ifndef UNIFORMBUFFERS
      uniform vec4 reflectionBounds;
      uniform vec3 boundaryPosition;
      uniform vec3 boundarySize;
      uniform float boundaryReady;
      #endif` };
  }
  bindForSubMesh(buffer: UniformBuffer) {
    const texture = this.hall() as RenderTargetTexture | null;
    buffer.updateFloat4('reflectionBounds', this.bounds[0] ?? -1e20, this.bounds[1] ?? 1e20, this.bounds[2] ?? -1e20, this.bounds[3] ?? 1e20);
    buffer.updateFloat('boundaryReady', Number(!!texture));
    if (!texture) return;
    buffer.updateVector3('boundaryPosition', texture.boundingBoxPosition);
    buffer.updateVector3('boundarySize', texture.boundingBoxSize!);
    buffer.setTexture('boundaryReflection', texture);
  }
  getCustomCode(type: string, language?: ShaderLanguage) {
    if (type !== 'fragment') return null;
    const wgsl = language === ShaderLanguage.WGSL;
    const u = wgsl ? 'uniforms.' : '', position = wgsl ? 'fragmentInputs.vPositionW' : 'vPositionW';
    const declare = (name: string, type: string, value: string) => wgsl
      ? `var ${name}: ${type} = ${value};` : `${type} ${name} = ${value};`;
    const scalar = wgsl ? 'f32' : 'float', vector = wgsl ? 'vec3f' : 'vec3', color = wgsl ? 'vec4f' : 'vec4';
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `#if defined(REFLECTION) && defined(REFLECTIONMAP_3D) && defined(LODBASEDMICROSFURACE)
        ${wgsl ? 'var boundaryReflection: texture_cube<f32>; var boundaryReflectionSampler: sampler;'
          : 'uniform samplerCube boundaryReflection;'}
        #endif`,
      '!reflectionOut=reflectionBlock\\([\\s\\S]*?\\);': `$0
        #if defined(REFLECTIONMAP_3D) && defined(LODBASEDMICROSFURACE)
        ${declare('boundaryDistance', scalar, `min(min(${position}.x - ${u}reflectionBounds.x, ${u}reflectionBounds.y - ${position}.x), min(${position}.z - ${u}reflectionBounds.z, ${u}reflectionBounds.w - ${position}.z))`)}
        if (${u}boundaryReady > 0.5 && ${u}vLightingIntensity.z > 0.0 && boundaryDistance < 0.5) {
          ${declare('boundaryCoords', vector, `computeCubicLocalCoords(${color}(${position}, 1.0), localReflectionNormal(normalW, viewDirectionW, roughness), ${wgsl ? 'scene.' : ''}vEyePosition.xyz, ${u}reflectionMatrix, ${u}boundarySize, ${u}boundaryPosition)`)}
          #ifdef REFLECTIONMAP_OPPOSITEZ
          boundaryCoords.z *= -1.0;
          #endif
          ${declare('boundaryRadiance', color, `${color}(0.0)`)}
          ${wgsl ? 'boundaryRadiance = ' : ''}sampleReflectionTexture(
            alphaG, ${u}vReflectionMicrosurfaceInfos, ${u}vReflectionInfos, ${u}vReflectionColor
            #if defined(LODINREFLECTIONALPHA) && !defined(REFLECTIONMAP_SKYBOX)
            ,NdotVUnclamped
            #endif
            #ifdef LINEARSPECULARREFLECTION
            ,roughness
            #endif
            ,boundaryReflection${wgsl ? ',boundaryReflectionSampler' : ''},boundaryCoords
            #ifdef REALTIME_FILTERING
            ,${u}vReflectionFilteringInfo
            #endif
            ${wgsl ? '' : ',boundaryRadiance'}
          );
          reflectionOut.environmentRadiance = mix(boundaryRadiance, reflectionOut.environmentRadiance, smoothstep(0.0, 0.5, boundaryDistance));
        }
        #endif`,
    };
  }
}
