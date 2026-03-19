import type { LatLng, GridPoint, ScoreBreakdown, ScoredPoint } from './types.js';
import { haversineDistance } from './grid.js';
import { getElevation } from './elevation.js';
import { checkLineOfSight } from './line-of-sight.js';
import { accessibilityScore } from './accessibility.js';

/** デフォルトの花火開花直径 (m) — リクエストで指定がない場合 */
const DEFAULT_FIREWORK_DIAMETER = 150;

/** 直径から開花高度を推定 (打上地点の地上からの高さ, m) */
function estimateAltitude(diameter: number): number {
  // 実測データに基づく線形近似
  // 4号(120m径)→162m高, 5号(150m径)→195m高, 10号(300m径)→360m高
  return 30 + diameter * 1.1;
}

/** スコアの重み */
const WEIGHTS = {
  viewingAngle: 0.25,
  elevation: 0.15,
  lineOfSight: 0.35,
  slope: 0.10,
  accessibility: 0.15,
};

/**
 * 距離に基づく視認性スコア
 *
 * 花火の見かけの角度サイズと大気による減衰を考慮。
 * 全体スコアの乗数として使用し、遠距離では強制的にスコアを下げる。
 *
 * - 10号玉(280m): ~3km で見かけ約5°(良好), ~10km で約1.6°(小さい), ~30km で約0.5°(ほぼ見えない)
 * - 大気: 晴天でも15km以上はかすみで急激に劣化
 *
 * @returns 0.0（見えない）〜 1.0（十分な大きさで見える）
 */
function distanceVisibilityScore(distanceMeters: number, bloomDiameter: number): number {
  // 花火の見かけの角度サイズ (度)
  const apparentAngleDeg = Math.atan2(bloomDiameter, distanceMeters) * 180 / Math.PI;

  // 見かけサイズスコア: 3°以上で良好、0.3°以下でほぼ見えない
  let sizeScore: number;
  if (apparentAngleDeg >= 3) {
    sizeScore = 1.0;
  } else if (apparentAngleDeg >= 0.3) {
    sizeScore = (apparentAngleDeg - 0.3) / (3 - 0.3);
  } else {
    sizeScore = 0;
  }

  // 大気減衰: 3km以内はペナルティなし、それ以降は指数減衰
  const atmosphericScore = Math.exp(-Math.max(0, distanceMeters - 3000) / 10000);

  return sizeScore * atmosphericScore;
}

/**
 * 仰角スコア
 */
function viewingAngleScore(
  distanceMeters: number,
  viewerElevation: number,
  launchSiteElevation: number,
  fireworkAltitude: number,
): { score: number; angleDeg: number } {
  const viewerEyeHeight = viewerElevation + 1.5;
  const fireworkHeight = launchSiteElevation + fireworkAltitude;
  const heightAboveViewer = fireworkHeight - viewerEyeHeight;

  if (heightAboveViewer <= 0) {
    return { score: 0.05, angleDeg: 0 };
  }

  const angleRad = Math.atan2(heightAboveViewer, distanceMeters);
  const angleDeg = (angleRad * 180) / Math.PI;

  const optimalAngle = 35;
  const sigma = 25;
  const diff = angleDeg - optimalAngle;
  const score = Math.exp(-(diff * diff) / (2 * sigma * sigma));

  return { score, angleDeg };
}

/**
 * 相対標高スコア
 */
function elevationScore(relativeElevation: number): number {
  const k = 0.1;
  return 1 / (1 + Math.exp(-k * relativeElevation));
}

/**
 * 勾配スコア
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
 * パス1: 高速な事前スコア（ネットワーク不要）
 * viewingAngle + elevation + accessibility のみで概算
 */
export function quickScorePoint(
  point: GridPoint,
  launchSite: LatLng,
  launchSiteElevation: number,
  fireworkDiameter: number = DEFAULT_FIREWORK_DIAMETER,
): { dist: number; relElev: number; angleDeg: number; quickScore: number } {
  const dist = haversineDistance(point, launchSite);
  const relElev = point.elevation - launchSiteElevation;
  const altitude = estimateAltitude(fireworkDiameter);

  const { score: angleScore, angleDeg } = viewingAngleScore(
    dist,
    point.elevation,
    launchSiteElevation,
    altitude,
  );
  const elevScore = elevationScore(relElev);
  const accessScore = accessibilityScore(point);

  const distVisibility = distanceVisibilityScore(dist, fireworkDiameter);
  const baseScore =
    WEIGHTS.viewingAngle * angleScore +
    WEIGHTS.elevation * elevScore +
    WEIGHTS.accessibility * accessScore;
  const quickScore = baseScore * distVisibility;

  return { dist, relElev, angleDeg, quickScore };
}

/**
 * パス2: 上位候補のみフルスコアリング（LOS + 勾配）
 */
export async function fullScorePoint(
  point: GridPoint,
  launchSite: LatLng,
  launchSiteElevation: number,
  fireworkDiameter: number = DEFAULT_FIREWORK_DIAMETER,
): Promise<ScoredPoint> {
  const dist = haversineDistance(point, launchSite);
  const relElev = point.elevation - launchSiteElevation;
  const altitude = estimateAltitude(fireworkDiameter);

  const { score: angleScore, angleDeg } = viewingAngleScore(
    dist,
    point.elevation,
    launchSiteElevation,
    altitude,
  );

  const elevScore = elevationScore(relElev);

  const losScore = await checkLineOfSight(
    point,
    point.elevation,
    launchSite,
    launchSiteElevation,
    altitude,
  );

  const delta = 0.0003;
  const [nElev, sElev, eElev, wElev] = await Promise.all([
    getElevation(point.lat + delta, point.lng),
    getElevation(point.lat - delta, point.lng),
    getElevation(point.lat, point.lng + delta),
    getElevation(point.lat, point.lng - delta),
  ]);
  const slopeS = slopeScore(point, launchSite, [nElev, sElev, eElev, wElev]);

  const accessScore = accessibilityScore(point);

  const distVisibility = distanceVisibilityScore(dist, fireworkDiameter);
  const losAvailable = losScore >= 0;
  const effectiveLos = losAvailable ? losScore : 0.8; // 未取得時は控えめに0.8で計算
  const baseTotal =
    WEIGHTS.viewingAngle * angleScore +
    WEIGHTS.elevation * elevScore +
    WEIGHTS.lineOfSight * effectiveLos +
    WEIGHTS.slope * slopeS +
    WEIGHTS.accessibility * accessScore;

  const scores: ScoreBreakdown = {
    distance: distVisibility,
    viewingAngle: angleScore,
    elevation: elevScore,
    lineOfSight: losAvailable ? losScore : -1, // -1 = データ未取得
    slope: slopeS,
    accessibility: accessScore,
    total: baseTotal * distVisibility,
  };

  return {
    lat: point.lat,
    lng: point.lng,
    elevation: point.elevation,
    distanceMeters: Math.round(dist),
    relativeElevation: Math.round(relElev * 10) / 10,
    viewingAngleDeg: Math.round(angleDeg * 10) / 10,
    score: scores,
  };
}
