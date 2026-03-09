import type { LatLng } from './types.js';

/**
 * OpenStreetMap の Overpass API から土地利用データ＋建物データを取得し、
 * 1. 各地点が「公共のアクセス可能な場所か」を判定
 * 2. 各地点にある建物の高さを返す
 */

interface LandUsePolygon {
  type: 'park' | 'residential';
  coords: [number, number][]; // [lng, lat][]
}

export interface BuildingPolygon {
  coords: [number, number][]; // [lng, lat][]
  height: number; // メートル
  // バウンディングボックス（高速フィルタ用）
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
}

/**
 * キャッシュ済み建物データを返す
 */
export function getCachedBuildings(): BuildingPolygon[] {
  return cachedBuildings ?? [];
}

let cachedLandUse: LandUsePolygon[] | null = null;
let cachedBuildings: BuildingPolygon[] | null = null;
let cachedCenter: { lat: number; lng: number } | null = null;
let cachedRadius: number = 0;

/**
 * Ray casting で点がポリゴン内にあるか判定
 */
function pointInPolygon(lng: number, lat: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    if (
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * OSM タグから建物の高さ（m）を推定
 */
function estimateBuildingHeight(tags: Record<string, string>): number {
  // 明示的な高さタグ
  if (tags.height) {
    const h = parseFloat(tags.height);
    if (!isNaN(h)) return h;
  }

  // 階数から推定（1階 = 約3m）
  const levels = tags['building:levels'];
  if (levels) {
    const n = parseInt(levels, 10);
    if (!isNaN(n)) return n * 3;
  }

  // タグなしの場合、建物タイプに応じたデフォルト
  const type = tags.building;
  switch (type) {
    case 'apartments':
    case 'residential':
      return 10; // 3〜4階建て想定
    case 'house':
    case 'detached':
      return 7; // 2階建て想定
    case 'commercial':
    case 'office':
      return 15;
    case 'industrial':
    case 'warehouse':
      return 8;
    case 'garage':
    case 'garages':
      return 3;
    default:
      return 8; // 一般的な建物のデフォルト
  }
}

/**
 * Overpass API から土地利用 + 建物データを取得
 */
export async function fetchLandUseAndBuildings(
  center: LatLng,
  radiusMeters: number,
): Promise<void> {
  // キャッシュが有効な場合はスキップ（同じエリア内 500m 以内）
  if (
    cachedCenter &&
    cachedLandUse !== null &&
    cachedBuildings !== null &&
    radiusMeters <= cachedRadius &&
    Math.abs(center.lat - cachedCenter.lat) < 0.005 &&
    Math.abs(center.lng - cachedCenter.lng) < 0.005
  ) {
    return;
  }

  const query = `
[out:json][timeout:30];
(
  way["landuse"="residential"](around:${radiusMeters},${center.lat},${center.lng});
  relation["landuse"="residential"](around:${radiusMeters},${center.lat},${center.lng});
  way["leisure"="park"](around:${radiusMeters},${center.lat},${center.lng});
  relation["leisure"="park"](around:${radiusMeters},${center.lat},${center.lng});
  way["leisure"="garden"](around:${radiusMeters},${center.lat},${center.lng});
  way["landuse"="grass"](around:${radiusMeters},${center.lat},${center.lng});
  way["leisure"="pitch"](around:${radiusMeters},${center.lat},${center.lng});
  way["leisure"="playground"](around:${radiusMeters},${center.lat},${center.lng});
  way["natural"="riverbank"](around:${radiusMeters},${center.lat},${center.lng});
  way["waterway"="riverbank"](around:${radiusMeters},${center.lat},${center.lng});
  way["building"](around:${radiusMeters},${center.lat},${center.lng});
);
out geom;
`;

  try {
    const url = 'https://overpass-api.de/api/interpreter';
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    });

    if (!response.ok) {
      console.warn('Overpass API error:', response.status);
      cachedLandUse = [];
      cachedBuildings = [];
      return;
    }

    const data = await response.json() as {
      elements: Array<{
        geometry?: Array<{ lon: number; lat: number }>;
        tags?: Record<string, string>;
      }>;
    };

    cachedLandUse = [];
    cachedBuildings = [];

    for (const element of data.elements) {
      if (!element.geometry || element.geometry.length < 3) continue;

      const coords: [number, number][] = element.geometry.map(
        (g) => [g.lon, g.lat],
      );
      const tags = element.tags || {};

      // 建物
      if (tags.building) {
        let minLng = Infinity, maxLng = -Infinity;
        let minLat = Infinity, maxLat = -Infinity;
        for (const [cLng, cLat] of coords) {
          if (cLng < minLng) minLng = cLng;
          if (cLng > maxLng) maxLng = cLng;
          if (cLat < minLat) minLat = cLat;
          if (cLat > maxLat) maxLat = cLat;
        }
        cachedBuildings.push({
          coords,
          height: estimateBuildingHeight(tags),
          minLng, maxLng, minLat, maxLat,
        });
        continue;
      }

      // 土地利用
      let type: 'park' | 'residential';
      if (
        tags.leisure === 'park' ||
        tags.leisure === 'garden' ||
        tags.leisure === 'pitch' ||
        tags.leisure === 'playground' ||
        tags.landuse === 'grass' ||
        tags.natural === 'riverbank' ||
        tags.waterway === 'riverbank'
      ) {
        type = 'park';
      } else {
        type = 'residential';
      }

      cachedLandUse.push({ type, coords });
    }

    cachedCenter = { lat: center.lat, lng: center.lng };
    cachedRadius = radiusMeters;

    const withHeight = cachedBuildings.filter(
      (b) => b.height !== 8,
    ).length;

    console.log(
      `Loaded: ${cachedLandUse.length} land use polygons, ` +
      `${cachedBuildings.length} buildings (${withHeight} with explicit height)`,
    );
  } catch (err) {
    console.warn('Failed to fetch OSM data:', err);
    cachedLandUse = [];
    cachedBuildings = [];
  }
}

/**
 * アクセシビリティスコア
 */
export function accessibilityScore(point: LatLng): number {
  if (!cachedLandUse || cachedLandUse.length === 0) {
    return 0.6;
  }

  let inPark = false;
  let inResidential = false;

  for (const polygon of cachedLandUse) {
    if (pointInPolygon(point.lng, point.lat, polygon.coords)) {
      if (polygon.type === 'park') {
        inPark = true;
      } else {
        inResidential = true;
      }
    }
  }

  if (inPark) return 1.0;
  if (inResidential) return 0.3;
  return 0.6;
}

/**
 * 指定地点にある建物の高さを返す
 * 建物がなければ 0
 */
export function getBuildingHeight(lng: number, lat: number): number {
  if (!cachedBuildings || cachedBuildings.length === 0) return 0;

  for (const building of cachedBuildings) {
    // バウンディングボックスで高速フィルタ
    if (lng < building.minLng || lng > building.maxLng ||
        lat < building.minLat || lat > building.maxLat) continue;
    if (pointInPolygon(lng, lat, building.coords)) {
      return building.height;
    }
  }

  return 0;
}

/**
 * 視線回廊に沿った建物のみを取得（score-point 用の高速版）
 *
 * 2点間の bbox + バッファで建物だけを取得する。
 * 土地利用は取得しない（accessibilityScore はデフォルト 0.6 を返す）。
 */
export async function fetchBuildingsForLOS(
  from: LatLng,
  to: LatLng,
  bufferDeg: number = 0.003,
): Promise<void> {
  const south = Math.min(from.lat, to.lat) - bufferDeg;
  const north = Math.max(from.lat, to.lat) + bufferDeg;
  const west = Math.min(from.lng, to.lng) - bufferDeg;
  const east = Math.max(from.lng, to.lng) + bufferDeg;

  const query = `[out:json][timeout:10][bbox:${south},${west},${north},${east}];
(
  way["building"];
  way["landuse"="residential"];
  relation["landuse"="residential"];
  way["leisure"="park"];
  relation["leisure"="park"];
  way["leisure"="garden"];
  way["landuse"="grass"];
  way["leisure"="pitch"];
  way["leisure"="playground"];
  way["natural"="riverbank"];
  way["waterway"="riverbank"];
);
out geom;`;

  try {
    const url = 'https://overpass-api.de/api/interpreter';
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    });

    if (!response.ok) {
      console.warn('Overpass API error:', response.status);
      cachedBuildings = [];
      cachedLandUse = [];
      return;
    }

    const data = await response.json() as {
      elements: Array<{
        geometry?: Array<{ lon: number; lat: number }>;
        tags?: Record<string, string>;
      }>;
    };

    cachedBuildings = [];
    cachedLandUse = [];

    for (const element of data.elements) {
      if (!element.geometry || element.geometry.length < 3) continue;
      const coords: [number, number][] = element.geometry.map(
        (g) => [g.lon, g.lat],
      );
      const tags = element.tags || {};

      // 建物
      if (tags.building) {
        let minLng = Infinity, maxLng = -Infinity;
        let minLat = Infinity, maxLat = -Infinity;
        for (const [cLng, cLat] of coords) {
          if (cLng < minLng) minLng = cLng;
          if (cLng > maxLng) maxLng = cLng;
          if (cLat < minLat) minLat = cLat;
          if (cLat > maxLat) maxLat = cLat;
        }
        cachedBuildings.push({
          coords,
          height: estimateBuildingHeight(tags),
          minLng, maxLng, minLat, maxLat,
        });
        continue;
      }

      // 土地利用
      let type: 'park' | 'residential';
      if (
        tags.leisure === 'park' ||
        tags.leisure === 'garden' ||
        tags.leisure === 'pitch' ||
        tags.leisure === 'playground' ||
        tags.landuse === 'grass' ||
        tags.natural === 'riverbank' ||
        tags.waterway === 'riverbank'
      ) {
        type = 'park';
      } else {
        type = 'residential';
      }
      cachedLandUse.push({ type, coords });
    }

    cachedCenter = null;
    cachedRadius = 0;

    console.log(
      `LOS corridor: ${cachedBuildings.length} buildings, ` +
      `${cachedLandUse.length} land use polygons loaded`,
    );
  } catch (err) {
    console.warn('Failed to fetch OSM data for LOS:', err);
    cachedBuildings = [];
    cachedLandUse = [];
  }
}

/**
 * キャッシュクリア
 */
export function clearLandUseCache(): void {
  cachedLandUse = null;
  cachedBuildings = null;
  cachedCenter = null;
  cachedRadius = 0;
}
