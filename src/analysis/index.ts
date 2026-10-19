import type { AnalyzeRequest, AnalyzeResponse, ScorePointRequest, ScorePointResponse, GridPoint, ScoredPoint, GeoJSON } from '../types.js';
import { generateGrid, filterExclusionZones, haversineDistance } from './grid.js';

/** 打上地点まわりの立入禁止（保安）半径。開花直径相当、最低150m */
function safetyRadiusMeters(fireworkDiameter: number | undefined): number {
  return Math.max(fireworkDiameter ?? 150, 150);
}
import { getElevationBatch, getElevation } from './elevation.js';
import { quickScorePoint, fullScorePoint } from './scoring.js';
import { fetchLandUseAndBuildings, fetchBuildingsForLOS, clearLandUseCache } from './accessibility.js';
import { fetchPlateauBuildings, fetchPlateauBuildingsCorridor, getCachedPlateauBuildings } from './plateau.js';

/**
 * メインの分析処理
 */
export async function analyze(request: AnalyzeRequest): Promise<AnalyzeResponse> {
  const { launchSite, radiusMeters, fireworkDiameter } = request;

  // グリッド間隔をエリアサイズに応じて調整（採点メッシュの粒度）
  // 細かいほど良いが、点数は半径の2乗で増えるため半径で段階調整
  const spacing =
    radiusMeters <= 1000 ? 20 :
    radiusMeters <= 1500 ? 25 :
    radiusMeters <= 2000 ? 30 : 45;

  // 1. グリッド生成
  let gridLatLngs = generateGrid(launchSite, radiusMeters, spacing);

  // 1.5. 除外ゾーン内の候補を除去
  const exclusionZones = request.exclusionZones ?? [];
  if (exclusionZones.length > 0) {
    gridLatLngs = filterExclusionZones(gridLatLngs, exclusionZones);
  }

  // 1.6. 打上まわりの立入禁止（保安）圏内は採点対象外（絶対に立入禁止のため常に除外）
  const safetyRadius = safetyRadiusMeters(fireworkDiameter);
  gridLatLngs = gridLatLngs.filter((p) => haversineDistance(p, launchSite) >= safetyRadius);

  // 2. PLATEAU 建物と標高を並列取得
  const allPoints = [launchSite, ...gridLatLngs];
  const [, elevations] = await Promise.all([
    fetchPlateauBuildings(launchSite, radiusMeters),
    getElevationBatch(allPoints),
  ]);

  // 2.5. 建物は PLATEAU 優先。圏外(null)のときのみ OSM で建物＋土地利用を取得する。
  //      Tokyo(PLATEAU圏内) は Overpass 不要で高速。
  if (getCachedPlateauBuildings() === null) {
    await fetchLandUseAndBuildings(launchSite, radiusMeters);
  } else {
    clearLandUseCache(); // 場所スコアは「不明(0.9)」に（PLATEAU圏内は土地利用を引かない）
  }

  const launchSiteElevation = elevations[0] ?? 0;

  // 3. 標高データのある点のみフィルタ
  const gridPoints: GridPoint[] = [];
  for (let i = 1; i < allPoints.length; i++) {
    const elev = elevations[i];
    if (elev !== null) {
      gridPoints.push({
        lat: allPoints[i].lat,
        lng: allPoints[i].lng,
        elevation: elev,
      });
    }
  }

  // 4. パス1: スコア上限値でソート（分枝限定法）
  //    未計算の勾配・遮蔽を満点と仮定した上限値。遮蔽の良い地点も上位に来る。
  const ranked = gridPoints.map((point) => ({
    point,
    ...quickScorePoint(point, launchSite, launchSiteElevation, fireworkDiameter),
  }));
  ranked.sort((a, b) => b.quickScoreUB - a.quickScoreUB);

  // 5. パス2: 上限値の降順に本採点し、上限が現時点の上位K件の real を
  //    下回った時点で打ち切る（real ≤ 上限 が常に成立するため取りこぼしゼロ）
  const RESULT_K = 10;
  const scored: ScoredPoint[] = [];
  const topReals: number[] = []; // real total の上位K件（降順）
  let kthBestReal = -Infinity;

  for (const candidate of ranked) {
    if (scored.length >= RESULT_K && candidate.quickScoreUB <= kthBestReal) break;

    const sp = await fullScorePoint(candidate.point, launchSite, launchSiteElevation, fireworkDiameter);
    scored.push(sp);

    // 上位K件の real を維持
    const total = sp.score.total;
    let inserted = false;
    for (let j = 0; j < topReals.length; j++) {
      if (total > topReals[j]) { topReals.splice(j, 0, total); inserted = true; break; }
    }
    if (!inserted) topReals.push(total);
    if (topReals.length > RESULT_K) topReals.length = RESULT_K;
    if (topReals.length >= RESULT_K) kthBestReal = topReals[RESULT_K - 1];
  }

  const topPositions = [...scored].sort((a, b) => b.score.total - a.score.total).slice(0, 10);

  // 6. GeoJSON 生成（本採点=real、未採点=上限値でヒートマップ表示）
  const scoredFeatures: GeoJSON.Feature[] = scored.map((p) => ({
    type: 'Feature' as const,
    geometry: {
      type: 'Point' as const,
      coordinates: [p.lng, p.lat] as [number, number],
    },
    properties: {
      score: Math.round(p.score.total * 100) / 100,
      elevation: p.elevation,
      distance: p.distanceMeters,
      relativeElevation: p.relativeElevation,
      viewingAngle: p.viewingAngleDeg,
      scoreElevation: Math.round(p.score.elevation * 100) / 100,
      scoreLOS: Math.round(p.score.lineOfSight * 100) / 100,
      scoreSlope: Math.round(p.score.slope * 100) / 100,
      scoreAccess: Math.round(p.score.accessibility * 100) / 100,
    },
  }));

  const unscored = ranked.slice(scored.length);
  const restFeatures: GeoJSON.Feature[] = unscored.map((r) => ({
    type: 'Feature' as const,
    geometry: {
      type: 'Point' as const,
      coordinates: [r.point.lng, r.point.lat] as [number, number],
    },
    properties: {
      score: Math.round(r.quickScoreUB * 100) / 100,
      elevation: r.point.elevation,
      distance: Math.round(r.dist),
      relativeElevation: Math.round(r.relElev * 10) / 10,
      viewingAngle: Math.round(r.angleDeg * 10) / 10,
      scoreElevation: 0,
      scoreLOS: 0,
      scoreSlope: 0,
      scoreAccess: 0,
    },
  }));

  return {
    launchSite,
    launchSiteElevation,
    radiusMeters,
    safetyRadiusMeters: safetyRadius,
    totalPointsAnalyzed: gridPoints.length,
    topPositions,
    geojson: {
      type: 'FeatureCollection',
      features: [...scoredFeatures, ...restFeatures],
    },
  };
}

/**
 * 単一地点のスコアリング
 *
 * 標高取得を最優先し、Overpass は間に合った場合のみ反映する。
 * 標高データだけで計算できるスコア（仰角・標高・勾配）を先に確定し、
 * Overpass が応答すれば LOS・accessibility も加味する。
 */
export async function scorePoint(request: ScorePointRequest): Promise<ScorePointResponse> {
  const { launchSite, viewerLocation, fireworkDiameter } = request;

  // 打上まわりの立入禁止（保安）圏内は採点を拒否
  const safetyRadius = safetyRadiusMeters(fireworkDiameter);
  if (haversineDistance(viewerLocation, launchSite) < safetyRadius) {
    throw new Error(`打上地点から${safetyRadius}m以内は立入禁止エリアです`);
  }

  // PLATEAU 建物と標高を並列取得
  const [, launchSiteElevation, viewerElevation] = await Promise.all([
    fetchPlateauBuildingsCorridor(viewerLocation, launchSite),
    getElevation(launchSite.lat, launchSite.lng),
    getElevation(viewerLocation.lat, viewerLocation.lng),
  ]);

  // 建物は PLATEAU 優先。圏外(null)のときのみ OSM をフォールバック取得
  if (getCachedPlateauBuildings() === null) {
    await fetchBuildingsForLOS(viewerLocation, launchSite);
  } else {
    clearLandUseCache();
  }

  if (viewerElevation === null) {
    throw new Error('現在地の標高データを取得できませんでした');
  }

  const viewer = await fullScorePoint(
    { lat: viewerLocation.lat, lng: viewerLocation.lng, elevation: viewerElevation },
    launchSite,
    launchSiteElevation ?? 0,
    fireworkDiameter,
  );

  return { launchSite, launchSiteElevation: launchSiteElevation ?? 0, viewer };
}
