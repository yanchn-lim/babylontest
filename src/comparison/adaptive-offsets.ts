import helpers from './adaptive-offsets.wgsl?raw';

/** Opt-in shader variant; preserve the existing shaders and prepared caches. */
export function adaptiveOffsets(shader: string) {
  return shader
    .replace('fn trace(origin:vec3f, direction:vec3f, limit:f32)->Hit {',
      'fn traceMinimum(origin:vec3f, direction:vec3f, limit:f32, minimum:f32)->Hit {')
    .replace('if(t>.001&&t<hit.distance)', 'if(t>minimum&&t<hit.distance)')
    .replaceAll('let origin=surface.position.xyz+surface.normal.xyz*.004;',
      'let offset=surfaceOffset(surface); let origin=surface.position.xyz+surface.normal.xyz*offset;')
    .replaceAll('trace(origin,hemisphere(', 'traceSurface(origin,surface,hemisphere(')
    .replaceAll('trace(origin,normalize(', 'traceSurface(origin,surface,normalize(')
    .replace(/length\((delta[01]?)\)-\.004/g, 'length($1)-offset')
    .replaceAll('trace(surface.position.xyz+surface.normal.xyz*.004,params.sun.xyz,24.0)',
      'traceSurface(surface.position.xyz+surface.normal.xyz*surfaceOffset(surface),surface,params.sun.xyz,24.0)')
    + '\n' + helpers;
}
