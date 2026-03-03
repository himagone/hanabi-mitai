import maplibregl from 'maplibre-gl';
import type { AnalyzeResponse, GeoJSON } from './types.js';

const GEOLONIA_STYLE = `https://cdn.geolonia.com/style/geolonia/gsi/ja.json`;

let map: maplibregl.Map | null = null;
let launchMarker: maplibregl.Marker | null = null;
const topMarkers: maplibregl.Marker[] = [];

/**
 * 地図を初期化
 */
export function initMap(
  container: string | HTMLElement,
  onMapClick: (lat: number, lng: number) => void,
): maplibregl.Map {
  map = new maplibregl.Map({
    container,
    style: GEOLONIA_STYLE,
    center: [139.6917, 35.6895], // 東京
    zoom: 12,
    pitch: 0,
  });

  map.addControl(new maplibregl.NavigationControl(), 'top-left');
  map.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: false,
    }),
    'top-left',
  );

  map.on('click', (e) => {
    onMapClick(e.lngLat.lat, e.lngLat.lng);
  });

  return map;
}

/**
 * 打上地点マーカーを設置
 */
export function setLaunchMarker(lat: number, lng: number): void {
  if (!map) return;

  if (launchMarker) {
    launchMarker.remove();
  }

  const el = document.createElement('div');
  el.innerHTML = `<svg width="32" height="32" viewBox="0 0 32 32">
    <circle cx="16" cy="16" r="14" fill="#ff6b35" stroke="#fff" stroke-width="2"/>
    <text x="16" y="21" text-anchor="middle" fill="#fff" font-size="16" font-weight="bold">*</text>
  </svg>`;

  launchMarker = new maplibregl.Marker({ element: el })
    .setLngLat([lng, lat])
    .setPopup(
      new maplibregl.Popup({ offset: 20 }).setHTML(
        `<div class="popup-title">打上地点</div>
         <div class="popup-detail">${lat.toFixed(4)}, ${lng.toFixed(4)}</div>`,
      ),
    )
    .addTo(map);
}

/**
 * 分析結果をクリア
 */
export function clearResults(): void {
  if (!map) return;

  // ヒートマップレイヤーを削除
  if (map.getLayer('heatmap-layer')) map.removeLayer('heatmap-layer');
  if (map.getLayer('score-circles')) map.removeLayer('score-circles');
  if (map.getSource('scored-points')) map.removeSource('scored-points');

  // トップマーカーを削除
  for (const m of topMarkers) {
    m.remove();
  }
  topMarkers.length = 0;
}

/**
 * スコアに応じた色を返す
 */
function scoreColor(score: number): string {
  if (score >= 0.7) return '#22c55e'; // 緑
  if (score >= 0.5) return '#eab308'; // 黄
  if (score >= 0.3) return '#f97316'; // オレンジ
  return '#ef4444'; // 赤
}

/**
 * 分析結果を地図に描画
 */
export function renderResults(response: AnalyzeResponse): void {
  if (!map) return;

  clearResults();

  const geojson = response.geojson;

  // ソースを追加
  map.addSource('scored-points', {
    type: 'geojson',
    data: geojson as unknown as maplibregl.GeoJSONSourceSpecification['data'],
  });

  // ヒートマップレイヤー
  map.addLayer({
    id: 'heatmap-layer',
    type: 'heatmap',
    source: 'scored-points',
    paint: {
      'heatmap-weight': ['get', 'score'],
      'heatmap-intensity': 1.5,
      'heatmap-radius': 25,
      'heatmap-color': [
        'interpolate',
        ['linear'],
        ['heatmap-density'],
        0, 'rgba(0,0,0,0)',
        0.2, 'rgba(0,0,255,0.3)',
        0.4, 'rgba(0,255,255,0.4)',
        0.6, 'rgba(0,255,0,0.5)',
        0.8, 'rgba(255,255,0,0.6)',
        1, 'rgba(255,0,0,0.7)',
      ],
      'heatmap-opacity': 0.7,
    },
  });

  // スコア円レイヤー（ズームイン時）
  map.addLayer({
    id: 'score-circles',
    type: 'circle',
    source: 'scored-points',
    minzoom: 14,
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        14, 3,
        18, 10,
      ],
      'circle-color': [
        'interpolate',
        ['linear'],
        ['get', 'score'],
        0, '#ef4444',
        0.3, '#f97316',
        0.5, '#eab308',
        0.7, '#22c55e',
      ],
      'circle-opacity': 0.6,
      'circle-stroke-width': 1,
      'circle-stroke-color': 'rgba(255,255,255,0.3)',
    },
  });

  // ズームイン時にクリックでポップアップ
  map.on('click', 'score-circles', (e) => {
    if (!e.features || e.features.length === 0) return;
    const f = e.features[0];
    const coords = (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
    const p = f.properties!;

    new maplibregl.Popup({ offset: 10 })
      .setLngLat(coords)
      .setHTML(
        `<div class="popup-title">スコア: ${(p.score * 100).toFixed(0)}点</div>
         <div class="popup-detail">
           距離: ${p.distance}m<br>
           標高差: ${p.relativeElevation > 0 ? '+' : ''}${p.relativeElevation}m<br>
           視線: ${(p.scoreLOS * 100).toFixed(0)}%<br>
           ${p.reason}
         </div>`,
      )
      .addTo(map!);
  });

  map.on('mouseenter', 'score-circles', () => {
    if (map) map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'score-circles', () => {
    if (map) map.getCanvas().style.cursor = '';
  });

  // トップ10のマーカー
  const top = response.topPositions.slice(0, 10);
  for (let i = 0; i < top.length; i++) {
    const p = top[i];
    const color = scoreColor(p.score.total);

    const el = document.createElement('div');
    el.innerHTML = `<svg width="28" height="28" viewBox="0 0 28 28">
      <circle cx="14" cy="14" r="12" fill="${color}" stroke="#fff" stroke-width="2"/>
      <text x="14" y="18" text-anchor="middle" fill="#fff" font-size="12" font-weight="bold">${i + 1}</text>
    </svg>`;
    el.style.cursor = 'pointer';

    const popup = new maplibregl.Popup({ offset: 18 }).setHTML(
      `<div class="popup-title">#${i + 1} スコア: ${(p.score.total * 100).toFixed(0)}点</div>
       <div class="popup-detail">
         距離: ${p.distanceMeters}m / 標高差: ${p.relativeElevation > 0 ? '+' : ''}${p.relativeElevation}m<br>
         視界: ${(p.score.lineOfSight * 100).toFixed(0)}% / 勾配: ${(p.score.slope * 100).toFixed(0)}%<br>
         ${p.reason}
       </div>`,
    );

    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([p.lng, p.lat])
      .setPopup(popup)
      .addTo(map);

    topMarkers.push(marker);
  }

  // 結果全体が見える範囲にフィット
  const bounds = new maplibregl.LngLatBounds();
  bounds.extend([response.launchSite.lng, response.launchSite.lat]);
  for (const p of top) {
    bounds.extend([p.lng, p.lat]);
  }
  map.fitBounds(bounds, { padding: 60, maxZoom: 15 });
}

/**
 * トップNの特定マーカーにフォーカス
 */
export function focusOnPosition(index: number): void {
  if (!map || index >= topMarkers.length) return;
  const lngLat = topMarkers[index].getLngLat();
  map.flyTo({ center: lngLat, zoom: 16 });
  topMarkers[index].togglePopup();
}
