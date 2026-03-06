import 'maplibre-gl/dist/maplibre-gl.css';
import {
  initMap,
  setLaunchMarker,
  renderResults,
  clearResults,
  focusOnPosition,
  startDrawingRect,
  cancelDrawing,
  clearExclusionZones,
  undoLastExclusionZone,
  getExclusionZones,
  getEditorMode,
  isDrawing,
  onStateChange,
} from './map.js';
import { analyzePosition } from './api.js';
import type { AnalyzeResponse } from './types.js';

// DOM
const presetSelect = document.getElementById('preset') as HTMLSelectElement;
const latInput = document.getElementById('lat') as HTMLInputElement;
const lngInput = document.getElementById('lng') as HTMLInputElement;
const radiusSelect = document.getElementById('radius') as HTMLSelectElement;
const analyzeBtn = document.getElementById('analyze-btn') as HTMLButtonElement;
const loadingEl = document.getElementById('loading') as HTMLElement;
const resultsEl = document.getElementById('results') as HTMLElement;
const resultsListEl = document.getElementById('results-list') as HTMLElement;

const drawRectBtn = document.getElementById('draw-rect-btn') as HTMLButtonElement;
const undoExclusionBtn = document.getElementById('undo-exclusion-btn') as HTMLButtonElement;
const clearExclusionBtn = document.getElementById('clear-exclusion-btn') as HTMLButtonElement;
const editorHint = document.getElementById('editor-hint') as HTMLElement;
const editorHintText = document.getElementById('editor-hint-text') as HTMLElement;

let isAnalyzing = false;

function setLaunchSite(lat: number, lng: number): void {
  latInput.value = lat.toFixed(6);
  lngInput.value = lng.toFixed(6);
  setLaunchMarker(lat, lng);
}

function updateUI(): void {
  const mode = getEditorMode();
  const zones = getExclusionZones();
  const drawing = isDrawing();

  undoExclusionBtn.classList.toggle('hidden', zones.length === 0 || drawing);
  clearExclusionBtn.classList.toggle('hidden', zones.length === 0 || drawing);

  drawRectBtn.classList.toggle('active', mode === 'drawing-rect');

  switch (mode) {
    case 'drawing-rect':
      editorHint.classList.remove('hidden');
      editorHintText.textContent = 'ドラッグで矩形を描画 \u00B7 Esc キャンセル';
      break;
    case 'selected':
      editorHint.classList.remove('hidden');
      editorHintText.textContent = 'ドラッグで頂点移動 \u00B7 辺の中点ドラッグで追加 \u00B7 Delete 削除 \u00B7 Esc 選択解除';
      break;
    default:
      editorHint.classList.add('hidden');
  }
}

onStateChange(updateUI);

// Preset
presetSelect.addEventListener('change', () => {
  const value = presetSelect.value;
  if (!value) return;
  const [lat, lng] = value.split(',').map(Number);
  setLaunchSite(lat, lng);
});

// Draw button toggle
drawRectBtn.addEventListener('click', () => {
  if (getEditorMode() === 'drawing-rect') {
    cancelDrawing();
  } else {
    startDrawingRect();
  }
});

undoExclusionBtn.addEventListener('click', () => {
  undoLastExclusionZone();
  updateUI();
});

clearExclusionBtn.addEventListener('click', () => {
  clearExclusionZones();
  updateUI();
});

// Analysis
async function runAnalysis(): Promise<void> {
  const lat = parseFloat(latInput.value);
  const lng = parseFloat(lngInput.value);

  if (isNaN(lat) || isNaN(lng)) {
    alert('緯度と経度を入力してください');
    return;
  }

  if (lat < 20 || lat > 46 || lng < 122 || lng > 154) {
    alert('日本国内の座標を入力してください');
    return;
  }

  const radiusMeters = parseInt(radiusSelect.value, 10);
  const exclusionZones = getExclusionZones();

  isAnalyzing = true;
  analyzeBtn.disabled = true;
  loadingEl.classList.remove('hidden');
  resultsEl.classList.add('hidden');
  clearResults();

  try {
    const response = await analyzePosition({
      launchSite: { lat, lng },
      radiusMeters,
      exclusionZones: exclusionZones.length > 0 ? exclusionZones : undefined,
    });

    renderResults(response);
    showResultsPanel(response);
  } catch (err) {
    console.error('Analysis failed:', err);
    const message = err instanceof Error ? err.message : '不明なエラー';
    alert(`分析に失敗しました: ${message}`);
  } finally {
    isAnalyzing = false;
    analyzeBtn.disabled = false;
    loadingEl.classList.add('hidden');
  }
}

function showResultsPanel(response: AnalyzeResponse): void {
  resultsListEl.innerHTML = '';

  const summary = document.createElement('p');
  summary.style.cssText = 'font-size:0.8rem;color:#888;margin-bottom:12px;';
  summary.textContent = `${response.totalPointsAnalyzed}地点を分析（打上地点標高: ${response.launchSiteElevation.toFixed(1)}m）`;
  resultsListEl.appendChild(summary);

  response.topPositions.slice(0, 10).forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.addEventListener('click', () => focusOnPosition(i));

    const scorePercent = (p.score.total * 100).toFixed(0);
    card.innerHTML = `
      <span class="rank">${i + 1}</span>
      <span class="score">${scorePercent}点</span>
      <div class="details">
        距離: ${p.distanceMeters}m / 仰角: ${p.viewingAngleDeg}° / 標高差: ${p.relativeElevation > 0 ? '+' : ''}${p.relativeElevation}m
      </div>
      <div class="reason">${p.reason}</div>
      <div class="score-bar">
        <div class="segment" style="flex:${p.score.viewingAngle};background:#3b82f6;" title="仰角"></div>
        <div class="segment" style="flex:${p.score.lineOfSight};background:#22c55e;" title="視線"></div>
        <div class="segment" style="flex:${p.score.accessibility};background:#a855f7;" title="場所"></div>
        <div class="segment" style="flex:${p.score.elevation};background:#8b5cf6;" title="標高"></div>
        <div class="segment" style="flex:${p.score.slope};background:#f59e0b;" title="勾配"></div>
      </div>
    `;

    resultsListEl.appendChild(card);
  });

  resultsEl.classList.remove('hidden');
}

// Init map
initMap('map', (lat, lng) => {
  if (isAnalyzing) return;
  presetSelect.value = '';
  setLaunchSite(lat, lng);
});

analyzeBtn.addEventListener('click', runAnalysis);

[latInput, lngInput].forEach((input) => {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runAnalysis();
  });
});
