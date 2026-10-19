import type { LatLng } from '../types.js';

/**
 * 国土地理院 DEM5A テキストタイルから標高データを取得する
 *
 * タイル仕様:
 * - URL: https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png
 * - テキスト版: https://cyberjapandata.gsi.go.jp/xyz/dem5a/{z}/{x}/{y}.txt
 * - ズームレベル15: 約1.2km四方/タイル
 * - 256x256グリッド、カンマ区切り
 * - "e" = データなし（河川・水面など）
 * - DEM5A が "e" の地点は DEM10B（レイヤー名 dem、z14 まで）で補う
 */

const TILE_SIZE = 256;
const ZOOM = 15;
const FALLBACK_ZOOM = 14;

type Grid = (number | null)[][];

const tileCache = new Map<string, Promise<Grid>>();

/**
 * 緯度経度からタイル内のピクセル座標を計算
 */
function latLngToPixel(
  lat: number,
  lng: number,
  zoom: number,
): { tileX: number; tileY: number; pixelX: number; pixelY: number } {
  const n = Math.pow(2, zoom);
  const xFloat = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yFloat =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    n;

  const tileX = Math.floor(xFloat);
  const tileY = Math.floor(yFloat);
  const pixelX = Math.floor((xFloat - tileX) * TILE_SIZE);
  const pixelY = Math.floor((yFloat - tileY) * TILE_SIZE);

  return { tileX, tileY, pixelX, pixelY };
}

/**
 * テキストデータをパースしてグリッドに変換
 */
function parseTextTile(text: string): (number | null)[][] {
  const rows = text.trim().split('\n');
  const grid: (number | null)[][] = [];
  for (const row of rows) {
    const cells = row.split(',').map((v) => {
      const trimmed = v.trim();
      if (trimmed === 'e' || trimmed === '') return null;
      const num = parseFloat(trimmed);
      return isNaN(num) ? null : num;
    });
    grid.push(cells);
  }
  return grid;
}

/** 8秒でタイムアウトし、失敗時は null で埋めたグリッドを返す */
async function loadTextTile(url: string): Promise<Grid> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseTextTile(await response.text());
  } catch {
    return Array.from({ length: TILE_SIZE }, () => Array(TILE_SIZE).fill(null));
  }
}

async function lookup(layer: string, zoom: number, lat: number, lng: number): Promise<number | null> {
  const { tileX, tileY, pixelX, pixelY } = latLngToPixel(lat, lng, zoom);
  const key = `${layer}/${zoom}/${tileX}/${tileY}`;
  // 結果ではなく Promise をキャッシュしないと、同じタイルへの並列呼び出しが
  // 取得完了前に全てキャッシュミスし、同一タイルを数百回取得・パースする
  let tile = tileCache.get(key);
  if (!tile) tileCache.set(key, (tile = loadTextTile(`https://cyberjapandata.gsi.go.jp/xyz/${key}.txt`)));
  return (await tile)[pixelY]?.[pixelX] ?? null;
}

/**
 * 指定の緯度経度の標高を取得
 * @returns 標高(m) or null（データなし）
 */
export async function getElevation(lat: number, lng: number): Promise<number | null> {
  return (await lookup('dem5a', ZOOM, lat, lng)) ?? lookup('dem', FALLBACK_ZOOM, lat, lng);
}

/**
 * 観覧候補地点の標高を DEM5A のみで取得する
 */
// DEM10B で補わないのは、DEM5A の "e"（河川・水面）を立てない地点として候補から外すため
export function getElevationBatch(points: LatLng[]): Promise<(number | null)[]> {
  return Promise.all(points.map((p) => lookup('dem5a', ZOOM, p.lat, p.lng)));
}
