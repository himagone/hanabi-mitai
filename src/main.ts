import 'maplibre-gl/dist/maplibre-gl.css';
import {
  initMap,
  setLaunchMarker,
  renderResults,
  clearResults,
  focusOnPosition,
  startDrawing,
  cancelDrawing,
  finishDrawing,
  undoLastVertex,
  clearExclusionZones,
  undoLastExclusionZone,
  getExclusionZones,
  getVertexCount,
  isDrawing,
  onDrawingChange,
} from './map.js';
import { analyzePosition } from './api.js';
import type { AnalyzeResponse } from './types.js';

// DOM 要素
const presetSelect = document.getElementById('preset') as HTMLSelectElement;
const latInput = document.getElementById('lat') as HTMLInputElement;
const lngInput = document.getElementById('lng') as HTMLInputElement;
const radiusSelect = document.getElementById('radius') as HTMLSelectElement;
const analyzeBtn = document.getElementById('analyze-btn') as HTMLButtonElement;
const loadingEl = document.getElementById('loading') as HTMLElement;
const resultsEl = document.getElementById('results') as HTMLElement;
const resultsListEl = document.getElementById('results-list') as HTMLElement;

const drawExclusionBtn = document.getElementById('draw-exclusion-btn') as HTMLButtonElement;
const undoExclusionBtn = document.getElementById('undo-exclusion-btn') as HTMLButtonElement;
const clearExclusionBtn = document.getElementById('clear-exclusion-btn') as HTMLButtonElement;
const drawingBanner = document.getElementById('drawing-banner') as HTMLElement;
const drawingStatus = document.getElementById('drawing-status') as HTMLElement;
const finishDrawingBtn = document.getElementById('finish-drawing-btn') as HTMLButtonElement;
const undoVertexBtn = document.getElementById('undo-vertex-btn') as HTMLButtonElement;
const cancelDrawingBtn = document.getElementById('cancel-drawing-btn') as HTMLButtonElement;

let isAnalyzing = false;

function setLaunchSite(lat: number, lng: number): void {
  latInput.value = lat.toFixed(6);
  lngInput.value = lng.toFixed(6);
  setLaunchMarker(lat, lng);
}

function updateExclusionButtons(): void {
  const zones = getExclusionZones();
  if (zones.length > 0) {
    undoExclusionBtn.classList.remove('hidden');
    clearExclusionBtn.classList.remove('hidden');
  } else {
    undoExclusionBtn.classList.add('hidden');
    clearExclusionBtn.classList.add('hidden');
  }
}

/**
 * 描画中のバナー表示を更新
 */
function updateDrawingBanner(): void {
  if (!isDrawing()) {
    drawingBanner.classList.add('hidden');
    drawExclusionBtn.classList.remove('active');
    updateExclusionButtons();
    return;
  }

  drawingBanner.classList.remove('hidden');
  drawExclusionBtn.classList.add('active');

  const count = getVertexCount();
  if (count === 0) {
    drawingStatus.textContent = '地図をクリックして頂点を追加してください';
    finishDrawingBtn.classList.add('hidden');
    undoVertexBtn.classList.add('hidden');
  } else if (count === 1) {
    drawingStatus.textContent = `${count}点 — 続けてクリックしてください`;
    finishDrawingBtn.classList.add('hidden');
    undoVertexBtn.classList.remove('hidden');
  } else if (count === 2) {
    drawingStatus.textContent = `${count}点 — あと1点以上追加してください`;
    finishDrawingBtn.classList.add('hidden');
    undoVertexBtn.classList.remove('hidden');
  } else {
    drawingStatus.textContent = `${count}点 — 始点クリックまたは「確定」で完了`;
    finishDrawingBtn.classList.remove('hidden');
    undoVertexBtn.classList.remove('hidden');
  }
}

// 描画状態が変化したとき
onDrawingChange(updateDrawingBanner);

// プリセット選択
presetSelect.addEventListener('change', () => {
  const value = presetSelect.value;
  if (!value) return;
  const [lat, lng] = value.split(',').map(Number);
  setLaunchSite(lat, lng);
});

// --- 除外ゾーン描画ボタン ---
drawExclusionBtn.addEventListener('click', () => {
  if (isDrawing()) {
    cancelDrawing();
  } else {
    startDrawing();
  }
  updateDrawingBanner();
});

finishDrawingBtn.addEventListener('click', () => {
  finishDrawing();
  updateDrawingBanner();
});

undoVertexBtn.addEventListener('click', () => {
  undoLastVertex();
  updateDrawingBanner();
});

cancelDrawingBtn.addEventListener('click', () => {
  cancelDrawing();
  updateDrawingBanner();
});

undoExclusionBtn.addEventListener('click', () => {
  undoLastExclusionZone();
  updateExclusionButtons();
});

clearExclusionBtn.addEventListener('click', () => {
  clearExclusionZones();
  updateExclusionButtons();
});

/**
 * 分析を実行
 */
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

// 地図を初期化
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
