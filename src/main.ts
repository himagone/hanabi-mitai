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
  setViewerMarker,
  fitToLaunchAndViewer,
  clearViewerMarker,
} from './map.js';
import { analyzePosition, scorePoint } from './api.js';
import type { AnalyzeResponse, ScorePointResponse } from './types.js';

// --- Mobile detection ---
const isMobile = window.innerWidth <= 768;

// DOM
const presetSelect = document.getElementById('preset') as HTMLSelectElement;
const latInput = document.getElementById('lat') as HTMLInputElement;
const lngInput = document.getElementById('lng') as HTMLInputElement;
const radiusSelect = document.getElementById('radius') as HTMLSelectElement;
const analyzeBtn = document.getElementById('analyze-btn') as HTMLButtonElement;
const loadingEl = document.getElementById('loading') as HTMLElement;
const resultsEl = document.getElementById('results') as HTMLElement;
const resultsListEl = document.getElementById('results-list') as HTMLElement;
const editorHint = document.getElementById('editor-hint') as HTMLElement;
const editorHintText = document.getElementById('editor-hint-text') as HTMLElement;

// Desktop only
const drawRectBtn = document.getElementById('draw-rect-btn') as HTMLButtonElement | null;
const undoExclusionBtn = document.getElementById('undo-exclusion-btn') as HTMLButtonElement | null;
const clearExclusionBtn = document.getElementById('clear-exclusion-btn') as HTMLButtonElement | null;

// Mobile only
const scoreHereBtn = document.getElementById('score-here-btn') as HTMLButtonElement | null;
const mobileScoreCard = document.getElementById('mobile-score-card') as HTMLElement | null;

let isAnalyzing = false;
let mobileManualMode = false; // GPS失敗時に地図タップで現在地指定
let currentFireworkDiameter: number | undefined;

// Apply mobile class for CSS
if (isMobile) {
  document.body.classList.add('is-mobile');
}

function setLaunchSite(lat: number, lng: number): void {
  latInput.value = lat.toFixed(6);
  lngInput.value = lng.toFixed(6);
  setLaunchMarker(lat, lng);
}

// ============================================================
// Desktop: existing behavior
// ============================================================

if (!isMobile) {
  function updateUI(): void {
    const mode = getEditorMode();
    const zones = getExclusionZones();
    const drawing = isDrawing();

    undoExclusionBtn?.classList.toggle('hidden', zones.length === 0 || drawing);
    clearExclusionBtn?.classList.toggle('hidden', zones.length === 0 || drawing);
    drawRectBtn?.classList.toggle('active', mode === 'drawing-rect');

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

  drawRectBtn?.addEventListener('click', () => {
    if (getEditorMode() === 'drawing-rect') {
      cancelDrawing();
    } else {
      startDrawingRect();
    }
  });

  undoExclusionBtn?.addEventListener('click', () => {
    undoLastExclusionZone();
    updateUI();
  });

  clearExclusionBtn?.addEventListener('click', () => {
    clearExclusionZones();
    updateUI();
  });

  analyzeBtn.addEventListener('click', runDesktopAnalysis);

  [latInput, lngInput].forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runDesktopAnalysis();
    });
  });
}

async function runDesktopAnalysis(): Promise<void> {
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
  const loadingTextEl = document.getElementById('loading-text');
  if (loadingTextEl) loadingTextEl.textContent = '分析中…';
  loadingEl.classList.remove('hidden');
  resultsEl.classList.add('hidden');
  clearResults();

  // Goal Gradient: simulate progress steps
  const steps = document.querySelectorAll('#loading-steps .loading-step');
  const setStep = (index: number) => {
    steps.forEach((el, i) => {
      const icon = el.querySelector('.step-icon')!;
      if (i < index) {
        el.classList.remove('active');
        el.classList.add('done');
        icon.textContent = '✓';
      } else if (i === index) {
        el.classList.add('active');
        el.classList.remove('done');
        icon.textContent = '◉';
      } else {
        el.classList.remove('active', 'done');
        icon.textContent = '○';
      }
    });
  };
  setStep(0);
  const stepTimer1 = setTimeout(() => setStep(1), 1500);
  const stepTimer2 = setTimeout(() => setStep(2), 4000);

  try {
    const response = await analyzePosition({
      launchSite: { lat, lng },
      radiusMeters,
      exclusionZones: exclusionZones.length > 0 ? exclusionZones : undefined,
      fireworkDiameter: currentFireworkDiameter,
    });

    // Mark all steps done
    setStep(3);

    renderResults(response);
    showDesktopResults(response);
  } catch (err) {
    console.error('Analysis failed:', err);
    const message = err instanceof Error ? err.message : '不明なエラー';
    alert(`分析に失敗しました: ${message}`);
  } finally {
    clearTimeout(stepTimer1);
    clearTimeout(stepTimer2);
    isAnalyzing = false;
    analyzeBtn.disabled = false;
    loadingEl.classList.add('hidden');
  }
}

function scoreQualityLabel(percent: number): { text: string; cls: string } {
  if (percent >= 70) return { text: '◎', cls: 'excellent' };
  if (percent >= 50) return { text: '○', cls: 'good' };
  if (percent >= 30) return { text: '△', cls: 'fair' };
  return { text: '×', cls: 'poor' };
}

function formatDistance(meters: number): string {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(1)}km`;
  }
  return `${meters}m`;
}

function distanceWithWalk(meters: number): string {
  const walkMin = Math.round(meters / 80); // 徒歩 80m/min
  const dist = formatDistance(meters);
  if (walkMin <= 60) {
    return `${dist}（徒歩${walkMin}分）`;
  }
  return dist;
}

function showDesktopResults(response: AnalyzeResponse): void {
  resultsListEl.innerHTML = '';

  const summary = document.createElement('p');
  summary.style.cssText = 'font-size:0.8rem;color:#888;margin-bottom:12px;';
  summary.textContent = `${response.totalPointsAnalyzed}地点を分析`;
  resultsListEl.appendChild(summary);

  response.topPositions.slice(0, 10).forEach((p, i) => {
    const card = document.createElement('div');
    card.className = i === 0 ? 'result-card rank-1' : 'result-card';
    card.style.animationDelay = `${i * 0.05}s`;
    card.addEventListener('click', () => focusOnPosition(i));

    const scorePercent = Number((p.score.total * 100).toFixed(0));
    const quality = scoreQualityLabel(scorePercent);
    card.innerHTML = `
      <span class="rank">${i + 1}</span>
      <span class="score">${scorePercent}点</span>
      <span class="score-quality ${quality.cls}">${quality.text}</span>
      <div class="details">
        打上げまで ${distanceWithWalk(p.distanceMeters)}
      </div>
      <div class="reason">${p.reason}</div>
      <div class="score-bar">
        <div class="segment" style="flex:${p.score.viewingAngle};background:#3b82f6;" title="角度"></div>
        <div class="segment" style="flex:${p.score.lineOfSight};background:#22c55e;" title="視界"></div>
        <div class="segment" style="flex:${p.score.accessibility};background:#a855f7;" title="場所"></div>
        <div class="segment" style="flex:${p.score.elevation};background:#8b5cf6;" title="高さ"></div>
        <div class="segment" style="flex:${p.score.slope};background:#f59e0b;" title="地形"></div>
      </div>
    `;
    resultsListEl.appendChild(card);
  });

  resultsEl.classList.remove('hidden');
}

// ============================================================
// Mobile: current location score
// ============================================================

if (isMobile && scoreHereBtn) {
  scoreHereBtn.addEventListener('click', runMobileScore);
}

function getCurrentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('お使いのブラウザは位置情報に対応していません'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, (err) => {
      switch (err.code) {
        case err.PERMISSION_DENIED:
          reject(new Error('位置情報の許可が必要です。ブラウザの設定を確認してください'));
          break;
        case err.POSITION_UNAVAILABLE:
          reject(new Error('位置情報を取得できません'));
          break;
        case err.TIMEOUT:
          reject(new Error('位置情報の取得がタイムアウトしました'));
          break;
        default:
          reject(new Error('位置情報の取得に失敗しました'));
      }
    }, { enableHighAccuracy: true, timeout: 15000 });
  });
}

async function runMobileScore(): Promise<void> {
  const lat = parseFloat(latInput.value);
  const lng = parseFloat(lngInput.value);

  if (isNaN(lat) || isNaN(lng)) {
    editorHint.classList.remove('hidden');
    editorHintText.textContent = '花火大会を選択してください';
    return;
  }

  if (scoreHereBtn) {
    scoreHereBtn.disabled = true;
    scoreHereBtn.textContent = '位置を取得中…';
  }

  try {
    const pos = await getCurrentPosition();
    await scoreFromLocation(pos.coords.latitude, pos.coords.longitude);
  } catch (err) {
    console.error('GPS failed:', err);
    // GPS失敗 → 地図タップモードに切り替え
    mobileManualMode = true;
    if (scoreHereBtn) {
      scoreHereBtn.disabled = false;
      scoreHereBtn.textContent = 'ここから見える？';
    }
    editorHint.classList.remove('hidden');
    editorHintText.textContent = '地図をタップして場所を選択';
  }
}

async function scoreFromLocation(viewerLat: number, viewerLng: number): Promise<void> {
  const lat = parseFloat(latInput.value);
  const lng = parseFloat(lngInput.value);

  if (scoreHereBtn) {
    scoreHereBtn.disabled = true;
    scoreHereBtn.textContent = '調べています…';
  }
  const loadingTextEl = document.getElementById('loading-text');
  if (loadingTextEl) loadingTextEl.textContent = '計算中…';
  loadingEl.classList.remove('hidden');
  editorHint.classList.add('hidden');
  mobileManualMode = false;

  try {
    setViewerMarker(viewerLat, viewerLng);
    fitToLaunchAndViewer();

    const response = await scorePoint({
      launchSite: { lat, lng },
      viewerLocation: { lat: viewerLat, lng: viewerLng },
      fireworkDiameter: currentFireworkDiameter,
    });

    showMobileScoreCard(response);
  } catch (err) {
    console.error('Score failed:', err);
    const message = err instanceof Error ? err.message : '不明なエラー';
    alert(`スコア計算に失敗しました: ${message}`);
  } finally {
    loadingEl.classList.add('hidden');
    if (scoreHereBtn) {
      scoreHereBtn.disabled = false;
      scoreHereBtn.textContent = 'ここから見える？';
    }
  }
}

function showMobileScoreCard(response: ScorePointResponse): void {
  if (!mobileScoreCard) return;

  const v = response.viewer;
  const totalPercent = Math.round(v.score.total * 100);

  const scoreValueEl = document.getElementById('score-value')!;
  scoreValueEl.textContent = String(totalPercent);
  const mainEl = mobileScoreCard.querySelector('.score-card-main') as HTMLElement;
  if (totalPercent >= 70) mainEl.style.borderLeftColor = '#22c55e';
  else if (totalPercent >= 50) mainEl.style.borderLeftColor = '#eab308';
  else if (totalPercent >= 30) mainEl.style.borderLeftColor = '#f97316';
  else mainEl.style.borderLeftColor = '#ef4444';

  // Details
  document.getElementById('sc-distance')!.textContent = distanceWithWalk(v.distanceMeters);
  document.getElementById('sc-angle')!.textContent = `${v.viewingAngleDeg}°`;
  document.getElementById('sc-elevation')!.textContent =
    `${v.relativeElevation > 0 ? '+' : ''}${v.relativeElevation}m`;
  const losPercent = Math.round(v.score.lineOfSight * 100);
  document.getElementById('sc-los')!.textContent =
    losPercent >= 90 ? 'なし' : losPercent >= 50 ? '少しあり' : 'あり';

  // Bars
  (document.getElementById('bar-angle') as HTMLElement).style.width = `${v.score.viewingAngle * 100}%`;
  (document.getElementById('bar-los') as HTMLElement).style.width = `${v.score.lineOfSight * 100}%`;
  (document.getElementById('bar-access') as HTMLElement).style.width = `${v.score.accessibility * 100}%`;
  (document.getElementById('bar-slope') as HTMLElement).style.width = `${v.score.slope * 100}%`;

  // Reason
  document.getElementById('sc-reason')!.textContent = v.reason;

  mobileScoreCard.classList.remove('hidden');
}

// ============================================================
// Common: init
// ============================================================

presetSelect.addEventListener('change', () => {
  const value = presetSelect.value;
  if (!value) return;
  const [lat, lng] = value.split(',').map(Number);
  const selectedOption = presetSelect.selectedOptions[0];
  const diameterAttr = selectedOption?.getAttribute('data-diameter');
  currentFireworkDiameter = diameterAttr ? parseInt(diameterAttr, 10) : undefined;
  setLaunchSite(lat, lng);
  if (isMobile) {
    mobileScoreCard?.classList.add('hidden');
    clearViewerMarker();
    // タップでもスコア確認できることを案内
    editorHint.classList.remove('hidden');
    editorHintText.textContent = '地図タップで見え方を確認';
  }
});

initMap('map', (lat, lng) => {
  if (isAnalyzing) return;
  if (isMobile) {
    // モバイル: 打上地点が設定済みなら地図タップでスコア計算
    const launchLat = parseFloat(latInput.value);
    const launchLng = parseFloat(lngInput.value);
    if (!isNaN(launchLat) && !isNaN(launchLng)) {
      scoreFromLocation(lat, lng);
    }
    return;
  }
  presetSelect.value = '';
  setLaunchSite(lat, lng);
});
