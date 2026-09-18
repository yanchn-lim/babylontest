export const TRANSFER_PAGE_BYTES = 128 * 1024 * 1024;

export interface TransferPage { firstRow: number; lastRow: number; entryStart: number; entryEnd: number }

/** Keep complete rows, including empty rows, in their original order. */
export function splitTransferPages(offsets: Uint32Array, pageBytes = TRANSFER_PAGE_BYTES): TransferPage[] {
  if (!Number.isInteger(pageBytes) || pageBytes < 4 || pageBytes > TRANSFER_PAGE_BYTES || pageBytes % 4) throw Error('Invalid transfer page size.');
  if (offsets.length < 2 || offsets[0] !== 0) throw Error('Invalid transfer page offsets.');
  const capacity = pageBytes / 4, pages: TransferPage[] = [];
  let firstRow = 0;
  for (let row = 0; row < offsets.length - 1; row++) {
    const count = offsets[row + 1] - offsets[row];
    if (count < 0 || count > capacity) throw Error('A transfer row exceeds its page capacity.');
    if (offsets[row + 1] - offsets[firstRow] > capacity) {
      pages.push({ firstRow, lastRow: row, entryStart: offsets[firstRow], entryEnd: offsets[row] });
      firstRow = row;
    }
  }
  pages.push({ firstRow, lastRow: offsets.length - 1, entryStart: offsets[firstRow], entryEnd: offsets[offsets.length - 1] });
  return pages;
}

export function transferPageOffsets(offsets: Uint32Array, page: TransferPage) {
  return offsets.slice(page.firstRow, page.lastRow + 1).map(value => value - page.entryStart);
}

/** Adapt only the display shader. Canonical preparation source and cache hashes stay unchanged. */
export function pagedTransferSource(source: string, repaired: boolean) {
  const gather = source.match(/fn gatherTransfer\(@builtin\(global_invocation_id\) id:vec3u\) \{[\s\S]*?\n\}/)?.[0];
  if (!gather) throw Error('Missing transfer gather kernel.');
  let paged = gather;
  if (!repaired) paged = paged.replace('let surface=surfaces[id.x];', 'let index=id.x; let surface=surfaces[index];');
  paged = paged.replace('let surface=surfaces[index];', `
  if(index<u32(params.range.x)||index>=u32(params.range.y)){return;}
  let surface=surfaces[index];`)
    .replace(repaired ? 'entry=offsets[index];entry<offsets[index+1u]' : 'entry=offsets[id.x];entry<offsets[id.x+1u]',
      'entry=offsets[index-u32(params.range.x)];entry<offsets[index-u32(params.range.x)+1u]');
  return source.replace(gather, paged) + `
// Publish only after every page completes the final bounce.
@compute @workgroup_size(64)
fn publishTransfer(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=u32(params.update.y)){return;}
  let size=u32(params.sky.w);
  textureStore(output,vec2u(id.x%size,id.x/size),vec4f(bounceLight[id.x].total.rgb,1));
}
`;
}
