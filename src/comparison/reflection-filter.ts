import { MaterialPluginBase, ShaderLanguage, type PBRMaterial } from '@babylonjs/core';

/** Aim a rough reflection at the GGX lobe's dominant direction, not its mirror ray. */
export class LocalReflectionFilter extends MaterialPluginBase {
  constructor(material: PBRMaterial) {
    super(material, 'LocalReflectionFilter', 210, {}, true, true);
  }
  isCompatible() { return true; }
  getCustomCode(type: string, language?: ShaderLanguage) {
    if (type !== 'fragment') return null;
    const wgsl = language === ShaderLanguage.WGSL;
    const declare = (name: string, type: string, value: string) => wgsl
      ? `let ${name}: ${type} = ${value};` : `${type} ${name} = ${value};`;
    const scalar = wgsl ? 'f32' : 'float', vector = wgsl ? 'vec3f' : 'vec3';
    const position = wgsl ? 'fragmentInputs.vPositionW' : 'vPositionW';
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `
        ${wgsl ? 'fn localReflectionNormal(normal: vec3f, view: vec3f, rough: f32) -> vec3f'
          : 'vec3 localReflectionNormal(vec3 normal, vec3 view, float rough)'} {
          // Frostbite/HDRP dominant direction, including the grazing-angle adjustment.
          ${declare('slope', scalar, 'rough * rough')}
          ${declare('smoothness', scalar, '1.0 - slope')}
          ${declare('facing', scalar, 'clamp(dot(normal, view), 0.0, 1.0)')}
          ${declare('weight', scalar, '(sqrt(smoothness) + slope) * min(1.0, smoothness * smoothness + smoothness * facing * facing)')}
          ${declare('direction', vector, 'normalize(mix(normal, reflect(-view, normal), weight))')}
          ${declare('halfVector', vector, 'view + direction')}
          if (dot(halfVector, halfVector) < 0.000001) { return normal; }
          return normalize(halfVector);
        }`,
      // Only the cubemap lookup uses this normal. Keep the material's BRDF unchanged.
      '!reflectionOut=reflectionBlock\\(\\s*(?:fragmentInputs\\.)?vPositionW\\s*,normalW':
        `reflectionOut=reflectionBlock(${position},localReflectionNormal(normalW, viewDirectionW, roughness)`,
    };
  }
}
