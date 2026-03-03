import maplibregl from 'maplibre-gl';
import type { AnalyzeResponse, ExclusionZone } from './types.js';

const GEOLONIA_STYLE = `https://cdn.geolonia.com/style/geolonia/gsi/ja.json`;

let map: maplibregl.Map | null = null;
let launchMarker: maplibregl.Marker | null = null;
const topMarkers: maplibregl.Marker[] = [];

// --- 除外ゾーン描画 ---
let drawingMode = false;
let currentVertices: [number, number][] = []; // [lng, lat][]
const exclusionZones: ExclusionZone[] = [];
let onMapClickHandler: ((lat: number, lng: number) => void) | null = null;
let onDrawingChangeHandler: (() => void) | null = null;
let cursorLngLat: [number, number] | null = null;

// 最初の頂点をクリックで閉じるための判定距離（ピクセル）
const CLOSE_SNAP_PX = 12;

/**
 * 地図を初期化
 */
export function initMap(
  container: string | HTMLElement,
  onMapClick: (lat: number, lng: number) => void,
): maplibregl.Map {
  onMapClickHandler = onMapClick;

  map = new maplibregl.Map({
    container,
    style: GEOLONIA_STYLE,
    center: [139.6917, 35.6895],
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

  map.on('click', handleMapClick);

  map.on('dblclick', (e) => {
    if (drawingMode) {
      e.preventDefault();
    }
  });

  map.on('mousemove', (e) => {
    if (!drawingMode || currentVertices.length === 0) return;
    cursorLngLat = [e.lngLat.lng, e.lngLat.lat];

    // 最初の頂点に近いかチェック → カーソル変更
    if (currentVertices.length >= 3 && isNearFirstVertex(e.point)) {
      map!.getCanvas().style.cursor = 'pointer';
    } else {
      map!.getCanvas().style.cursor = 'crosshair';
    }

    updateDrawingPreview();
  });

  map.on('load', () => {
    initDrawingLayers();
  });

  return map;
}

/**
 * 描画変更時のコールバックを登録
 */
export function onDrawingChange(cb: () => void): void {
  onDrawingChangeHandler = cb;
}

/**
 * マップクリックハンドラー
 */
function handleMapClick(e: maplibregl.MapMouseEvent): void {
  if (!drawingMode) {
    onMapClickHandler?.(e.lngLat.lat, e.lngLat.lng);
    return;
  }

  // 3点以上打ったら最初の頂点付近クリックで確定
  if (currentVertices.length >= 3 && isNearFirstVertex(e.point)) {
    finishDrawing();
    return;
  }

  currentVertices.push([e.lngLat.lng, e.lngLat.lat]);
  cursorLngLat = null;
  updateDrawingPreview();
  onDrawingChangeHandler?.();
}

/**
 * クリック位置が最初の頂点に十分近いか判定
 */
function isNearFirstVertex(screenPoint: maplibregl.Point): boolean {
  if (!map || currentVertices.length === 0) return false;
  const firstPx = map.project(currentVertices[0] as [number, number]);
  const dx = screenPoint.x - firstPx.x;
  const dy = screenPoint.y - firstPx.y;
  return Math.sqrt(dx * dx + dy * dy) < CLOSE_SNAP_PX;
}

/**
 * 描画用レイヤーの初期化
 */
function initDrawingLayers(): void {
  if (!map) return;

  // 確定済み除外ゾーン
  map.addSource('exclusion-zones', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addLayer({
    id: 'exclusion-zones-fill',
    type: 'fill',
    source: 'exclusion-zones',
    paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.25 },
  });

  map.addLayer({
    id: 'exclusion-zones-outline',
    type: 'line',
    source: 'exclusion-zones',
    paint: { 'line-color': '#ef4444', 'line-width': 2, 'line-dasharray': [3, 2] },
  });

  // 描画中ポリゴン塗り（プレビュー）
  map.addSource('drawing-polygon', {
    type: 'geojson',
    data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[]] }, properties: {} },
  });

  map.addLayer({
    id: 'drawing-polygon-fill',
    type: 'fill',
    source: 'drawing-polygon',
    paint: { 'fill-color': '#f97316', 'fill-opacity': 0.15 },
  });

  // 描画中のライン（確定辺）
  map.addSource('drawing-line', {
    type: 'geojson',
    data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} },
  });

  map.addLayer({
    id: 'drawing-line-layer',
    type: 'line',
    source: 'drawing-line',
    paint: { 'line-color': '#f97316', 'line-width': 2.5 },
  });

  // カーソル追従ライン（点線）
  map.addSource('drawing-cursor-line', {
    type: 'geojson',
    data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} },
  });

  map.addLayer({
    id: 'drawing-cursor-line-layer',
    type: 'line',
    source: 'drawing-cursor-line',
    paint: { 'line-color': '#f97316', 'line-width': 1.5, 'line-dasharray': [4, 3], 'line-opacity': 0.7 },
  });

  // 描画中の頂点
  map.addSource('drawing-vertices', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // 始点マーカー（大きめ、閉じる操作用）
  map.addLayer({
    id: 'drawing-first-vertex',
    type: 'circle',
    source: 'drawing-vertices',
    filter: ['==', ['get', 'isFirst'], true],
    paint: {
      'circle-radius': 7,
      'circle-color': '#fff',
      'circle-stroke-color': '#f97316',
      'circle-stroke-width': 3,
    },
  });

  // 通常の頂点
  map.addLayer({
    id: 'drawing-vertices-layer',
    type: 'circle',
    source: 'drawing-vertices',
    filter: ['==', ['get', 'isFirst'], false],
    paint: {
      'circle-radius': 5,
      'circle-color': '#f97316',
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 2,
    },
  });
}

/**
 * 描画モードの開始
 */
export function startDrawing(): void {
  drawingMode = true;
  currentVertices = [];
  cursorLngLat = null;
  if (map) {
    map.getCanvas().style.cursor = 'crosshair';
    map.doubleClickZoom.disable();
  }
}

/**
 * 描画モードのキャンセル
 */
export function cancelDrawing(): void {
  drawingMode = false;
  currentVertices = [];
  cursorLngLat = null;
  if (map) {
    map.getCanvas().style.cursor = '';
    map.doubleClickZoom.enable();
  }
  updateDrawingPreview();
  onDrawingChangeHandler?.();
}

/**
 * 最後の頂点を1つ取り消し
 */
export function undoLastVertex(): void {
  if (currentVertices.length > 0) {
    currentVertices.pop();
    updateDrawingPreview();
    onDrawingChangeHandler?.();
  }
}

/**
 * 描画中のプレビューを更新
 */
function updateDrawingPreview(): void {
  if (!map) return;

  const lineSource = map.getSource('drawing-line') as maplibregl.GeoJSONSource | undefined;
  const cursorLineSource = map.getSource('drawing-cursor-line') as maplibregl.GeoJSONSource | undefined;
  const vertexSource = map.getSource('drawing-vertices') as maplibregl.GeoJSONSource | undefined;
  const polygonSource = map.getSource('drawing-polygon') as maplibregl.GeoJSONSource | undefined;

  // 確定済みの辺（頂点間のライン）
  if (lineSource) {
    lineSource.setData({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: currentVertices.length >= 2 ? currentVertices : [],
      },
      properties: {},
    });
  }

  // カーソル追従ライン: 最後の頂点→カーソル & カーソル→最初の頂点
  if (cursorLineSource) {
    const coords: [number, number][] = [];
    if (currentVertices.length >= 1 && cursorLngLat) {
      // 最後の頂点 → カーソル
      coords.push(currentVertices[currentVertices.length - 1], cursorLngLat);
      // カーソル → 最初の頂点（3点以上なら閉じるプレビュー）
      if (currentVertices.length >= 2) {
        coords.push(cursorLngLat, currentVertices[0]);
      }
    }
    cursorLineSource.setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {},
    });
  }

  // ポリゴン塗りプレビュー
  if (polygonSource) {
    let ring: [number, number][] = [];
    if (currentVertices.length >= 2 && cursorLngLat) {
      ring = [...currentVertices, cursorLngLat, currentVertices[0]];
    } else if (currentVertices.length >= 3) {
      ring = [...currentVertices, currentVertices[0]];
    }
    polygonSource.setData({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: ring.length > 0 ? [ring] : [[]] },
      properties: {},
    });
  }

  // 頂点マーカー
  if (vertexSource) {
    vertexSource.setData({
      type: 'FeatureCollection',
      features: currentVertices.map((c, i) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: c },
        properties: { isFirst: i === 0 && currentVertices.length >= 3 },
      })),
    });
  }
}

/**
 * 描画を確定
 */
export function finishDrawing(): void {
  if (currentVertices.length < 3) {
    cancelDrawing();
    return;
  }

  exclusionZones.push([...currentVertices]);
  drawingMode = false;
  currentVertices = [];
  cursorLngLat = null;
  if (map) {
    map.getCanvas().style.cursor = '';
    map.doubleClickZoom.enable();
  }
  updateDrawingPreview();
  renderExclusionZones();
  onDrawingChangeHandler?.();
}

/**
 * 確定済み除外ゾーンを描画
 */
function renderExclusionZones(): void {
  if (!map) return;

  const source = map.getSource('exclusion-zones') as maplibregl.GeoJSONSource | undefined;
  if (!source) return;

  source.setData({
    type: 'FeatureCollection',
    features: exclusionZones.map((zone, i) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[...zone, zone[0]]],
      },
      properties: { index: i },
    })),
  });
}

/**
 * 全除外ゾーンをクリア
 */
export function clearExclusionZones(): void {
  exclusionZones.length = 0;
  renderExclusionZones();
}

/**
 * 最後に追加した除外ゾーンを取り消し
 */
export function undoLastExclusionZone(): void {
  exclusionZones.pop();
  renderExclusionZones();
}

/**
 * 現在の除外ゾーンを取得
 */
export function getExclusionZones(): ExclusionZone[] {
  return [...exclusionZones];
}

/**
 * 描画中かどうか
 */
export function isDrawing(): boolean {
  return drawingMode;
}

/**
 * 描画中の頂点数
 */
export function getVertexCount(): number {
  return currentVertices.length;
}

// --- 打上地点・結果表示（変更なし） ---

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

export function clearResults(): void {
  if (!map) return;

  if (map.getLayer('heatmap-layer')) map.removeLayer('heatmap-layer');
  if (map.getLayer('score-circles')) map.removeLayer('score-circles');
  if (map.getSource('scored-points')) map.removeSource('scored-points');

  for (const m of topMarkers) {
    m.remove();
  }
  topMarkers.length = 0;
}

function scoreColor(score: number): string {
  if (score >= 0.7) return '#22c55e';
  if (score >= 0.5) return '#eab308';
  if (score >= 0.3) return '#f97316';
  return '#ef4444';
}

export function renderResults(response: AnalyzeResponse): void {
  if (!map) return;

  clearResults();

  const geojson = response.geojson;

  map.addSource('scored-points', {
    type: 'geojson',
    data: geojson as unknown as maplibregl.GeoJSONSourceSpecification['data'],
  });

  map.addLayer({
    id: 'heatmap-layer',
    type: 'heatmap',
    source: 'scored-points',
    paint: {
      'heatmap-weight': ['get', 'score'],
      'heatmap-intensity': 1.5,
      'heatmap-radius': 25,
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
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

  map.addLayer({
    id: 'score-circles',
    type: 'circle',
    source: 'scored-points',
    minzoom: 14,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 3, 18, 10],
      'circle-color': [
        'interpolate', ['linear'], ['get', 'score'],
        0, '#ef4444', 0.3, '#f97316', 0.5, '#eab308', 0.7, '#22c55e',
      ],
      'circle-opacity': 0.6,
      'circle-stroke-width': 1,
      'circle-stroke-color': 'rgba(255,255,255,0.3)',
    },
  });

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
           距離: ${p.distance}m / 仰角: ${p.viewingAngle}°<br>
           標高差: ${p.relativeElevation > 0 ? '+' : ''}${p.relativeElevation}m<br>
           視線: ${(p.scoreLOS * 100).toFixed(0)}%<br>
           ${p.reason}
         </div>`,
      )
      .addTo(map!);
  });

  map.on('mouseenter', 'score-circles', () => {
    if (map && !drawingMode) map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'score-circles', () => {
    if (map && !drawingMode) map.getCanvas().style.cursor = '';
  });

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
         距離: ${p.distanceMeters}m / 仰角: ${p.viewingAngleDeg}°<br>
         標高差: ${p.relativeElevation > 0 ? '+' : ''}${p.relativeElevation}m<br>
         視界: ${(p.score.lineOfSight * 100).toFixed(0)}% / 場所: ${(p.score.accessibility * 100).toFixed(0)}%<br>
         ${p.reason}
       </div>`,
    );

    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([p.lng, p.lat])
      .setPopup(popup)
      .addTo(map);

    topMarkers.push(marker);
  }

  const bounds = new maplibregl.LngLatBounds();
  bounds.extend([response.launchSite.lng, response.launchSite.lat]);
  for (const p of top) {
    bounds.extend([p.lng, p.lat]);
  }
  map.fitBounds(bounds, { padding: 60, maxZoom: 15 });
}

export function focusOnPosition(index: number): void {
  if (!map || index >= topMarkers.length) return;
  const lngLat = topMarkers[index].getLngLat();
  map.flyTo({ center: lngLat, zoom: 16 });
  topMarkers[index].togglePopup();
}
