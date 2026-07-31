import type { LatLng, GridPoint, ScoreBreakdown, ScoredPoint } from './types.js';
import { haversineDistance } from './grid.js';
import { getElevation } from './elevation.js';
import { checkLineOfSight } from './line-of-sight.js';
import { accessibilityScore } from './accessibility.js';

/** デフォルトの花火開花直径 (m) — リクエストで指定がない場合 */
const DEFAULT_FIREWORK_DIAMETER = 150;

/** 直径から中心開花高度を推定 (打上地点の地上からの高さ, m) */
function estimateAltitude(diameter: number): number {
  // 開花高度 ≈ 開花直径。実測では 号数×約33m(高度) ≒ 号数×約32m(直径)。
  // 例: 10号 高度約330m/直径約320m, 3号 高度約160m/直径約160m。
  return diameter * 1.05;
}

/**
 * 開花球の縦方向の広がり（絶対標高）
 *
 * 花火は点でなく直径 D の球。中心高度 ± 半径(D/2) を下端・上端とし、
 * 仰角・視線判定の両方でこの帯を用いる。
 */
function burstExtent(
  launchSiteElevation: number,
  diameter: number,
): { bottom: number; center: number; top: number } {
  const center = launchSiteElevation + estimateAltitude(diameter);
  const radius = diameter / 2;
  return {
    center,
    top: center + radius,
    // 下端が地面にめり込まないようクランプ
    bottom: Math.max(center - radius, launchSiteElevation + 20),
  };
}

/**
 * 「見え方の質」の重み。
 *
 * 遮蔽(lineOfSight)は加算項ではなく乗算項（total = 質 × 遮蔽 × 距離乗数）なので含めない。
 * 仰角の"好み"は廃止（最適角の仮定が恣意的で、近すぎ危険は立入禁止エリアで扱うため）。
 * 残る3項目を合計 QUALITY_WEIGHT_SUM で割って 0〜1 に再正規化する。
 */
const WEIGHTS = {
  elevation: 0.15,
  slope: 0.10,
  accessibility: 0.15,
};
const QUALITY_WEIGHT_SUM =
  WEIGHTS.elevation + WEIGHTS.slope + WEIGHTS.accessibility;

/** 建物データ未取得時、地形のみの可視割合に掛ける不確実性割引 */
const UNKNOWN_BUILDINGS_CONFIDENCE = 0.9;

/**
 * 距離に基づく視認性スコア
 *
 * 花火の見かけの角度サイズと大気による減衰を考慮。
 * 全体スコアの乗数として使用し、遠距離では強制的にスコアを下げる。
 *
 * @returns 0.0（見えない）〜 1.0（十分な大きさで見える）
 */
function distanceVisibilityScore(distanceMeters: number, bloomDiameter: number): number {
  // 見かけの角度サイズ（度）。大きく見えるほど良い。
  const apparentAngleDeg = Math.atan2(bloomDiameter, distanceMeters) * 180 / Math.PI;

  // 飽和させず連続加点（近い＝大きい ほど単調に高い）。1-exp(-x/K) は 0〜1。
  // K=8: 近距離の没入視で~0.95、中距離で緩やかに低下し、遠方ほど確実に下がる。
  const SIZE_HALF = 8;
  const sizeScore = 1 - Math.exp(-apparentAngleDeg / SIZE_HALF);

  // 大気減衰: 3km 以降はかすみで劣化
  const atmosphericScore = Math.exp(-Math.max(0, distanceMeters - 3000) / 10000);

  return sizeScore * atmosphericScore;
}

/**
 * 開花中心を見上げる角度（表示用の情報値、度）
 *
 * 採点には使わない（仰角の"好み"は廃止）。UI に「見上げる角度 ○°」を出すためだけに算出する。
 */
function viewingAngleDeg(
  distanceMeters: number,
  viewerElevation: number,
  burstCenterElev: number,
): number {
  const viewerEye = viewerElevation + 1.5;
  return (Math.atan2(burstCenterElev - viewerEye, distanceMeters) * 180) / Math.PI;
}

/**
 * 相対標高スコア
 *
 * 打上と同じ高さ以上なら理想（障害物を見下ろせる）→ 満点。
 * 打上より低い場合のみ緩やかに減点する。高台の利点＝遮蔽回避は可視率(occlusion)が
 * 直接評価するため、正側を満点で頭打ちにして「平坦＝0.5の頭打ち」を解消する。
 */
function elevationScore(relativeElevation: number): number {
  if (relativeElevation >= 0) return 1.0;
  return Math.max(0.6, 1.0 + relativeElevation / 60); // -24m で 0.6
}

/**
 * 勾配スコア
 *
 * 平坦・花火方向に開けた（下る）斜面は理想 → 1.0。
 * 花火方向に上る斜面のみ減点する（-1で0.5）。平坦を頭打ちの0.5にしない。
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
    return 1.0; // データ無し＝平坦とみなし理想扱い
  }

  const gradNorth = northElev - southElev;
  const gradEast = eastElev - westElev;

  const dirNorth = launchSite.lat - point.lat;
  const dirEast = launchSite.lng - point.lng;
  const dirLen = Math.sqrt(dirNorth * dirNorth + dirEast * dirEast);

  if (dirLen === 0) return 1.0;

  const normDirN = dirNorth / dirLen;
  const normDirE = dirEast / dirLen;

  const dot = gradNorth * normDirN + gradEast * normDirE;

  const gradMag = Math.sqrt(gradNorth * gradNorth + gradEast * gradEast);
  if (gradMag === 0) return 1.0; // 平坦

  const normalizedDot = Math.max(-1, Math.min(1, -dot / gradMag));
  // 開けた/平坦(normalizedDot≥0)→1.0、花火方向に上る(負)のみ減点
  return 1.0 + 0.5 * Math.min(0, normalizedDot);
}

/** 見え方の質（0〜1）: 遮蔽を除いた3項目の重み付き和を再正規化 */
function qualityScore(
  elevScore: number,
  slopeS: number,
  accessScore: number,
): number {
  return (
    WEIGHTS.elevation * elevScore +
    WEIGHTS.slope * slopeS +
    WEIGHTS.accessibility * accessScore
  ) / QUALITY_WEIGHT_SUM;
}

/**
 * パス1: スコアの上限値（分枝限定法用・ネットワーク不要）
 *
 * 未計算の勾配・遮蔽を満点(1.0)と仮定した上限値を返す。
 * この上限値でソートし、上限が現時点の上位 real スコアを下回った点は
 * 本採点しても上位に入り得ないため打ち切れる（取りこぼしゼロ）。
 */
export function quickScorePoint(
  point: GridPoint,
  launchSite: LatLng,
  launchSiteElevation: number,
  fireworkDiameter: number = DEFAULT_FIREWORK_DIAMETER,
): { dist: number; relElev: number; angleDeg: number; quickScoreUB: number } {
  const dist = haversineDistance(point, launchSite);
  const relElev = point.elevation - launchSiteElevation;
  const burst = burstExtent(launchSiteElevation, fireworkDiameter);

  const angleDeg = viewingAngleDeg(dist, point.elevation, burst.center);
  const elevScore = elevationScore(relElev);
  const accessScore = accessibilityScore(point);
  const distVis = distanceVisibilityScore(dist, fireworkDiameter);

  // 勾配・遮蔽を満点と仮定した上限
  const qualityUB = qualityScore(elevScore, 1.0, accessScore);
  const quickScoreUB = qualityUB * 1.0 * distVis;

  return { dist, relElev, angleDeg, quickScoreUB };
}

/**
 * パス2: フルスコアリング（遮蔽=乗算項）
 *
 * total = 質(quality) × 遮蔽(可視割合) × 距離乗数
 * 遮蔽が 0 なら他が満点でも 0 点になる。
 */
export async function fullScorePoint(
  point: GridPoint,
  launchSite: LatLng,
  launchSiteElevation: number,
  fireworkDiameter: number = DEFAULT_FIREWORK_DIAMETER,
): Promise<ScoredPoint> {
  const dist = haversineDistance(point, launchSite);
  const relElev = point.elevation - launchSiteElevation;
  const burst = burstExtent(launchSiteElevation, fireworkDiameter);

  const angleDeg = viewingAngleDeg(dist, point.elevation, burst.center);
  const elevScore = elevationScore(relElev);

  const los = await checkLineOfSight(point, point.elevation, launchSite, burst.center, fireworkDiameter / 2);

  const delta = 0.0003;
  const [nElev, sElev, eElev, wElev] = await Promise.all([
    getElevation(point.lat + delta, point.lng),
    getElevation(point.lat - delta, point.lng),
    getElevation(point.lat, point.lng + delta),
    getElevation(point.lat, point.lng - delta),
  ]);
  const slopeS = slopeScore(point, launchSite, [nElev, sElev, eElev, wElev]);

  const accessScore = accessibilityScore(point);
  const distVis = distanceVisibilityScore(dist, fireworkDiameter);

  const quality = qualityScore(elevScore, slopeS, accessScore);
  // 遮蔽（可視割合）を乗算。建物データ未取得時は地形のみなので控えめに割引
  const occlusion = los.buildingsKnown ? los.fraction : los.fraction * UNKNOWN_BUILDINGS_CONFIDENCE;
  const total = quality * occlusion * distVis;

  const scores: ScoreBreakdown = {
    distance: distVis,
    elevation: elevScore,
    lineOfSight: los.buildingsKnown ? los.fraction : -1, // -1 = 建物データ未取得
    slope: slopeS,
    accessibility: accessScore,
    total,
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
