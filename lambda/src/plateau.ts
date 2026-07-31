import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { LatLng } from './types.js';
import type { BuildingPolygon } from './accessibility.js';

/**
 * PLATEAU（国土交通省 3D都市モデル）の建物ベクトルタイルを取得・デコードし、
 * 視線判定用の建物ポリゴン（実測高さ measuredHeight 付き）を返す。
 *
 * 利用者: line-of-sight.ts（PLATEAU を優先し、圏外では OSM にフォールバック）。
 *
 * 前提・制約:
 * - タイルは東京23区のみのコミュニティ配信（indigo-lab）。23区外は 404 となり、
 *   その場合 cachedBuildings は null（＝未取得）のままで、呼び出し側は OSM を使う。
 * - 建物ポリゴンは OSM と同じ BuildingPolygon 形式に正規化するため、
 *   line-of-sight.ts のポリゴン交差判定をそのまま流用できる。
 */

const PLATEAU_TILE_BASE =
  'https://indigo-lab.github.io/plateau-tokyo23ku-building-mvt-2020';
const BLDG_SOURCE_LAYER = 'bldg';
/** タイルズーム。z14 は約2.4km四方/タイルで、半径数kmを数枚でカバーできる */
const TILE_ZOOM = 14;
/** measuredHeight 欠損時のデフォルト高さ（OSM のデフォルトに合わせる） */
const DEFAULT_HEIGHT = 8;
const FETCH_TIMEOUT_MS = 5000;
/** 取得タイル数の上限（半径3km・z14 でも 3x3 程度に収まる想定の安全弁） */
const MAX_TILES = 16;

/** null = 未取得（圏外含む）、[] = 取得済みで建物なし */
let cachedBuildings: BuildingPolygon[] | null = null;

/**
 * キャッシュ済み PLATEAU 建物を返す。
 * null = 未取得（圏外/取得失敗）→ 呼び出し側は OSM にフォールバックする。
 */
export function getCachedPlateauBuildings(): BuildingPolygon[] | null {
  return cachedBuildings;
}

export function clearPlateauCache(): void {
  cachedBuildings = null;
}

// --- タイル座標変換（Web メルカトル） ---

function lngToTileX(lng: number, z: number): number {
  return ((lng + 180) / 360) * Math.pow(2, z);
}

function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z);
}

function tileXToLng(x: number, z: number): number {
  return (x / Math.pow(2, z)) * 360 - 180;
}

function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * 1タイルを取得・デコードして建物ポリゴン配列に変換する。
 * @returns 建物配列（空配列 = 建物なし）／null = フェッチ失敗・圏外(404)
 */
async function loadTile(
  tileX: number,
  tileY: number,
  signal: AbortSignal,
): Promise<BuildingPolygon[] | null> {
  const url = `${PLATEAU_TILE_BASE}/${TILE_ZOOM}/${tileX}/${tileY}.pbf`;

  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const buffer = new Uint8Array(await response.arrayBuffer());
  const layer = new VectorTile(new PbfReader(buffer)).layers[BLDG_SOURCE_LAYER];
  if (!layer) return [];

  const extent = layer.extent;
  const buildings: BuildingPolygon[] = [];

  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== 3) continue; // ポリゴンのみ

    const rawHeight = feature.properties['measuredHeight'];
    const height = typeof rawHeight === 'number' && rawHeight > 0 ? rawHeight : DEFAULT_HEIGHT;

    // 建物は複数リング（外周＋穴）を持ちうるが、視線遮蔽では各リングを
    // 個別ポリゴンとして扱えば十分（穴は遮蔽判定に実害なし）
    for (const ring of feature.loadGeometry()) {
      if (ring.length < 3) continue;

      const coords: [number, number][] = [];
      let minLng = Infinity, maxLng = -Infinity;
      let minLat = Infinity, maxLat = -Infinity;

      for (const pt of ring) {
        const lng = tileXToLng(tileX + pt.x / extent, TILE_ZOOM);
        const lat = tileYToLat(tileY + pt.y / extent, TILE_ZOOM);
        coords.push([lng, lat]);
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }

      buildings.push({ coords, height, minLng, maxLng, minLat, maxLat });
    }
  }

  return buildings;
}

/**
 * bbox をカバーする全タイルを取得し、cachedBuildings を更新する。
 * 全タイルが取得失敗（圏外/タイムアウト）なら cachedBuildings = null のまま。
 */
async function loadBbox(
  west: number,
  south: number,
  east: number,
  north: number,
): Promise<void> {
  const xMin = Math.floor(lngToTileX(west, TILE_ZOOM));
  const xMax = Math.floor(lngToTileX(east, TILE_ZOOM));
  // 緯度は北ほど y が小さい
  const yMin = Math.floor(latToTileY(north, TILE_ZOOM));
  const yMax = Math.floor(latToTileY(south, TILE_ZOOM));

  const tiles: { x: number; y: number }[] = [];
  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) {
      tiles.push({ x, y });
      if (tiles.length >= MAX_TILES) break;
    }
    if (tiles.length >= MAX_TILES) break;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const results = await Promise.all(
      tiles.map((t) => loadTile(t.x, t.y, controller.signal)),
    );

    const merged: BuildingPolygon[] = [];
    let anyLoaded = false;
    for (const r of results) {
      if (r === null) continue; // 取得失敗・圏外
      anyLoaded = true;
      merged.push(...r);
    }

    // bbox 外へはみ出した建物を除去（タイルは bbox より広い）
    cachedBuildings = anyLoaded
      ? merged.filter(
          (b) => b.maxLng >= west && b.minLng <= east && b.maxLat >= south && b.minLat <= north,
        )
      : null;

    console.log(
      cachedBuildings === null
        ? 'PLATEAU: no coverage (falling back to OSM)'
        : `PLATEAU: ${cachedBuildings.length} buildings from ${tiles.length} tiles`,
    );
  } catch (err) {
    console.warn('PLATEAU fetch failed:', err);
    cachedBuildings = null;
  } finally {
    clearTimeout(timeout);
  }
}

/** 中心＋半径のエリアを取得（analyze 用） */
export async function fetchPlateauBuildings(
  center: LatLng,
  radiusMeters: number,
): Promise<void> {
  // メートル→度の概算（緯度1度≈111km）
  const dLat = radiusMeters / 111000;
  const dLng = radiusMeters / (111000 * Math.cos((center.lat * Math.PI) / 180));
  await loadBbox(center.lng - dLng, center.lat - dLat, center.lng + dLng, center.lat + dLat);
}

/** 2点間コリドーを取得（score-point 用） */
export async function fetchPlateauBuildingsCorridor(
  from: LatLng,
  to: LatLng,
  bufferDeg: number = 0.001,
): Promise<void> {
  const west = Math.min(from.lng, to.lng) - bufferDeg;
  const east = Math.max(from.lng, to.lng) + bufferDeg;
  const south = Math.min(from.lat, to.lat) - bufferDeg;
  const north = Math.max(from.lat, to.lat) + bufferDeg;
  await loadBbox(west, south, east, north);
}
