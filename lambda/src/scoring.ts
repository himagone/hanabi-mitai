import type { LatLng, GridPoint, ScoreBreakdown, ScoredPoint } from './types.js';
import { haversineDistance } from './grid.js';
import { getElevation } from './elevation.js';
import { checkLineOfSight } from './line-of-sight.js';
import { accessibilityScore } from './accessibility.js';

/** 花火の開花高度 (打上地点の地上からの高さ, m) */
const FIREWORK_ALTITUDE = 250;

/** スコアの重み */
const WEIGHTS = {
  viewingAngle: 0.20,
  elevation: 0.15,
  lineOfSight: 0.30,
  slope: 0.10,
  accessibility: 0.25,
};

/**
 * 仰角スコア
 */
function viewingAngleScore(
  distanceMeters: number,
  viewerElevation: number,
  launchSiteElevation: number,
): { score: number; angleDeg: number } {
  const viewerEyeHeight = viewerElevation + 1.5;
  const fireworkHeight = launchSiteElevation + FIREWORK_ALTITUDE;
  const heightAboveViewer = fireworkHeight - viewerEyeHeight;

  if (heightAboveViewer <= 0) {
    return { score: 0.05, angleDeg: 0 };
  }

  const angleRad = Math.atan2(heightAboveViewer, distanceMeters);
  const angleDeg = (angleRad * 180) / Math.PI;

  const optimalAngle = 60;
  const sigma = 15;
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
 * おすすめ理由を生成
 */
function generateReason(
  scores: ScoreBreakdown,
  relativeElevation: number,
  _distanceMeters: number,
  viewingAngleDeg: number,
): string {
  const reasons: string[] = [];

  if (scores.accessibility >= 0.9) {
    reasons.push('公園・広場');
  } else if (scores.accessibility <= 0.2) {
    reasons.push('住宅地');
  }

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
 * パス1: 高速な事前スコア（ネットワーク不要）
 * viewingAngle + elevation + accessibility のみで概算
 */
export function quickScorePoint(
  point: GridPoint,
  launchSite: LatLng,
  launchSiteElevation: number,
): { dist: number; relElev: number; angleDeg: number; quickScore: number } {
  const dist = haversineDistance(point, launchSite);
  const relElev = point.elevation - launchSiteElevation;

  const { score: angleScore, angleDeg } = viewingAngleScore(
    dist,
    point.elevation,
    launchSiteElevation,
  );
  const elevScore = elevationScore(relElev);
  const accessScore = accessibilityScore(point);

  const quickScore =
    WEIGHTS.viewingAngle * angleScore +
    WEIGHTS.elevation * elevScore +
    WEIGHTS.accessibility * accessScore;

  return { dist, relElev, angleDeg, quickScore };
}

/**
 * パス2: 上位候補のみフルスコアリング（LOS + 勾配）
 */
export async function fullScorePoint(
  point: GridPoint,
  launchSite: LatLng,
  launchSiteElevation: number,
): Promise<ScoredPoint> {
  const dist = haversineDistance(point, launchSite);
  const relElev = point.elevation - launchSiteElevation;

  const { score: angleScore, angleDeg } = viewingAngleScore(
    dist,
    point.elevation,
    launchSiteElevation,
  );

  const elevScore = elevationScore(relElev);

  const losScore = await checkLineOfSight(
    point,
    point.elevation,
    launchSite,
    launchSiteElevation,
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

  const scores: ScoreBreakdown = {
    viewingAngle: angleScore,
    elevation: elevScore,
    lineOfSight: losScore,
    slope: slopeS,
    accessibility: accessScore,
    total:
      WEIGHTS.viewingAngle * angleScore +
      WEIGHTS.elevation * elevScore +
      WEIGHTS.lineOfSight * losScore +
      WEIGHTS.slope * slopeS +
      WEIGHTS.accessibility * accessScore,
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
