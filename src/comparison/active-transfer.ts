import type { SceneData } from './main';
import { transferSourceFor } from './transfer-data';

/** Keep the reference ray order and visibility math; share each sample across 64 lanes. */
export function activeTransferSource(data: SceneData) {
  const source = transferSourceFor(data);
  const prepare = source.match(/fn prepareTransfer\(@builtin\(global_invocation_id\) id:vec3u\) \{[\s\S]*?\n\}/)?.[0];
  if (!prepare) throw Error('Missing reference preparation kernel.');
  const active = prepare
    .replace('fn prepareTransfer(@builtin(global_invocation_id) id:vec3u)',
      'fn prepareActiveTransfer(@builtin(workgroup_id) id:vec3u, @builtin(local_invocation_index) lane:u32)')
    .replace('let index=id.x+u32(params.update.x);', 'let index=activeIndices[id.x+u32(params.update.x)];')
    .replace('if(surface.position.w==0.0){return;}', '')
    .replace('var open=0.0;', 'var open=0u;')
    .replace('ray=0u;ray<SKY_RAYS;ray++', 'ray=lane;ray<SKY_RAYS;ray+=64u')
    .replace('open+=select(0.0,1.0,hit.facing==0.0);', 'open+=select(0u,1u,hit.facing==0.0);')
    .replace(/\n  (let delta0|var visible)/, `
  openCounts[lane]=open;
  workgroupBarrier();
  if(lane!=0u){return;}
  open=0u;
  for(var i=0u;i<64u;i++){open+=openCounts[i];}
  $1`)
    .replace('open/f32(SKY_RAYS)', 'f32(open)/f32(SKY_RAYS)');
  return source + `
@group(0) @binding(14) var<storage,read> activeIndices:array<u32>;
var<workgroup> openCounts:array<u32,64>;
@compute @workgroup_size(64)
` + active;
}
