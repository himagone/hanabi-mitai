import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { AnalyzeRequest, AnalyzeResponse, GridPoint, GeoJSON } from './types.js';
import { generateGrid, filterExclusionZones } from './grid.js';
import { getElevationBatch } from './elevation.js';
import { quickScorePoint, fullScorePoint } from './scoring.js';
import { fetchLandUseAndBuildings } from './accessibility.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function errorResponse(statusCode: number, message: string): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error: message }),
  };
}

/**
 * メインの分析処理
 */
async function analyze(request: AnalyzeRequest): Promise<AnalyzeResponse> {
  const { launchSite, radiusMeters } = request;

  // グリッド間隔をエリアサイズに応じて調整
  const spacing = radiusMeters <= 1000 ? 40 : radiusMeters <= 2000 ? 50 : 70;

  // 1. グリッド生成
  let gridLatLngs = generateGrid(launchSite, radiusMeters, spacing);

  // 1.5. 除外ゾーン内の候補を除去
  const exclusionZones = request.exclusionZones ?? [];
  if (exclusionZones.length > 0) {
    gridLatLngs = filterExclusionZones(gridLatLngs, exclusionZones);
  }

  // 2. OSM データ取得と標高取得を並列実行
  const allPoints = [launchSite, ...gridLatLngs];
  const [, elevations] = await Promise.all([
    fetchLandUseAndBuildings(launchSite, radiusMeters),
    getElevationBatch(allPoints),
  ]);

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

  // 4. パス1: 高速な事前スコアリング（CPU のみ、ネットワーク不要）
  const quickResults = gridPoints.map((point, idx) => ({
    idx,
    point,
    ...quickScorePoint(point, launchSite, launchSiteElevation),
  }));

  // 事前スコアでソートし、上位候補を抽出
  quickResults.sort((a, b) => b.quickScore - a.quickScore);
  const TOP_N = 50;
  const candidates = quickResults.slice(0, TOP_N);
  const rest = quickResults.slice(TOP_N);

  // 5. パス2: 上位候補の LOS・勾配用のタイルを事前取得
  const prefetchPoints: import('./types.js').LatLng[] = [];
  const LOS_SAMPLES = 10;
  const SLOPE_DELTA = 0.0003;

  for (const c of candidates) {
    const p = c.point;
    // LOS サンプル点
    for (let s = 1; s <= LOS_SAMPLES; s++) {
      const t = s / (LOS_SAMPLES + 1);
      prefetchPoints.push({
        lat: p.lat + (launchSite.lat - p.lat) * t,
        lng: p.lng + (launchSite.lng - p.lng) * t,
      });
    }
    // 勾配の隣接点
    prefetchPoints.push(
      { lat: p.lat + SLOPE_DELTA, lng: p.lng },
      { lat: p.lat - SLOPE_DELTA, lng: p.lng },
      { lat: p.lat, lng: p.lng + SLOPE_DELTA },
      { lat: p.lat, lng: p.lng - SLOPE_DELTA },
    );
  }
  await getElevationBatch(prefetchPoints);

  // フルスコアリング（タイルはキャッシュ済みなので高速）
  const scoredTop = await Promise.all(
    candidates.map((c) => fullScorePoint(c.point, launchSite, launchSiteElevation)),
  );

  scoredTop.sort((a, b) => b.score.total - a.score.total);

  // 6. GeoJSON 生成（全点のヒートマップ用 + トップ10の詳細）
  // 上位候補: フルスコア
  const topFeatures: GeoJSON.Feature[] = scoredTop.map((p) => ({
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
      reason: p.reason,
      scoreViewingAngle: Math.round(p.score.viewingAngle * 100) / 100,
      scoreElevation: Math.round(p.score.elevation * 100) / 100,
      scoreLOS: Math.round(p.score.lineOfSight * 100) / 100,
      scoreSlope: Math.round(p.score.slope * 100) / 100,
      scoreAccess: Math.round(p.score.accessibility * 100) / 100,
    },
  }));

  // 残り: 概算スコアでヒートマップ表示
  const restFeatures: GeoJSON.Feature[] = rest.map((r) => ({
    type: 'Feature' as const,
    geometry: {
      type: 'Point' as const,
      coordinates: [r.point.lng, r.point.lat] as [number, number],
    },
    properties: {
      score: Math.round(r.quickScore * 100) / 100,
      elevation: r.point.elevation,
      distance: Math.round(r.dist),
      relativeElevation: Math.round(r.relElev * 10) / 10,
      viewingAngle: Math.round(r.angleDeg * 10) / 10,
      reason: '',
      scoreViewingAngle: 0,
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
    totalPointsAnalyzed: gridPoints.length,
    topPositions: scoredTop.slice(0, 10),
    geojson: {
      type: 'FeatureCollection',
      features: [...topFeatures, ...restFeatures],
    },
  };
}

/**
 * Lambda ハンドラー
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  // CORS preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    if (!event.body) {
      return errorResponse(400, 'リクエストボディが必要です');
    }

    const request: AnalyzeRequest = JSON.parse(event.body);

    // バリデーション
    if (
      !request.launchSite ||
      typeof request.launchSite.lat !== 'number' ||
      typeof request.launchSite.lng !== 'number'
    ) {
      return errorResponse(400, '打上地点の緯度経度が必要です');
    }

    if (request.launchSite.lat < 20 || request.launchSite.lat > 46) {
      return errorResponse(400, '緯度は日本国内 (20〜46) を指定してください');
    }

    if (request.launchSite.lng < 122 || request.launchSite.lng > 154) {
      return errorResponse(400, '経度は日本国内 (122〜154) を指定してください');
    }

    const radiusMeters = request.radiusMeters || 2000;
    if (radiusMeters < 500 || radiusMeters > 5000) {
      return errorResponse(400, '検索半径は 500〜5000m を指定してください');
    }

    const result = await analyze({
      launchSite: request.launchSite,
      radiusMeters,
      exclusionZones: request.exclusionZones,
    });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error('Analysis error:', err);
    return errorResponse(500, '分析処理でエラーが発生しました');
  }
}
