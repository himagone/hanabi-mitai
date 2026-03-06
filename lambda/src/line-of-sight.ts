import type { LatLng } from './types.js';
import { getElevation } from './elevation.js';
import { getCachedBuildings, type BuildingPolygon } from './accessibility.js';
import { haversineDistance } from './grid.js';

/** デフォルトの花火開花高度 (m) */
const DEFAULT_FIREWORK_ALTITUDE = 170;

/**
 * 視線通過チェック（建物ポリゴン交差判定ベース）
 *
 * 観覧地点から花火の開花位置への視線（3D直線）が、
 * OSM建物ポリゴンの辺と交差するかを判定し、
 * 交差点での建物高さと視線高さを比較する。
 *
 * @returns 0.0（遮蔽あり）〜 1.0（遮蔽なし）
 */
export async function checkLineOfSight(
  viewer: LatLng,
  viewerElevation: number,
  launchSite: LatLng,
  launchSiteElevation: number,
  fireworkAltitude: number = DEFAULT_FIREWORK_ALTITUDE,
): Promise<number> {
  const viewerHeight = viewerElevation + 1.5; // 目の高さ
  const fireworkHeight = launchSiteElevation + fireworkAltitude;
  const totalDist = haversineDistance(viewer, launchSite);

  if (totalDist < 10) return 1.0;

  const buildings = getCachedBuildings();
  if (buildings.length === 0) return 0.8; // 建物データなし → やや不確実

  // 視線の2D方向ベクトル (lng, lat)
  const rayDx = launchSite.lng - viewer.lng;
  const rayDy = launchSite.lat - viewer.lat;

  // 視線の2Dバウンディングボックス
  const rayMinLng = Math.min(viewer.lng, launchSite.lng);
  const rayMaxLng = Math.max(viewer.lng, launchSite.lng);
  const rayMinLat = Math.min(viewer.lat, launchSite.lat);
  const rayMaxLat = Math.max(viewer.lat, launchSite.lat);

  // 遮蔽する建物を収集
  const blockingBuildings: { building: BuildingPolygon; t: number }[] = [];

  for (const building of buildings) {
    // BBox で高速フィルタ: 視線のBBoxと建物のBBoxが重ならなければスキップ
    if (building.maxLng < rayMinLng || building.minLng > rayMaxLng ||
        building.maxLat < rayMinLat || building.minLat > rayMaxLat) {
      continue;
    }

    // 建物ポリゴンの各辺と視線の交差判定
    const intersections = findRayPolygonIntersections(
      viewer.lng, viewer.lat, rayDx, rayDy,
      building.coords,
    );

    for (const t of intersections) {
      if (t > 0.01 && t < 0.99) { // 始点・終点付近は除外
        blockingBuildings.push({ building, t });
      }
    }
  }

  if (blockingBuildings.length === 0) return 1.0;

  // 交差する建物について、視線の高さと建物の高さを比較
  // 建物の地面標高を取得
  const elevPoints = blockingBuildings.map((b) => ({
    lat: viewer.lat + (launchSite.lat - viewer.lat) * b.t,
    lng: viewer.lng + (launchSite.lng - viewer.lng) * b.t,
  }));

  const elevations = await Promise.all(
    elevPoints.map((p) => getElevation(p.lat, p.lng)),
  );

  let blockedCount = 0;

  for (let i = 0; i < blockingBuildings.length; i++) {
    const { building, t } = blockingBuildings[i];
    const groundElev = elevations[i] ?? viewerElevation;

    // 建物の頂上の高さ
    const buildingTop = groundElev + building.height;

    // 視線の高さ（線形補間）
    const lineHeight = viewerHeight + (fireworkHeight - viewerHeight) * t;

    if (buildingTop > lineHeight) {
      blockedCount++;
    }
  }

  if (blockedCount === 0) return 1.0;

  // 1つでも遮蔽があれば大きく減点
  const blockRatio = blockedCount / blockingBuildings.length;
  return Math.max(0, 0.2 * (1 - blockRatio));
}

/**
 * 2D線分（ray）とポリゴンの辺の交差判定
 *
 * ray: (ox, oy) から方向 (dx, dy) への線分 (t=0..1)
 * polygon: 頂点配列 [lng, lat][]
 *
 * @returns 交差するパラメータ t の配列
 */
function findRayPolygonIntersections(
  ox: number, oy: number,
  dx: number, dy: number,
  polygon: [number, number][],
): number[] {
  const intersections: number[] = [];

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [x1, y1] = polygon[j];
    const [x2, y2] = polygon[i];

    // 辺の方向ベクトル
    const ex = x2 - x1;
    const ey = y2 - y1;

    // 連立方程式: o + t*d = p1 + s*e
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-15) continue; // 平行

    const t = ((x1 - ox) * ey - (y1 - oy) * ex) / denom;
    const s = ((x1 - ox) * dy - (y1 - oy) * dx) / denom;

    // t: 視線上のパラメータ (0-1), s: 辺上のパラメータ (0-1)
    if (t > 0 && t < 1 && s >= 0 && s <= 1) {
      intersections.push(t);
    }
  }

  return intersections;
}
