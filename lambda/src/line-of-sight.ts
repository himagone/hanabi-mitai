import type { LatLng } from './types.js';
import { getElevation } from './elevation.js';
import { getBuildingHeight } from './accessibility.js';

/** 花火の開花高度 (m)（地上からの高さ） */
const FIREWORK_ALTITUDE = 250;

/** 視線チェックのサンプル数（固定） */
const NUM_LOS_SAMPLES = 10;

/**
 * 視線通過チェック
 *
 * 観覧地点から花火の開花位置（打上地点上空）への視線が、
 * 途中の地形・建物に遮られていないかを判定する。
 *
 * @returns 0.0（完全に遮蔽）〜 1.0（完全にクリア）
 */
export async function checkLineOfSight(
  viewer: LatLng,
  viewerElevation: number,
  launchSite: LatLng,
  launchSiteElevation: number,
): Promise<number> {
  const viewerHeight = viewerElevation + 1.5;
  const fireworkHeight = launchSiteElevation + FIREWORK_ALTITUDE;

  // 固定10サンプル点を生成し、標高を並列取得
  const samples: LatLng[] = [];
  for (let i = 1; i <= NUM_LOS_SAMPLES; i++) {
    const t = i / (NUM_LOS_SAMPLES + 1);
    samples.push({
      lat: viewer.lat + (launchSite.lat - viewer.lat) * t,
      lng: viewer.lng + (launchSite.lng - viewer.lng) * t,
    });
  }

  const elevations = await Promise.all(
    samples.map((p) => getElevation(p.lat, p.lng)),
  );

  let blockedCount = 0;

  for (let i = 0; i < NUM_LOS_SAMPLES; i++) {
    const elev = elevations[i];
    if (elev === null) continue;

    const buildingH = getBuildingHeight(samples[i].lng, samples[i].lat);
    const obstacleHeight = elev + buildingH;

    const t = (i + 1) / (NUM_LOS_SAMPLES + 1);
    const lineHeight = viewerHeight + (fireworkHeight - viewerHeight) * t;

    if (obstacleHeight > lineHeight) {
      blockedCount++;
    }
  }

  if (blockedCount === 0) return 1.0;
  const blockRatio = blockedCount / NUM_LOS_SAMPLES;
  return Math.max(0, 0.3 * (1 - blockRatio));
}
