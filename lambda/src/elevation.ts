import type { LatLng, TileCoord } from './types.js';

/**
 * 国土地理院 DEM5A テキストタイルから標高データを取得する
 *
 * タイル仕様:
 * - URL: https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png
 * - テキスト版: https://cyberjapandata.gsi.go.jp/xyz/dem5a/{z}/{x}/{y}.txt
 * - ズームレベル15: 約1.2km四方/タイル
 * - 256x256グリッド、カンマ区切り
 * - "e" = データなし
 */

const TILE_SIZE = 256;
const ZOOM = 15;

/** タイルデータのキャッシュ */
const tileCache = new Map<string, (number | null)[][]>();

/**
 * 緯度経度からタイル座標を計算
 */
function latLngToTile(lat: number, lng: number, zoom: number): TileCoord {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      n,
  );
  return { z: zoom, x, y };
}

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
 * テキストタイルをフェッチしてパース
 */
async function fetchTextTile(
  coord: TileCoord,
): Promise<(number | null)[][]> {
  const key = `${coord.z}/${coord.x}/${coord.y}`;
  const cached = tileCache.get(key);
  if (cached) return cached;

  // DEM5A を試し、なければ DEM10B にフォールバック
  const urls = [
    `https://cyberjapandata.gsi.go.jp/xyz/dem5a/${key}.txt`,
    `https://cyberjapandata.gsi.go.jp/xyz/dem10b/${key}.txt`,
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;

      const text = await response.text();
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

      tileCache.set(key, grid);
      return grid;
    } catch {
      continue;
    }
  }

  // データなしの場合は null で埋めたグリッドを返す
  const emptyGrid: (number | null)[][] = Array.from(
    { length: TILE_SIZE },
    () => Array(TILE_SIZE).fill(null),
  );
  tileCache.set(key, emptyGrid);
  return emptyGrid;
}

/**
 * 指定の緯度経度の標高を取得
 * @returns 標高(m) or null（データなし）
 */
export async function getElevation(lat: number, lng: number): Promise<number | null> {
  const { tileX, tileY, pixelX, pixelY } = latLngToPixel(lat, lng, ZOOM);
  const grid = await fetchTextTile({ z: ZOOM, x: tileX, y: tileY });

  if (pixelY >= 0 && pixelY < grid.length && pixelX >= 0 && pixelX < grid[pixelY].length) {
    return grid[pixelY][pixelX];
  }

  return null;
}

/**
 * 複数地点の標高をバッチ取得（タイル単位でまとめてフェッチ）
 */
export async function getElevationBatch(
  points: LatLng[],
): Promise<(number | null)[]> {
  // 必要なタイルを特定してプリフェッチ
  const tileSet = new Set<string>();
  for (const p of points) {
    const { tileX, tileY } = latLngToPixel(p.lat, p.lng, ZOOM);
    tileSet.add(`${ZOOM}/${tileX}/${tileY}`);
  }

  // 全タイルを並列フェッチ
  const tilePromises = [...tileSet].map((key) => {
    const [z, x, y] = key.split('/').map(Number);
    return fetchTextTile({ z, x, y });
  });
  await Promise.all(tilePromises);

  // キャッシュ済みのタイルから標高を取得
  const results: (number | null)[] = [];
  for (const p of points) {
    results.push(await getElevation(p.lat, p.lng));
  }

  return results;
}

/**
 * タイルキャッシュをクリア（Lambda の次の呼び出し用）
 */
export function clearTileCache(): void {
  tileCache.clear();
}
