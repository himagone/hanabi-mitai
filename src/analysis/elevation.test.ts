import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getElevation, getElevationBatch } from './elevation.js';

const requested: string[] = [];
const row = (v: string) => Array(256).fill(v).join(',');
globalThis.fetch = (async (url: string) => {
  requested.push(url);
  const body = Array(256).fill(row(url.includes('/dem5a/') ? 'e' : '3.50')).join('\n');
  return new Response(body);
}) as typeof fetch;

test('並列に同じタイルを要求しても取得はレイヤーごとに1回', async () => {
  const points = Array.from({ length: 200 }, (_, i) => getElevation(35.73 + i * 1e-6, 139.83));
  await Promise.all(points);
  assert.equal(requested.filter((u) => u.includes('/dem5a/')).length, 1);
  assert.equal(requested.filter((u) => u.includes('/dem/')).length, 1);
});

test('DEM5A が e の地点は DEM10B(dem z14) の値を返す', async () => {
  assert.equal(await getElevation(35.73, 139.83), 3.5);
  assert.ok(requested.some((u) => u.includes('/xyz/dem/14/')));
});

test('観覧候補の標高は DEM5A が e なら null のまま', async () => {
  assert.deepEqual(await getElevationBatch([{ lat: 35.73, lng: 139.83 }]), [null]);
});
