/** 緯度経度 */
export interface LatLng {
  lat: number;
  lng: number;
}

/** 分析リクエスト */
export interface AnalyzeRequest {
  launchSite: LatLng;
  radiusMeters: number;
}

/** スコアの内訳 */
export interface ScoreBreakdown {
  viewingAngle: number;
  elevation: number;
  lineOfSight: number;
  slope: number;
  total: number;
}

/** スコア付き地点 */
export interface ScoredPoint {
  lat: number;
  lng: number;
  elevation: number;
  distanceMeters: number;
  relativeElevation: number;
  viewingAngleDeg: number;
  score: ScoreBreakdown;
  reason: string;
}

/** 分析レスポンス */
export interface AnalyzeResponse {
  launchSite: LatLng;
  launchSiteElevation: number;
  radiusMeters: number;
  totalPointsAnalyzed: number;
  topPositions: ScoredPoint[];
  geojson: GeoJSON.FeatureCollection;
}

/** GeoJSON 型定義 */
export namespace GeoJSON {
  export interface Point {
    type: 'Point';
    coordinates: [number, number];
  }

  export interface Feature {
    type: 'Feature';
    geometry: Point;
    properties: Record<string, unknown>;
  }

  export interface FeatureCollection {
    type: 'FeatureCollection';
    features: Feature[];
  }
}
