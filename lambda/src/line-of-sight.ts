import type { LatLng } from './types.js';
import { getElevation } from './elevation.js';
import { getCachedBuildings, type BuildingPolygon } from './accessibility.js';
import { getCachedPlateauBuildings } from './plateau.js';
import { haversineDistance, samplePointsBetween } from './grid.js';

/** 地形サンプリング間隔 (m) */
const TERRAIN_SAMPLE_INTERVAL = 40;
/**
 * 視点に近すぎる遮蔽物を無視する距離比の下限。
 * t→0 で必要視線高さが発散するため 0 割りだけ避ける。目の前の建物こそ最も遮るので
 * 小さめにして near-field を拾う（地面は視点高付近なので誤遮蔽にはならない）。
 */
const MIN_T = 0.003;
/** 緯度1度あたりのメートル（水平オフセット換算用） */
const METERS_PER_DEG_LAT = 111320;

/**
 * 開花球ディスクのサンプル格子（半径比）。
 * 横(方位)5 × 縦(高さ)3 のうち、円盤内(u²+v²≤1)のセルのみ可視判定に用いる。
 */
const AZIMUTH_OFFSETS = [-0.8, -0.4, 0, 0.4, 0.8];
const HEIGHT_OFFSETS = [-0.7, 0, 0.7];

/** 視線判定の結果 */
export interface LineOfSightResult {
  /** 開花球ディスクのうち遮蔽されずに見えているセルの割合 (0〜1) */
  fraction: number;
  /** 建物データ(PLATEAU/OSM)が取得できているか。false のときは地形のみで判定 */
  buildingsKnown: boolean;
}

type Buildings = BuildingPolygon[] | null;

/**
 * 視線通過チェック（開花球ディスクの2D可視率）
 *
 * 花火は縦にも横にも直径Dの広がりを持つ。観覧者に正対する円盤とみなし、
 * 方位(横)×高さ(縦)の格子で各セルが地形・建物に遮られないかを調べ、見えているセル率を返す。
 * これにより「完全に見える(1.0)／建物の隙間から見える(0<f<1)／見えない(0)」を表現する。
 *
 * 建物は PLATEAU の実測高さを優先し、圏外では OSM 推定高さにフォールバックする。
 *
 * @param burstCenterElev 開花中心の絶対標高 (打上標高 + 開花高度)
 * @param burstRadius     開花半径 (直径/2)
 */
export async function checkLineOfSight(
  viewer: LatLng,
  viewerElevation: number,
  launchSite: LatLng,
  burstCenterElev: number,
  burstRadius: number,
): Promise<LineOfSightResult> {
  const plateau = getCachedPlateauBuildings();
  const osm = getCachedBuildings();
  const buildings = plateau !== null ? plateau : osm;
  const buildingsKnown = plateau !== null || osm !== null;

  const totalDist = haversineDistance(viewer, launchSite);
  if (totalDist < 10) return { fraction: 1, buildingsKnown };

  // 視線方位に直交する水平単位ベクトル（メートル系 → 緯度経度へ換算）
  const latMid = (viewer.lat + launchSite.lat) / 2;
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((latMid * Math.PI) / 180);
  const eastM = (launchSite.lng - viewer.lng) * metersPerDegLng;
  const northM = (launchSite.lat - viewer.lat) * METERS_PER_DEG_LAT;
  const len = Math.hypot(eastM, northM);
  // 直交方向（メートル単位ベクトル）
  const perpEast = -northM / len;
  const perpNorth = eastM / len;

  // 各方位（横オフセット）のレイで、遮蔽越えに必要な最低標高 H_block(u) を求める
  const blockHeights = await Promise.all(
    AZIMUTH_OFFSETS.map((u) => {
      const offMeters = u * burstRadius;
      const target: LatLng = {
        lat: launchSite.lat + (perpNorth * offMeters) / METERS_PER_DEG_LAT,
        lng: launchSite.lng + (perpEast * offMeters) / metersPerDegLng,
      };
      return blockHeightAlongRay(viewer, viewerElevation, target, buildings);
    }),
  );

  // 円盤内セルの可視判定（cellElev ≥ H_block(u) なら見えている）
  let total = 0;
  let visible = 0;
  for (let i = 0; i < AZIMUTH_OFFSETS.length; i++) {
    const u = AZIMUTH_OFFSETS[i];
    const hBlock = blockHeights[i];
    for (const v of HEIGHT_OFFSETS) {
      if (u * u + v * v > 1) continue; // 円盤外
      total++;
      const cellElev = burstCenterElev + v * burstRadius;
      if (cellElev >= hBlock) visible++;
    }
  }

  return { fraction: total > 0 ? visible / total : 1, buildingsKnown };
}

/**
 * 1本のレイ(viewer→target)に沿った遮蔽越えに必要な最低開花標高 H_block を返す。
 *
 * 地形サンプルと建物交差から遮蔽点 {t=水平距離比, O=遮蔽物頂上標高} を集め、
 * 各点を視線が越える条件 H ≥ viewerEye + (O − viewerEye)/t の最大を取る。
 * 遮蔽が無ければ -Infinity（＝どの高さでも見える）。
 */
async function blockHeightAlongRay(
  viewer: LatLng,
  viewerElevation: number,
  target: LatLng,
  buildings: Buildings,
): Promise<number> {
  const viewerEye = viewerElevation + 1.5;
  const rayDist = haversineDistance(viewer, target);
  if (rayDist < 1) return -Infinity;

  let hBlock = -Infinity;
  const consider = (t: number, obstacleElev: number): void => {
    if (t <= MIN_T) return;
    const required = viewerEye + (obstacleElev - viewerEye) / t;
    if (required > hBlock) hBlock = required;
  };

  // 1. 地形
  const samples = samplePointsBetween(viewer, target, TERRAIN_SAMPLE_INTERVAL);
  const groundElevs = await Promise.all(samples.map((s) => getElevation(s.lat, s.lng)));
  for (let i = 0; i < samples.length; i++) {
    const ground = groundElevs[i];
    if (ground === null) continue;
    consider(haversineDistance(viewer, samples[i]) / rayDist, ground);
  }

  // 2. 建物: レイと建物ポリゴンの交差点で「地面標高 + 建物高さ」
  if (buildings !== null && buildings.length > 0) {
    const rayDx = target.lng - viewer.lng;
    const rayDy = target.lat - viewer.lat;
    const rayMinLng = Math.min(viewer.lng, target.lng);
    const rayMaxLng = Math.max(viewer.lng, target.lng);
    const rayMinLat = Math.min(viewer.lat, target.lat);
    const rayMaxLat = Math.max(viewer.lat, target.lat);

    const hits: { t: number; height: number }[] = [];
    for (const building of buildings) {
      if (building.maxLng < rayMinLng || building.minLng > rayMaxLng ||
          building.maxLat < rayMinLat || building.minLat > rayMaxLat) {
        continue;
      }
      for (const t of findRayPolygonIntersections(viewer.lng, viewer.lat, rayDx, rayDy, building.coords)) {
        if (t > MIN_T && t < 0.99) hits.push({ t, height: building.height });
      }
    }

    const groundAtHit = await Promise.all(
      hits.map((h) => getElevation(viewer.lat + rayDy * h.t, viewer.lng + rayDx * h.t)),
    );
    for (let i = 0; i < hits.length; i++) {
      const ground = groundAtHit[i] ?? viewerElevation;
      consider(hits[i].t, ground + hits[i].height);
    }
  }

  return hBlock;
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

    const ex = x2 - x1;
    const ey = y2 - y1;

    // 連立方程式: o + t*d = p1 + s*e
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-15) continue; // 平行

    const t = ((x1 - ox) * ey - (y1 - oy) * ex) / denom;
    const s = ((x1 - ox) * dy - (y1 - oy) * dx) / denom;

    if (t > 0 && t < 1 && s >= 0 && s <= 1) {
      intersections.push(t);
    }
  }

  return intersections;
}
