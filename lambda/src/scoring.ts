import type { LatLng, GridPoint, ScoreBreakdown, ScoredPoint } from './types.js';
import { haversineDistance } from './grid.js';
import { getElevation } from './elevation.js';
import { checkLineOfSight } from './line-of-sight.js';

/** 花火の開花高度 (打上地点の地上からの高さ, m) */
const FIREWORK_ALTITUDE = 250;

/** スコアの重み */
const WEIGHTS = {
  viewingAngle: 0.25,
  elevation: 0.25,
  lineOfSight: 0.35,
  slope: 0.15,
};

/**
 * 仰角スコア（旧・距離スコアを置き換え）
 *
 * 花火を見上げる角度（仰角）が約60°になる場所が最も見やすい。
 * - 打上地点から約350mで仰角60°が目安
 * - 仰角が60°から離れるほど減点
 *
 * 仰角の計算:
 *   花火の高さ（観覧者の目線から見た） = 打上地点標高 + 開花高度 - 観覧者標高
 *   仰角 = atan(花火の高さ / 水平距離)
 *
 * @param distanceMeters 水平距離 (m)
 * @param viewerElevation 観覧者の標高 (m)
 * @param launchSiteElevation 打上地点の標高 (m)
 * @returns スコア 0.0〜1.0
 */
function viewingAngleScore(
  distanceMeters: number,
  viewerElevation: number,
  launchSiteElevation: number,
): { score: number; angleDeg: number } {
  // 観覧者の目線 = 地面 + 1.5m（立ち見想定）
  const viewerEyeHeight = viewerElevation + 1.5;

  // 花火が開く高さ
  const fireworkHeight = launchSiteElevation + FIREWORK_ALTITUDE;

  // 観覧者から見た花火の高さ
  const heightAboveViewer = fireworkHeight - viewerEyeHeight;

  // 花火が目線より低い場合（観覧者が花火より高い場所にいる）→ 低スコア
  if (heightAboveViewer <= 0) {
    return { score: 0.05, angleDeg: 0 };
  }

  // 仰角（度）
  const angleRad = Math.atan2(heightAboveViewer, distanceMeters);
  const angleDeg = (angleRad * 180) / Math.PI;

  // 最適仰角 = 60°、ガウス分布で評価（σ = 15°）
  const optimalAngle = 60;
  const sigma = 15;
  const diff = angleDeg - optimalAngle;
  const score = Math.exp(-(diff * diff) / (2 * sigma * sigma));

  return { score, angleDeg };
}

/**
 * 相対標高スコア
 * 打上地点より高い位置ほど高スコア
 * （周囲の建物・群衆の頭越しに見える効果）
 */
function elevationScore(relativeElevation: number): number {
  // シグモイド関数: 0m差 → 0.5, +10m → ~0.73, +20m → ~0.88, -10m → ~0.27
  const k = 0.1;
  return 1 / (1 + Math.exp(-k * relativeElevation));
}

/**
 * 勾配スコア
 * 打上地点に向かって下る勾配（天然の観覧席）を評価
 */
function slopeScore(
  point: LatLng,
  launchSite: LatLng,
  neighborElevations: (number | null)[],
): number {
  const [northElev, southElev, eastElev, westElev] = neighborElevations;

  if (
    northElev === null ||
    southElev === null ||
    eastElev === null ||
    westElev === null
  ) {
    return 0.5;
  }

  const gradNorth = northElev - southElev;
  const gradEast = eastElev - westElev;

  const dirNorth = launchSite.lat - point.lat;
  const dirEast = launchSite.lng - point.lng;
  const dirLen = Math.sqrt(dirNorth * dirNorth + dirEast * dirEast);

  if (dirLen === 0) return 0.5;

  const normDirN = dirNorth / dirLen;
  const normDirE = dirEast / dirLen;

  const dot = gradNorth * normDirN + gradEast * normDirE;

  const gradMag = Math.sqrt(gradNorth * gradNorth + gradEast * gradEast);
  if (gradMag === 0) return 0.5;

  const normalizedDot = -dot / gradMag;
  return 0.5 + 0.5 * Math.max(-1, Math.min(1, normalizedDot));
}

/**
 * おすすめ理由を生成
 */
function generateReason(
  scores: ScoreBreakdown,
  relativeElevation: number,
  distanceMeters: number,
  viewingAngleDeg: number,
): string {
  const reasons: string[] = [];

  if (scores.lineOfSight >= 0.9) {
    reasons.push('視界良好');
  } else if (scores.lineOfSight >= 0.5) {
    reasons.push('視界おおむね良好');
  }

  if (viewingAngleDeg >= 50 && viewingAngleDeg <= 70) {
    reasons.push(`見上げ角度${Math.round(viewingAngleDeg)}°で最適`);
  } else if (viewingAngleDeg >= 40 && viewingAngleDeg <= 80) {
    reasons.push(`見上げ角度${Math.round(viewingAngleDeg)}°`);
  }

  if (relativeElevation > 10) {
    reasons.push(`打上地点より${Math.round(relativeElevation)}m高い高台`);
  } else if (relativeElevation > 3) {
    reasons.push('やや高台');
  }

  if (scores.slope > 0.7) {
    reasons.push('花火方向に開けた斜面');
  }

  return reasons.length > 0 ? reasons.join('、') : '標準的なポジション';
}

/**
 * 候補地点をスコアリング
 */
export async function scorePoint(
  point: GridPoint,
  launchSite: LatLng,
  launchSiteElevation: number,
): Promise<ScoredPoint> {
  const dist = haversineDistance(point, launchSite);
  const relElev = point.elevation - launchSiteElevation;

  // 仰角スコア
  const { score: angleScore, angleDeg } = viewingAngleScore(
    dist,
    point.elevation,
    launchSiteElevation,
  );

  // 相対標高スコア
  const elevScore = elevationScore(relElev);

  // 視線通過チェック
  const losScore = await checkLineOfSight(
    point,
    point.elevation,
    launchSite,
    launchSiteElevation,
  );

  // 勾配スコア
  const delta = 0.0003;
  const [nElev, sElev, eElev, wElev] = await Promise.all([
    getElevation(point.lat + delta, point.lng),
    getElevation(point.lat - delta, point.lng),
    getElevation(point.lat, point.lng + delta),
    getElevation(point.lat, point.lng - delta),
  ]);
  const slopeS = slopeScore(point, launchSite, [nElev, sElev, eElev, wElev]);

  const scores: ScoreBreakdown = {
    viewingAngle: angleScore,
    elevation: elevScore,
    lineOfSight: losScore,
    slope: slopeS,
    total:
      WEIGHTS.viewingAngle * angleScore +
      WEIGHTS.elevation * elevScore +
      WEIGHTS.lineOfSight * losScore +
      WEIGHTS.slope * slopeS,
  };

  return {
    lat: point.lat,
    lng: point.lng,
    elevation: point.elevation,
    distanceMeters: Math.round(dist),
    relativeElevation: Math.round(relElev * 10) / 10,
    viewingAngleDeg: Math.round(angleDeg * 10) / 10,
    score: scores,
    reason: generateReason(scores, relElev, dist, angleDeg),
  };
}
