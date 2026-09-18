import { MaterialPluginBase, ShaderLanguage, type PBRMaterial, type UniformBuffer, type AbstractMesh, type Scene, type AbstractEngine, type SubMesh } from '@babylonjs/core';
import type { ReflectionBox } from './reflection-boxes';

/** Local probe visibility against verified nearby boxes; not a reflected-light trace. */
export class LocalSpecularOcclusion extends MaterialPluginBase {
  constructor(material: PBRMaterial, private boxes: ReflectionBox[] | ((mesh: AbstractMesh) => ReflectionBox[])) {
    super(material, 'LocalSpecularOcclusion', 230, { LOCAL_SPECULAR_BOXES: 8 }, true, true);
  }
  updateBoxes(boxes: (mesh: AbstractMesh) => ReflectionBox[]) { this.boxes = boxes; }
  isCompatible() { return true; }
  getUniforms(language?: ShaderLanguage) {
    const names = Array.from({ length: 8 }, (_, i) => ['specularBoxMin' + i, 'specularBoxMax' + i]).flat();
    return { ubo: [{ name: 'specularBoxCount', size: 1, type: 'float' }, ...names.map(name => ({ name, size: 3, type: 'vec3' }))],
      fragment: language === ShaderLanguage.WGSL ? '' : '#ifndef UNIFORMBUFFERS\nuniform float specularBoxCount;\n' + names.map(name => `uniform vec3 ${name};`).join('\n') + '\n#endif' };
  }
  bindForSubMesh(buffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh) {
    const boxes = (typeof this.boxes === 'function' ? this.boxes(subMesh.getRenderingMesh()) : this.boxes).slice(0, 8);
    buffer.updateFloat('specularBoxCount', boxes.length);
    boxes.forEach((box, i) => {
      buffer.updateFloat3('specularBoxMin' + i, box.min[0], box.min[1], box.min[2]);
      buffer.updateFloat3('specularBoxMax' + i, box.max[0], box.max[1], box.max[2]);
    });
  }
  getCustomCode(type: string, language?: ShaderLanguage) {
    if (type !== 'fragment') return null;
    const wgsl = language === ShaderLanguage.WGSL;
    const scalar = wgsl ? 'f32' : 'float', v2 = wgsl ? 'vec2f' : 'vec2', v3 = wgsl ? 'vec3f' : 'vec3';
    const decl = (name: string, type: string, value: string) => wgsl ? `var ${name}: ${type} = ${value};` : `${type} ${name} = ${value};`;
    const fn = (name: string, args: [string, string][], result: string) => wgsl
      ? `fn ${name}(${args.map(([name, type]) => `${name}: ${type}`).join(', ')}) -> ${result}`
      : `${result} ${name}(${args.map(([name, type]) => `${type} ${name}`).join(', ')})`;
    const uniform = wgsl ? 'uniforms.' : '';
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `
        ${fn('specularBoxDistance', [['origin', v3], ['ray', v3], ['lo', v3], ['hi', v3]], scalar)} {
          ${decl('safeRay', v3, `mix(${v3}(-1.0), ${v3}(1.0), step(${v3}(0.0), ray)) * max(abs(ray), ${v3}(0.000001))`)}
          ${decl('a', v3, '(lo - origin) / safeRay')}
          ${decl('b', v3, '(hi - origin) / safeRay')}
          ${decl('near', v3, 'min(a, b)')}
          ${decl('far', v3, 'max(a, b)')}
          ${decl('entry', scalar, 'max(0.0, max(near.x, max(near.y, near.z)))')}
          if (min(far.x, min(far.y, far.z)) < entry) { return 1.5; }
          return entry;
        }
        ${fn('localSpecularVisibility', [['position', v3], ['normal', v3], ['view', v3], ['rough', scalar], ['f0', scalar]], scalar)} {
          if (${uniform}specularBoxCount < 0.5) { return 1.0; }
          ${decl('helper', v3, `${v3}(0.0, 1.0, 0.0)`)}
          if (abs(normal.y) > 0.9) { helper = ${v3}(1.0, 0.0, 0.0); }
          ${decl('tangent', v3, 'normalize(cross(helper, normal))')}
          ${decl('bitangent', v3, 'cross(normal, tangent)')}
          ${decl('alpha', scalar, 'max(0.001, rough * rough)')}
          ${decl('viewLocal', v3, `${v3}(dot(view, tangent), dot(view, bitangent), max(0.0001, dot(view, normal)))`)}
          // GGX visible-normal sampling: concentrate directions on the visible specular lobe.
          ${decl('stretched', v3, `normalize(${v3}(alpha * viewLocal.xy, viewLocal.z))`)}
          ${decl('axis1', v3, `${v3}(1.0, 0.0, 0.0)`)}
          if (dot(stretched.xy, stretched.xy) > 0.000001) { axis1 = normalize(${v3}(-stretched.y, stretched.x, 0.0)); }
          ${decl('axis2', v3, 'cross(stretched, axis1)')}
          ${decl('origin', v3, 'position + normal * 0.0005')}
          ${decl('visible', scalar, '0.0')}
          ${decl('total', scalar, '0.0')}
          ${wgsl ? 'for (var i = 0; i < 32; i++)' : 'for (int i = 0; i < 32; i++)'} {
            ${decl('radius', scalar, `sqrt((${scalar}(i) + 0.5) / 32.0)`)}
            ${decl('phi', scalar, `${scalar}(i) * 2.39996322973`)}
            ${decl('disk', v2, `radius * ${v2}(cos(phi), sin(phi))`)}
            disk.y = mix(sqrt(max(0.0, 1.0 - disk.x * disk.x)), disk.y, 0.5 * (1.0 + stretched.z));
            ${decl('projected', v3, 'disk.x * axis1 + disk.y * axis2 + sqrt(max(0.0, 1.0 - dot(disk, disk))) * stretched')}
            ${decl('halfLocal', v3, `normalize(${v3}(alpha * projected.xy, max(0.0, projected.z)))`)}
            ${decl('halfVector', v3, 'tangent * halfLocal.x + bitangent * halfLocal.y + normal * halfLocal.z')}
            ${decl('ray', v3, 'reflect(-view, halfVector)')}
            ${decl('facing', scalar, 'dot(normal, ray)')}
            if (facing <= 0.0) { continue; }
            ${decl('fresnel', scalar, 'f0 + (1.0 - f0) * pow(1.0 - clamp(dot(view, halfVector), 0.0, 1.0), 5.0)')}
            ${decl('weight', scalar, 'fresnel * 2.0 * facing / (facing + sqrt(alpha * alpha + (1.0 - alpha * alpha) * facing * facing))')}
            ${decl('distance', scalar, '1.5')}
            ${Array.from({ length: 8 }, (_, i) => `if (${uniform}specularBoxCount > ${i}.0) { distance = min(distance, specularBoxDistance(origin, ray, ${uniform}specularBoxMin${i}, ${uniform}specularBoxMax${i})); }`).join('\n')}
            // Only suppress nearby blockers; fade out at the local query's range.
            visible += weight * smoothstep(1.0, 1.5, distance);
            total += weight;
          }
          if (total < 0.000001) { return 1.0; }
          return clamp(visible / total, 0.0, 1.0);
        }`,
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
        #if defined(REFLECTION) && !defined(UNLIT)
        // Apply after probe blending and BRDF weighting; direct highlights stay unchanged.
        if (${uniform}vLightingIntensity.z > 0.0) { finalRadianceScaled *= localSpecularVisibility(${wgsl ? 'fragmentInputs.' : ''}vPositionW, normalW, viewDirectionW, roughness, reflectivityOut.reflectanceF0); }
        #endif`,
    };
  }
}
