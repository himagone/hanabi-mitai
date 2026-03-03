import type { LatLng } from './types.js';
import { getElevation } from './elevation.js';
import { samplePointsBetween } from './grid.js';

/** 花火の開花高度 (m)（地上からの高さ） */
const FIREWORK_ALTITUDE = 250;

/**
 * 視線通過チェック
 *
 * 観覧地点から花火の開花位置（打上地点上空）への視線が、
 * 途中の地形に遮られていないかを判定する。
 *
 * @param viewer 観覧候補地点
 * @param viewerElevation 観覧地点の標高
 * @param launchSite 打上地点
 * @param launchSiteElevation 打上地点の標高
 * @returns 0.0（完全に遮蔽）〜 1.0（完全にクリア）
 */
export async function checkLineOfSight(
  viewer: LatLng,
  viewerElevation: number,
  launchSite: LatLng,
  launchSiteElevation: number,
): Promise<number> {
  // 観覧者の目線高さ = 地表標高 + 1.5m（立ち見想定）
  const viewerHeight = viewerElevation + 1.5;

  // 花火の開花位置 = 打上地点標高 + 開花高度
  const fireworkHeight = launchSiteElevation + FIREWORK_ALTITUDE;

  // 視線上のサンプル点（20m間隔）
  const samplePoints = samplePointsBetween(viewer, launchSite, 20);

  if (samplePoints.length === 0) return 1.0;

  let blockedCount = 0;

  for (let i = 0; i < samplePoints.length; i++) {
    const point = samplePoints[i];
    const elevation = await getElevation(point.lat, point.lng);

    if (elevation === null) continue;

    // 視線上の高さを線形補間で計算
    const t = (i + 1) / (samplePoints.length + 1);
    const lineHeight = viewerHeight + (fireworkHeight - viewerHeight) * t;

    // 地表がビューラインより高い = 遮蔽
    if (elevation > lineHeight) {
      blockedCount++;
    }
  }

  // 遮蔽率を計算（1箇所でも遮蔽されると大幅減点）
  if (blockedCount === 0) return 1.0;

  const blockRatio = blockedCount / samplePoints.length;

  // 1箇所でも遮蔽があれば最大0.3、遮蔽率に応じてさらに低下
  return Math.max(0, 0.3 * (1 - blockRatio));
}
