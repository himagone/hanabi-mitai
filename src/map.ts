import maplibregl from 'maplibre-gl';
import { useGsiTerrainSource } from 'maplibre-gl-gsi-terrain';
import type { AnalyzeResponse, ExclusionZone } from './types.js';

const GEOLONIA_STYLE = `https://cdn.geolonia.com/style/geolonia/gsi/ja.json`;
const MIN_DRAG_PX = 8;

/**
 * PLATEAU 建物ベクトルタイル（東京23区・実測高さ measuredHeight 付き）。
 * source-layer は `bldg`。23区外は建物が表示されない（地形は全国で表示）。
 */
const PLATEAU_BLDG_TILES =
  'https://indigo-lab.github.io/plateau-tokyo23ku-building-mvt-2020/{z}/{x}/{y}.pbf';
/** 3D 表示時の地図の傾き（度）。歩行者目線に近い、ほぼ水平の見上げ角 */
const PITCH_3D = 80;
/** 3D 建物レイヤーの最小ズーム（これ未満だと建物が描画されない） */
const BLDG_MIN_ZOOM = 13;
/** 3D ON 時に引き寄せる最小ズーム（街路に立つ感覚が出る近さ） */
const ZOOM_3D = 16;

// --- Map references ---
let map: maplibregl.Map | null = null;
let launchMarker: maplibregl.Marker | null = null;
let viewerMarker: maplibregl.Marker | null = null;
const topMarkers: maplibregl.Marker[] = [];

// --- Editor state ---
type EditorState =
  | { mode: 'idle' }
  | { mode: 'drawing-rect'; start: [number, number] | null; current: [number, number] | null }
  | { mode: 'selected'; zoneIndex: number; dragIndex: number | null };

let state: EditorState = { mode: 'idle' };
const exclusionZones: ExclusionZone[] = [];

let mapClickHandler: ((lat: number, lng: number) => void) | null = null;
let stateChangeHandler: (() => void) | null = null;
let preventNextClick = false;

// --- Geometry helpers ---

function rectToPolygon(a: [number, number], b: [number, number]): [number, number][] {
  return [
    [a[0], a[1]],
    [b[0], a[1]],
    [b[0], b[1]],
    [a[0], b[1]],
  ];
}

function screenDist(a: [number, number], b: [number, number]): number {
  if (!map) return 0;
  const pa = map.project(a);
  const pb = map.project(b);
  return Math.sqrt((pa.x - pb.x) ** 2 + (pa.y - pb.y) ** 2);
}

// --- Initialization ---

export function initMap(
  container: string | HTMLElement,
  onMapClick: (lat: number, lng: number) => void,
): maplibregl.Map {
  mapClickHandler = onMapClick;

  map = new maplibregl.Map({
    container,
    style: GEOLONIA_STYLE,
    center: [139.6917, 35.6895],
    zoom: 12,
    pitch: 0,
    maxPitch: 85, // 歩行者目線（ほぼ水平）を許可。既定の 60° では届かない
  });

  map.addControl(new maplibregl.NavigationControl(), 'top-left');
  map.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: false,
    }),
    'top-left',
  );
  map.addControl(new ThreeDToggleControl(), 'top-left');

  map.on('load', () => {
    initLayers();
    map!.resize();

    // スプラッシュ：地図ロード完了 & 花火3発完了の両方を待つ
    const splash = document.getElementById('splash');
    if (splash) {
      const dismiss = () => {
        splash.classList.add('fade-out');
        splash.addEventListener('transitionend', () => splash.remove());
      };
      // 3発目の花火完了 = 1.85s(delay) + 0.9s(duration) ≈ 2.8s
      const elapsed = performance.now();
      const remaining = Math.max(0, 2800 - elapsed);
      setTimeout(dismiss, remaining);
    }
  });

  // フォント・スタイル適用完了後にコンテナサイズを再計測
  document.fonts.ready.then(() => map?.resize());
  window.addEventListener('resize', () => map?.resize());
  map.on('click', handleClick);
  map.on('mousedown', handleMouseDown);
  map.on('mousemove', handleMouseMove);
  map.on('mouseup', handleMouseUp);

  // Vertex drag
  map.on('mousedown', 'selected-vertices-layer', (e) => {
    if (state.mode !== 'selected' || !e.features?.length) return;
    e.preventDefault();
    state.dragIndex = e.features[0].properties!.index as number;
    map!.dragPan.disable();
    map!.getCanvas().style.cursor = 'grabbing';
    preventNextClick = true;
  });

  // Midpoint drag → insert vertex then drag
  map.on('mousedown', 'selected-midpoints-layer', (e) => {
    if (state.mode !== 'selected' || !e.features?.length) return;
    e.preventDefault();
    const edgeIdx = e.features[0].properties!.index as number;
    exclusionZones[state.zoneIndex].splice(edgeIdx + 1, 0, [e.lngLat.lng, e.lngLat.lat]);
    state.dragIndex = edgeIdx + 1;
    map!.dragPan.disable();
    map!.getCanvas().style.cursor = 'grabbing';
    preventNextClick = true;
    renderAll();
  });

  // Cursor feedback
  map.on('mouseenter', 'selected-vertices-layer', () => {
    if (state.mode === 'selected' && state.dragIndex === null)
      map!.getCanvas().style.cursor = 'grab';
  });
  map.on('mouseleave', 'selected-vertices-layer', () => {
    if (state.mode === 'selected' && state.dragIndex === null)
      map!.getCanvas().style.cursor = '';
  });
  map.on('mouseenter', 'selected-midpoints-layer', () => {
    if (state.mode === 'selected' && state.dragIndex === null)
      map!.getCanvas().style.cursor = 'copy';
  });
  map.on('mouseleave', 'selected-midpoints-layer', () => {
    if (state.mode === 'selected' && state.dragIndex === null)
      map!.getCanvas().style.cursor = '';
  });
  map.on('mouseenter', 'exclusion-zones-fill', () => {
    if (state.mode === 'idle') map!.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'exclusion-zones-fill', () => {
    if (state.mode === 'idle') map!.getCanvas().style.cursor = '';
  });

  // Keyboard
  document.addEventListener('keydown', handleKeyDown);

  // Handle mouseup outside map
  document.addEventListener('mouseup', handleGlobalMouseUp);

  return map;
}

export function onStateChange(cb: () => void): void {
  stateChangeHandler = cb;
}
export const onDrawingChange = onStateChange;

// --- Event handlers ---

function handleClick(e: maplibregl.MapMouseEvent): void {
  if (!map) return;
  if (preventNextClick) { preventNextClick = false; return; }

  // Rect mode is handled by mousedown/up, not click
  if (state.mode === 'drawing-rect') return;

  // Click on zone → select
  const zoneFeatures = map.queryRenderedFeatures(e.point, {
    layers: ['exclusion-zones-fill'],
  });
  if (zoneFeatures.length > 0) {
    selectZone(zoneFeatures[0].properties!.index as number);
    return;
  }

  // Selected → deselect
  if (state.mode === 'selected') {
    deselectZone();
    return;
  }

  // Idle → launch point
  mapClickHandler?.(e.lngLat.lat, e.lngLat.lng);
}

function handleMouseDown(e: maplibregl.MapMouseEvent): void {
  if (!map) return;

  // Start rect drag
  if (state.mode === 'drawing-rect' && !state.start) {
    state.start = [e.lngLat.lng, e.lngLat.lat];
    state.current = [e.lngLat.lng, e.lngLat.lat];
    preventNextClick = true;
    return;
  }

}

function handleMouseMove(e: maplibregl.MapMouseEvent): void {
  if (!map) return;

  // Vertex dragging
  if (state.mode === 'selected' && state.dragIndex !== null) {
    const zone = exclusionZones[state.zoneIndex];
    if (zone && state.dragIndex < zone.length) {
      zone[state.dragIndex] = [e.lngLat.lng, e.lngLat.lat];
      renderAll();
    }
    return;
  }

  // Rect preview
  if (state.mode === 'drawing-rect' && state.start) {
    state.current = [e.lngLat.lng, e.lngLat.lat];
    renderShapePreview();
    return;
  }

}

function handleMouseUp(e: maplibregl.MapMouseEvent): void {
  if (!map) return;

  // End vertex drag
  if (state.mode === 'selected' && state.dragIndex !== null) {
    state.dragIndex = null;
    map.dragPan.enable();
    map.getCanvas().style.cursor = '';
    stateChangeHandler?.();
    return;
  }

  // Finish rect
  if (state.mode === 'drawing-rect' && state.start && state.current) {
    if (screenDist(state.start, state.current) >= MIN_DRAG_PX) {
      const zone = rectToPolygon(state.start, state.current);
      commitZone(zone);
    } else {
      // Too small — reset for another attempt
      state.start = null;
      state.current = null;
      clearDrawingLayers();
    }
    return;
  }

}

function handleGlobalMouseUp(): void {
  // Handle drag end outside canvas
  if (state.mode === 'selected' && state.dragIndex !== null) {
    state.dragIndex = null;
    map?.dragPan.enable();
    if (map) map.getCanvas().style.cursor = '';
  }
  // Handle rect end outside canvas
  if (state.mode === 'drawing-rect' && state.start) {
    state.start = null;
    state.current = null;
    clearDrawingLayers();
  }
}

function handleKeyDown(e: KeyboardEvent): void {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  switch (e.key) {
    case 'Escape':
      if (state.mode === 'drawing-rect') cancelDrawing();
      else if (state.mode === 'selected') deselectZone();
      break;
    case 'Delete':
    case 'Backspace':
      if (state.mode === 'selected') {
        e.preventDefault();
        deleteSelectedZone();
      }
      break;
  }
}

// --- Commit a zone and select it ---

function commitZone(zone: [number, number][]): void {
  const newIndex = exclusionZones.length;
  exclusionZones.push(zone);
  state = { mode: 'selected', zoneIndex: newIndex, dragIndex: null };
  if (map) {
    map.getCanvas().style.cursor = '';
    map.dragPan.enable();
    map.doubleClickZoom.enable();
  }
  clearDrawingLayers();
  renderAll();
  stateChangeHandler?.();
}

// --- Layer initialization ---

function initLayers(): void {
  if (!map) return;

  // PLATEAU 建物・GSI 地形（除外ゾーンより先に追加して下に描画）
  initTerrainAndBuildings();

  // 打上まわりの立入禁止（保安）ゾーン（自動・常時表示）
  map.addSource('safety-zone', { type: 'geojson', data: emptyPolygon() });
  map.addLayer({
    id: 'safety-zone-fill',
    type: 'fill',
    source: 'safety-zone',
    paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.22 },
  });
  map.addLayer({
    id: 'safety-zone-outline',
    type: 'line',
    source: 'safety-zone',
    paint: { 'line-color': '#dc2626', 'line-width': 2, 'line-dasharray': [2, 1] },
  });

  // Confirmed zones
  map.addSource('exclusion-zones', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'exclusion-zones-fill',
    type: 'fill',
    source: 'exclusion-zones',
    paint: {
      'fill-color': ['case', ['==', ['get', 'selected'], true], '#f97316', '#ef4444'],
      'fill-opacity': ['case', ['==', ['get', 'selected'], true], 0.25, 0.18],
    },
  });
  map.addLayer({
    id: 'exclusion-zones-outline',
    type: 'line',
    source: 'exclusion-zones',
    paint: {
      'line-color': ['case', ['==', ['get', 'selected'], true], '#f97316', '#ef4444'],
      'line-width': ['case', ['==', ['get', 'selected'], true], 2.5, 1.5],
      'line-dasharray': ['case', ['==', ['get', 'selected'], true], ['literal', [1, 0]], ['literal', [3, 2]]],
    },
  });

  // Drawing preview polygon
  map.addSource('drawing-polygon', { type: 'geojson', data: emptyPolygon() });
  map.addLayer({
    id: 'drawing-polygon-fill',
    type: 'fill',
    source: 'drawing-polygon',
    paint: { 'fill-color': '#f97316', 'fill-opacity': 0.15 },
  });

  // Drawing lines
  map.addSource('drawing-line', { type: 'geojson', data: emptyLine() });
  map.addLayer({
    id: 'drawing-line-layer',
    type: 'line',
    source: 'drawing-line',
    paint: { 'line-color': '#f97316', 'line-width': 2 },
  });

  // Selected zone handles
  map.addSource('selected-midpoints', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'selected-midpoints-layer',
    type: 'circle',
    source: 'selected-midpoints',
    paint: {
      'circle-radius': 4,
      'circle-color': '#fff',
      'circle-stroke-color': '#f97316',
      'circle-stroke-width': 1.5,
      'circle-opacity': 0.6,
      'circle-stroke-opacity': 0.6,
    },
  });

  map.addSource('selected-vertices', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'selected-vertices-layer',
    type: 'circle',
    source: 'selected-vertices',
    paint: {
      'circle-radius': 6,
      'circle-color': '#fff',
      'circle-stroke-color': '#f97316',
      'circle-stroke-width': 2.5,
    },
  });
}

// ============================================================
// PLATEAU 建物 + GSI 地形の可視化レイヤー
//
// 花火の見え方は「建物の実測高さ」と「地面の起伏」に左右される。
// OSM の推定高さでは実態とずれるため、PLATEAU の実測高さ建物と
// 地理院 DEM 地形を重ねて、遮蔽の理由を目視で確認できるようにする。
// ============================================================

let is3DActive = false;

function initTerrainAndBuildings(): void {
  if (!map) return;

  // 地面の高低: 地理院 DEM（バックエンドの標高スコアと同一出典）
  const terrainSource = useGsiTerrainSource(maplibregl.addProtocol, { maxzoom: 14 });
  map.addSource('gsi-terrain', terrainSource);
  map.addLayer({
    id: 'hillshade',
    type: 'hillshade',
    source: 'gsi-terrain',
    layout: { visibility: 'none' },
    paint: { 'hillshade-exaggeration': 0.4 },
  });

  // PLATEAU 3D 建物: 高さ measuredHeight で押し出し、高さで色分け
  map.addSource('plateau-bldg', {
    type: 'vector',
    tiles: [PLATEAU_BLDG_TILES],
    minzoom: 10,
    maxzoom: 16,
    attribution: '<a href="https://www.mlit.go.jp/plateau/" target="_blank" rel="noopener">PLATEAU</a>',
  });
  map.addLayer({
    id: 'plateau-bldg-3d',
    type: 'fill-extrusion',
    source: 'plateau-bldg',
    'source-layer': 'bldg',
    minzoom: BLDG_MIN_ZOOM,
    layout: { visibility: 'none' },
    paint: {
      'fill-extrusion-color': [
        'interpolate', ['linear'], ['get', 'measuredHeight'],
        0, '#5b8fd6', 15, '#8bb3e4', 30, '#c58fd6', 60, '#e57fb0',
      ],
      'fill-extrusion-height': ['get', 'measuredHeight'],
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': 0.85,
    },
  });
}

/** 3D 建物・地形の表示/非表示を切り替える */
function set3DVisible(on: boolean): void {
  if (!map) return;
  is3DActive = on;
  const visibility = on ? 'visible' : 'none';
  map.setLayoutProperty('plateau-bldg-3d', 'visibility', visibility);
  map.setLayoutProperty('hillshade', 'visibility', visibility);
  map.setTerrain(on ? { source: 'gsi-terrain', exaggeration: 1.1 } : null);

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // ズームが浅いと建物レイヤー(minzoom)が描画されないため、ON 時は近づける
  const zoom = on ? Math.max(map.getZoom(), ZOOM_3D) : map.getZoom();
  map.easeTo({
    pitch: on ? PITCH_3D : 0,
    zoom,
    duration: reduceMotion ? 0 : 600,
  });
}

/** 地図右上の「3D 建物・地形」トグルボタン */
class ThreeDToggleControl implements maplibregl.IControl {
  private container!: HTMLElement;

  onAdd(): HTMLElement {
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group threed-ctrl';

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '3D';
    button.title = '3D 建物・地形を表示';
    button.setAttribute('aria-label', '3D 建物・地形を表示');
    button.addEventListener('click', () => {
      set3DVisible(!is3DActive);
      button.classList.toggle('active', is3DActive);
      button.setAttribute('aria-pressed', String(is3DActive));
    });

    this.container.appendChild(button);
    return this.container;
  }

  onRemove(): void {
    this.container.remove();
  }
}

// --- Drawing mode starts ---

export function startDrawingRect(): void {
  exitCurrentMode();
  state = { mode: 'drawing-rect', start: null, current: null };
  if (map) {
    map.getCanvas().style.cursor = 'crosshair';
    map.doubleClickZoom.disable();
    map.dragPan.disable();
  }
  stateChangeHandler?.();
}

function exitCurrentMode(): void {
  if (state.mode === 'selected') {
    // Clean up selection handles
    renderSelectedHandles(true);
  }
  clearDrawingLayers();
  if (map) {
    map.getCanvas().style.cursor = '';
    map.dragPan.enable();
    map.doubleClickZoom.enable();
  }
}

export function cancelDrawing(): void {
  state = { mode: 'idle' };
  exitCurrentMode();
  stateChangeHandler?.();
}

// --- Selection ---

function selectZone(index: number): void {
  state = { mode: 'selected', zoneIndex: index, dragIndex: null };
  renderAll();
  stateChangeHandler?.();
}

export function deselectZone(): void {
  state = { mode: 'idle' };
  if (map) map.getCanvas().style.cursor = '';
  renderAll();
  stateChangeHandler?.();
}

export function deleteSelectedZone(): void {
  if (state.mode !== 'selected') return;
  exclusionZones.splice(state.zoneIndex, 1);
  state = { mode: 'idle' };
  if (map) map.getCanvas().style.cursor = '';
  renderAll();
  stateChangeHandler?.();
}

// --- Zone management ---

export function clearExclusionZones(): void {
  exclusionZones.length = 0;
  if (state.mode === 'selected') state = { mode: 'idle' };
  renderAll();
  stateChangeHandler?.();
}

export function undoLastExclusionZone(): void {
  if (state.mode === 'selected' && state.zoneIndex === exclusionZones.length - 1) {
    state = { mode: 'idle' };
  }
  exclusionZones.pop();
  renderAll();
  stateChangeHandler?.();
}

export function getExclusionZones(): ExclusionZone[] {
  return [...exclusionZones];
}

// --- State queries ---

export function isDrawing(): boolean {
  return state.mode === 'drawing-rect';
}

export function getEditorMode(): string {
  return state.mode;
}

export function getSelectedZoneIndex(): number | null {
  return state.mode === 'selected' ? state.zoneIndex : null;
}

// --- Rendering ---

function renderAll(): void {
  renderZones();
  renderSelectedHandles();
}

function renderZones(): void {
  if (!map) return;
  const src = map.getSource('exclusion-zones') as maplibregl.GeoJSONSource | undefined;
  if (!src) return;

  src.setData({
    type: 'FeatureCollection',
    features: exclusionZones.map((zone, i) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[...zone, zone[0]]],
      },
      properties: {
        index: i,
        selected: state.mode === 'selected' && state.zoneIndex === i,
      },
    })),
  });
}

function renderSelectedHandles(clear = false): void {
  if (!map) return;
  const vertSrc = map.getSource('selected-vertices') as maplibregl.GeoJSONSource | undefined;
  const midSrc = map.getSource('selected-midpoints') as maplibregl.GeoJSONSource | undefined;
  if (!vertSrc || !midSrc) return;

  if (clear || state.mode !== 'selected' || !exclusionZones[state.zoneIndex]) {
    vertSrc.setData(emptyFC());
    midSrc.setData(emptyFC());
    return;
  }

  const zone = exclusionZones[state.zoneIndex];

  vertSrc.setData({
    type: 'FeatureCollection',
    features: zone.map((coord, i) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: coord },
      properties: { index: i },
    })),
  });

  midSrc.setData({
    type: 'FeatureCollection',
    features: zone.map((coord, i) => {
      const next = zone[(i + 1) % zone.length];
      return {
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [(coord[0] + next[0]) / 2, (coord[1] + next[1]) / 2],
        },
        properties: { index: i },
      };
    }),
  });
}

/** Rect / Circle drag preview */
function renderShapePreview(): void {
  if (!map) return;

  let ring: [number, number][] = [];

  if (state.mode === 'drawing-rect' && state.start && state.current) {
    const verts = rectToPolygon(state.start, state.current);
    ring = [...verts, verts[0]];
  }

  const polySrc = map.getSource('drawing-polygon') as maplibregl.GeoJSONSource | undefined;
  if (polySrc) {
    polySrc.setData({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: ring.length > 0 ? [ring] : [[]] },
      properties: {},
    });
  }

  const lineSrc = map.getSource('drawing-line') as maplibregl.GeoJSONSource | undefined;
  if (lineSrc) {
    lineSrc.setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: ring },
      properties: {},
    });
  }
}

function clearDrawingLayers(): void {
  if (!map) return;
  (map.getSource('drawing-line') as maplibregl.GeoJSONSource | undefined)?.setData(emptyLine());
  (map.getSource('drawing-polygon') as maplibregl.GeoJSONSource | undefined)?.setData(emptyPolygon());
}

// --- GeoJSON helpers ---

function emptyLine() {
  return { type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: [] as number[][] }, properties: {} };
}
function emptyPolygon() {
  return { type: 'Feature' as const, geometry: { type: 'Polygon' as const, coordinates: [[]] as number[][][] }, properties: {} };
}
function emptyFC() {
  return { type: 'FeatureCollection' as const, features: [] as GeoJSON.Feature[] };
}

// ============================================================
// Launch marker, results rendering
// ============================================================

export function setLaunchMarker(lat: number, lng: number): void {
  if (!map) return;
  if (launchMarker) launchMarker.remove();

  const el = document.createElement('div');
  el.innerHTML = `<svg width="34" height="46" viewBox="-2 -2 34 46" overflow="visible">
    <path d="M15 0C6.7 0 0 6.7 0 15c0 11.2 15 27 15 27s15-15.8 15-27C30 6.7 23.3 0 15 0z" fill="#8bb3e4" stroke="#fff" stroke-width="2"/>
    <text x="15" y="20" text-anchor="middle" fill="#070c23" font-size="16" font-weight="bold">✦</text>
  </svg>`;

  launchMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
    .setLngLat([lng, lat])
    .setPopup(
      new maplibregl.Popup({ offset: 25 }).setHTML(
        `<div class="popup-title">打上地点</div>
         <div class="popup-detail">${lat.toFixed(4)}, ${lng.toFixed(4)}</div>`,
      ),
    )
    .addTo(map);
}

/**
 * 打上まわりの立入禁止（保安）ゾーンを赤い円で表示する。
 * radiusMeters は保安半径（max(開花直径, 150m)）。
 */
export function setSafetyZone(lat: number, lng: number, radiusMeters: number): void {
  if (!map) return;
  const src = map.getSource('safety-zone') as maplibregl.GeoJSONSource | undefined;
  if (!src) return;

  const points = 72;
  const dLat = radiusMeters / 111320;
  const dLng = radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180));
  const ring: [number, number][] = [];
  for (let i = 0; i <= points; i++) {
    const a = (i / points) * 2 * Math.PI;
    ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }

  src.setData({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: {},
  });
}

export function clearResults(): void {
  if (!map) return;
  if (map.getLayer('heatmap-layer')) map.removeLayer('heatmap-layer');
  if (map.getLayer('score-circles')) map.removeLayer('score-circles');
  if (map.getSource('scored-points')) map.removeSource('scored-points');
  for (const m of topMarkers) m.remove();
  topMarkers.length = 0;
}

function scoreColor(score: number): string {
  if (score >= 0.7) return '#6ee7a0';
  if (score >= 0.5) return '#8bb3e4';
  if (score >= 0.3) return '#fbbf24';
  return '#f87171';
}

export function renderResults(response: AnalyzeResponse): void {
  if (!map) return;
  clearResults();

  map.addSource('scored-points', {
    type: 'geojson',
    data: response.geojson as unknown as maplibregl.GeoJSONSourceSpecification['data'],
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
        `<div class="popup-title">${(p.score * 100).toFixed(0)}点</div>
         <div class="popup-detail">
           ${p.distance}m / ${p.viewingAngle}°<br>
           ${p.relativeElevation > 0 ? '+' : ''}${p.relativeElevation}m / 視線${(p.scoreLOS * 100).toFixed(0)}%<br>
         </div>`,
      )
      .addTo(map!);
  });

  map.on('mouseenter', 'score-circles', () => {
    if (map && state.mode === 'idle') map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'score-circles', () => {
    if (map && state.mode === 'idle') map.getCanvas().style.cursor = '';
  });

  const top = response.topPositions.slice(0, 10);
  for (let i = 0; i < top.length; i++) {
    const p = top[i];
    const color = scoreColor(p.score.total);
    const el = document.createElement('div');
    el.innerHTML = `<svg width="28" height="40" viewBox="0 0 28 40">
      <path d="M14 0C6.3 0 0 6.3 0 14c0 10.5 14 26 14 26s14-15.5 14-26C28 6.3 21.7 0 14 0z" fill="${color}" stroke="#fff" stroke-width="2"/>
      <text x="14" y="18" text-anchor="middle" fill="#fff" font-size="12" font-weight="bold">${i + 1}</text>
    </svg>`;
    el.style.cursor = 'pointer';

    const popup = new maplibregl.Popup({ offset: 24 }).setHTML(
      `<div class="popup-title">#${i + 1} — ${(p.score.total * 100).toFixed(0)}点</div>
       <div class="popup-detail">
         ${p.distanceMeters}m / ${p.viewingAngleDeg}°<br>
         ${p.relativeElevation > 0 ? '+' : ''}${p.relativeElevation}m / 視線${(p.score.lineOfSight * 100).toFixed(0)}%<br>
       </div>`,
    );

    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([p.lng, p.lat])
      .setPopup(popup)
      .addTo(map);
    topMarkers.push(marker);
  }

  const bounds = new maplibregl.LngLatBounds();
  bounds.extend([response.launchSite.lng, response.launchSite.lat]);
  for (const p of top) bounds.extend([p.lng, p.lat]);
  map.fitBounds(bounds, { padding: 60, maxZoom: 15 });
}

export function focusOnPosition(index: number): void {
  if (!map || index >= topMarkers.length) return;
  const lngLat = topMarkers[index].getLngLat();
  map.flyTo({ center: lngLat, zoom: 16 });
  topMarkers[index].togglePopup();
}

// --- Viewer marker (mobile) ---

export function setViewerMarker(lat: number, lng: number, label?: string): void {
  if (!map) return;
  if (viewerMarker) viewerMarker.remove();

  const el = document.createElement('div');
  el.innerHTML = `<svg width="34" height="46" viewBox="-2 -2 34 46" overflow="visible">
    <path d="M15 0C6.7 0 0 6.7 0 15c0 11.2 15 27 15 27s15-15.8 15-27C30 6.7 23.3 0 15 0z" fill="#8bb3e4" stroke="#fff" stroke-width="2"/>
    <circle cx="15" cy="15" r="5" fill="#fff"/>
  </svg>`;

  viewerMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
    .setLngLat([lng, lat])
    .setPopup(
      new maplibregl.Popup({ offset: 25 }).setHTML(
        `<div class="popup-title">現在地</div>
         <div class="popup-detail">${label || `${lat.toFixed(4)}, ${lng.toFixed(4)}`}</div>`,
      ),
    )
    .addTo(map);
}

export function fitToLaunchAndViewer(bottomPadding?: number): void {
  if (!map || !launchMarker || !viewerMarker) return;
  const bounds = new maplibregl.LngLatBounds();
  bounds.extend(launchMarker.getLngLat());
  bounds.extend(viewerMarker.getLngLat());
  const pad = bottomPadding
    ? { top: 80, left: 80, right: 80, bottom: bottomPadding }
    : 80;
  map.fitBounds(bounds, { padding: pad, maxZoom: 15 });
}

export function flyToCenter(lat: number, lng: number, zoom?: number): void {
  if (!map) return;
  map.flyTo({ center: [lng, lat], zoom: zoom ?? map.getZoom(), duration: 800 });
}

export function clearViewerMarker(): void {
  if (viewerMarker) {
    viewerMarker.remove();
    viewerMarker = null;
  }
}
