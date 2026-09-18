import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitTransferPages, transferPageOffsets, TRANSFER_PAGE_BYTES } from '../src/comparison/transfer-pages.ts';

test('pages preserve complete rows, empty rows and connection order', () => {
  const offsets = Uint32Array.from([0,0,2,4,4,7,7,8,8]);
  const entries = Uint32Array.from([91,12,85,7,4,3,8,2]);
  const pages = splitTransferPages(offsets, 16);
  assert.deepEqual(pages.map(p => [p.firstRow,p.lastRow,p.entryStart,p.entryEnd]), [[0,4,0,4],[4,8,4,8]]);
  const rows = [];
  for (const page of pages) {
    const local = transferPageOffsets(offsets,page), values = entries.subarray(page.entryStart,page.entryEnd);
    assert.ok(values.byteLength <= 16);
    for (let i=0;i<local.length-1;i++) rows.push([...values.subarray(local[i],local[i+1])]);
  }
  assert.deepEqual(rows, Array.from({length:offsets.length-1},(_,i)=>[...entries.subarray(offsets[i],offsets[i+1])]));
});

test('large entry addresses remain exact without float conversion', () => {
  const capacity = TRANSFER_PAGE_BYTES / 4;
  const offsets = Uint32Array.from([0,capacity-1,capacity+2,capacity+1026]);
  const pages = splitTransferPages(offsets);
  assert.equal(pages.length,2);
  assert.deepEqual([...transferPageOffsets(offsets,pages[1])],[0,3,1027]);
  assert.equal(pages[1].entryStart,capacity-1);
});

test('empty caches and exact capacity stay in one page', () => {
  assert.deepEqual(splitTransferPages(Uint32Array.from([0,0,0]),4),[{firstRow:0,lastRow:2,entryStart:0,entryEnd:0}]);
  assert.equal(splitTransferPages(Uint32Array.from([0,1,4,4]),16).length,1);
});

test('reject invalid capacities and rows instead of dropping connections', () => {
  for (const size of [0,3,5,TRANSFER_PAGE_BYTES+4,Infinity]) assert.throws(()=>splitTransferPages(Uint32Array.from([0,1]),size));
  for (const offsets of [[],[0],[1,1],[0,5],[0,2,1]]) assert.throws(()=>splitTransferPages(Uint32Array.from(offsets),16));
});
