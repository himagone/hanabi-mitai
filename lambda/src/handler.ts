import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { AnalyzeRequest, AnalyzeResponse, GridPoint, GeoJSON } from './types.js';
import { generateGrid } from './grid.js';
import { getElevationBatch, clearTileCache } from './elevation.js';
import { scorePoint } from './scoring.js';

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
  const gridLatLngs = generateGrid(launchSite, radiusMeters, spacing);

  // 2. 全グリッド点 + 打上地点の標高を一括取得
  const allPoints = [launchSite, ...gridLatLngs];
  const elevations = await getElevationBatch(allPoints);

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

  // 4. 全点をスコアリング（並列処理、同時実行数制限付き）
  const CONCURRENCY = 20;
  const scoredPoints = new Array(gridPoints.length);

  for (let i = 0; i < gridPoints.length; i += CONCURRENCY) {
    const batch = gridPoints.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((point) => scorePoint(point, launchSite, launchSiteElevation)),
    );
    for (let j = 0; j < results.length; j++) {
      scoredPoints[i + j] = results[j];
    }
  }

  // 5. スコアでソート
  scoredPoints.sort((a, b) => b.score.total - a.score.total);

  // 6. GeoJSON 生成（全点のヒートマップ用 + トップ10）
  const features: GeoJSON.Feature[] = scoredPoints.map((p) => ({
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
    },
  }));

  return {
    launchSite,
    launchSiteElevation,
    radiusMeters,
    totalPointsAnalyzed: gridPoints.length,
    topPositions: scoredPoints.slice(0, 10),
    geojson: {
      type: 'FeatureCollection',
      features,
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

    // キャッシュクリア（Lambda の再利用時に古いデータを防ぐ）
    clearTileCache();

    const result = await analyze({ launchSite: request.launchSite, radiusMeters });

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
