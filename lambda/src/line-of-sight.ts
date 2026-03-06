import type { LatLng } from './types.js';
import { getElevation } from './elevation.js';
import { getBuildingHeight, getMaxBuildingHeightNear } from './accessibility.js';
import { haversineDistance } from './grid.js';

/** デフォルトの花火開花高度 (m) */
const DEFAULT_FIREWORK_ALTITUDE = 170;

/**
 * 視線通過チェック
 *
 * 観覧地点から花火の開花位置（打上地点上空）への視線が、
 * 途中の地形・建物に遮られていないかを判定する。
 *
 * 近距離（観覧者の周辺200m）はサンプルを密に取り、
 * 各サンプル点では周辺の建物も検索して遮蔽を検出する。
 *
 * @returns 0.0（完全に遮蔽）〜 1.0（完全にクリア）
 */
export async function checkLineOfSight(
  viewer: LatLng,
  viewerElevation: number,
  launchSite: LatLng,
  launchSiteElevation: number,
  fireworkAltitude: number = DEFAULT_FIREWORK_ALTITUDE,
): Promise<number> {
  const viewerHeight = viewerElevation + 1.5;
  const fireworkHeight = launchSiteElevation + fireworkAltitude;
  const totalDist = haversineDistance(viewer, launchSite);

  // サンプル点を生成: 近距離を密に、遠距離は粗く
  // 0〜200m: 20m間隔、200m〜: 100m間隔（最大50サンプル）
  const tValues: number[] = [];
  const nearThreshold = Math.min(200, totalDist * 0.3);
  // 近距離: 20m間隔
  for (let d = 20; d <= nearThreshold; d += 20) {
    tValues.push(d / totalDist);
  }
  // 遠距離: 100m間隔
  const farStart = Math.max(nearThreshold, 100);
  for (let d = farStart; d < totalDist; d += 100) {
    const t = d / totalDist;
    if (t > 0.95) break;
    if (!tValues.includes(t)) tValues.push(t);
  }
  tValues.sort((a, b) => a - b);
  // 最大50サンプルに制限
  const samples: { lat: number; lng: number; t: number }[] = [];
  const step = tValues.length > 50 ? Math.ceil(tValues.length / 50) : 1;
  for (let i = 0; i < tValues.length; i += step) {
    const t = tValues[i];
    samples.push({
      lat: viewer.lat + (launchSite.lat - viewer.lat) * t,
      lng: viewer.lng + (launchSite.lng - viewer.lng) * t,
      t,
    });
  }

  if (samples.length === 0) return 1.0;

  const elevations = await Promise.all(
    samples.map((p) => getElevation(p.lat, p.lng)),
  );

  let blockedCount = 0;

  for (let i = 0; i < samples.length; i++) {
    const elev = elevations[i];
    if (elev === null) continue;

    const s = samples[i];
    // サンプル点の建物 + 周辺20m以内の最大建物高さ
    const buildingH = getMaxBuildingHeightNear(s.lng, s.lat, 0.0002);
    const obstacleHeight = elev + buildingH;

    const lineHeight = viewerHeight + (fireworkHeight - viewerHeight) * s.t;

    if (obstacleHeight > lineHeight) {
      blockedCount++;
    }
  }

  if (blockedCount === 0) return 1.0;
  const blockRatio = blockedCount / samples.length;
  // 1つでも遮蔽があれば大幅減点
  return Math.max(0, 0.3 * (1 - blockRatio));
}
