import 'maplibre-gl/dist/maplibre-gl.css';
import { initMap, setLaunchMarker, renderResults, clearResults, focusOnPosition } from './map.js';
import { analyzePosition } from './api.js';
import type { AnalyzeResponse } from './types.js';

// DOM 要素
const latInput = document.getElementById('lat') as HTMLInputElement;
const lngInput = document.getElementById('lng') as HTMLInputElement;
const radiusSelect = document.getElementById('radius') as HTMLSelectElement;
const analyzeBtn = document.getElementById('analyze-btn') as HTMLButtonElement;
const loadingEl = document.getElementById('loading') as HTMLElement;
const resultsEl = document.getElementById('results') as HTMLElement;
const resultsListEl = document.getElementById('results-list') as HTMLElement;

let isAnalyzing = false;

/**
 * 入力値のセットとマーカー配置
 */
function setLaunchSite(lat: number, lng: number): void {
  latInput.value = lat.toFixed(4);
  lngInput.value = lng.toFixed(4);
  setLaunchMarker(lat, lng);
}

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

  isAnalyzing = true;
  analyzeBtn.disabled = true;
  loadingEl.classList.remove('hidden');
  resultsEl.classList.add('hidden');
  clearResults();

  try {
    const response = await analyzePosition({
      launchSite: { lat, lng },
      radiusMeters,
    });

    renderResults(response);
    showResultsPanel(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : '不明なエラー';
    alert(`分析に失敗しました: ${message}`);
  } finally {
    isAnalyzing = false;
    analyzeBtn.disabled = false;
    loadingEl.classList.add('hidden');
  }
}

/**
 * 結果パネルを表示
 */
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
        距離: ${p.distanceMeters}m / 標高差: ${p.relativeElevation > 0 ? '+' : ''}${p.relativeElevation}m
      </div>
      <div class="reason">${p.reason}</div>
      <div class="score-bar">
        <div class="segment" style="flex:${p.score.distance};background:#3b82f6;" title="距離"></div>
        <div class="segment" style="flex:${p.score.elevation};background:#8b5cf6;" title="標高"></div>
        <div class="segment" style="flex:${p.score.lineOfSight};background:#22c55e;" title="視線"></div>
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
  setLaunchSite(lat, lng);
});

// 分析ボタン
analyzeBtn.addEventListener('click', runAnalysis);

// Enter キーで分析
[latInput, lngInput].forEach((input) => {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runAnalysis();
  });
});
