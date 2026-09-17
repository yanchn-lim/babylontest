import type { SceneData } from './main';
import helpers from './sample-repair.wgsl?raw';

export function repairShader(shader: string) {
  return shader.replace(/\r\n/g, '\n')
    .replace('let surface=surfaces[id.x]; var radiance=vec3f(0);', 'let index=id.x; let surface=surfaces[index]; var radiance=vec3f(0);')
    .replace('fn trace(origin:vec3f, direction:vec3f, limit:f32)->Hit {',
      'fn traceMinimum(origin:vec3f, direction:vec3f, limit:f32, minimum:f32)->Hit {')
    .replace('if(t>.001&&t<hit.distance)', 'if(t>minimum&&t<hit.distance)')
    .replaceAll('let origin=surface.position.xyz+surface.normal.xyz*.004;', 'let origin=rayOrigins[index].xyz;')
    .replaceAll('trace(origin,hemisphere(surface.normal.xyz,ray,SKY_RAYS),24.0)',
      'traceMinimum(origin,hemisphere(surface.normal.xyz,ray,SKY_RAYS),24.0,rayOrigins[index].w)')
    .replace(/length\((delta[01]?)\)-\.004/g, 'length($1)-rayOrigins[index].w')
    .replaceAll('trace(surface.position.xyz+surface.normal.xyz*.004,params.sun.xyz,24.0)',
      'traceMinimum(rayOrigins[id.x].xyz,params.sun.xyz,24.0,rayOrigins[id.x].w)')
    .replaceAll('select(0xffffffffu,hit.pixel,hit.facing>0.0)',
      'select(select(0xffffffffu,0xfffffffeu,hit.facing<0.0),hit.pixel,hit.facing>0.0)')
    .replace('let surface=surfaces[id.x];\n  var radiance=vec3f(0);',
      'let index=sampleRemap[id.x]; let surface=surfaces[index];\n  var radiance=vec3f(0);')
    .replace('entry=offsets[id.x];entry<offsets[id.x+1u]', 'entry=offsets[index];entry<offsets[index+1u]')
    .replace('surfaceLight[packed&65535u].radiance.rgb', 'surfaceLight[sampleRemap[packed&65535u]].radiance.rgb')
    .replace('params.sky.rgb*surfaceLight[id.x].visibility.x', 'params.sky.rgb*surfaceLight[index].visibility.x')
    + '\n' + helpers;
}

/** Fill only from nearby, already-valid samples on the same lighting chart. */
export function repairSamples(data: SceneData, surfaces: Float32Array, sampleFaces: Int32Array, backfaces: Uint16Array) {
  const mesh = data.meshes[data.sampleRepair!.mesh];
  const parents = Array.from({ length: mesh.indices.length / 3 }, (_, i) => i);
  const root = (i: number): number => parents[i] === i ? i : parents[i] = root(parents[i]);
  const edges = new Map<string, number>();
  const vertex = (i: number) => [...mesh.positions.slice(i * 3, i * 3 + 3), ...mesh.uvs.slice(i * 2, i * 2 + 2)]
    .map(v => v.toFixed(6)).join(',');
  for (let face = 0; face < parents.length; face++) {
    const ids = mesh.indices.slice(face * 3, face * 3 + 3).map(vertex);
    for (let j = 0; j < 3; j++) {
      const edge = [ids[j], ids[(j + 1) % 3]].sort().join('/');
      if (edges.has(edge)) parents[root(face)] = root(edges.get(edge)!);
      else edges.set(edge, face);
    }
  }
  const candidates = new Map<number, number[]>();
  for (let i = 0; i < sampleFaces.length; i++) {
    if (sampleFaces[i] < 0 || backfaces[i] > 1024 * .05) continue;
    const chart = root(sampleFaces[i]);
    if (!candidates.has(chart)) candidates.set(chart, []);
    candidates.get(chart)!.push(i);
  }
  const remap = Array.from(sampleFaces, (_, i) => i);
  for (let i = 0; i < sampleFaces.length; i++) {
    if (sampleFaces[i] < 0 || backfaces[i] <= 1024 * .25) continue;
    let best = .06 ** 2;
    for (const j of candidates.get(root(sampleFaces[i])) || []) {
      let distance = 0, dot = 0;
      for (let k = 0; k < 3; k++) {
        distance += (surfaces[i * 12 + k] - surfaces[j * 12 + k]) ** 2;
        dot += surfaces[i * 12 + 4 + k] * surfaces[j * 12 + 4 + k];
      }
      if (distance >= best || dot < .8) continue;
      best = distance; remap[i] = j;
    }
  }
  return remap;
}
