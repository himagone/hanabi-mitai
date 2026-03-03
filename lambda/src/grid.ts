import type { LatLng } from './types.js';

/** 地球の半径 (m) */
const EARTH_RADIUS = 6371000;

/** 度をラジアンに変換 */
function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** ラジアンを度に変換 */
function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/**
 * 2点間の距離をメートルで計算 (Haversine)
 */
export function haversineDistance(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(h));
}

/**
 * 基準点からの距離(m)オフセットを緯度経度に変換
 */
function offsetLatLng(
  origin: LatLng,
  northMeters: number,
  eastMeters: number,
): LatLng {
  const dLat = northMeters / EARTH_RADIUS;
  const dLng = eastMeters / (EARTH_RADIUS * Math.cos(toRad(origin.lat)));
  return {
    lat: origin.lat + toDeg(dLat),
    lng: origin.lng + toDeg(dLng),
  };
}

/**
 * 打上地点を中心にグリッドポイントを生成
 * @param center 打上地点
 * @param radiusMeters 検索半径 (m)
 * @param spacingMeters グリッド間隔 (m)
 * @returns 候補地点の配列（安全圏外のみ）
 */
export function generateGrid(
  center: LatLng,
  radiusMeters: number,
  spacingMeters: number = 50,
): LatLng[] {
  const safetyZone = 200; // 打上地点から200m以内は安全圏で除外
  const points: LatLng[] = [];

  const steps = Math.ceil(radiusMeters / spacingMeters);

  for (let ny = -steps; ny <= steps; ny++) {
    for (let nx = -steps; nx <= steps; nx++) {
      const northM = ny * spacingMeters;
      const eastM = nx * spacingMeters;
      const dist = Math.sqrt(northM * northM + eastM * eastM);

      if (dist < safetyZone || dist > radiusMeters) continue;

      points.push(offsetLatLng(center, northM, eastM));
    }
  }

  return points;
}

/**
 * 2点間を等間隔にサンプリング
 */
export function samplePointsBetween(
  from: LatLng,
  to: LatLng,
  intervalMeters: number,
): LatLng[] {
  const totalDist = haversineDistance(from, to);
  const numSamples = Math.max(2, Math.floor(totalDist / intervalMeters));
  const points: LatLng[] = [];

  for (let i = 1; i < numSamples; i++) {
    const t = i / numSamples;
    points.push({
      lat: from.lat + (to.lat - from.lat) * t,
      lng: from.lng + (to.lng - from.lng) * t,
    });
  }

  return points;
}
