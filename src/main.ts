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
  flyToCenter,
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

function setLoadingText(text: string): void {
  const el = document.getElementById('loading-text');
  if (!el) return;
  const chars = text.split('').map((c, i) =>
    `<span style="--i:${i}">${c}</span>`
  ).join('');
  const dotStart = text.length;
  const dots = `<span class="loading-dots"><span style="--i:${dotStart}">.</span><span style="--i:${dotStart + 1}">.</span><span style="--i:${dotStart + 2}">.</span></span>`;
  el.innerHTML = chars + dots;
}

// Desktop only
const drawRectBtn = document.getElementById('draw-rect-btn') as HTMLButtonElement | null;
const undoExclusionBtn = document.getElementById('undo-exclusion-btn') as HTMLButtonElement | null;
const clearExclusionBtn = document.getElementById('clear-exclusion-btn') as HTMLButtonElement | null;

// Mobile only
const scoreHereBtn = document.getElementById('score-here-btn') as HTMLButtonElement | null;
const mobileScoreCard = document.getElementById('mobile-score-card') as HTMLElement | null;
const presetHint = document.getElementById('preset-hint') as HTMLElement | null;
const mobilePinActions = document.getElementById('mobile-pin-actions') as HTMLElement | null;
const pinAnalyzeBtn = document.getElementById('pin-analyze-btn') as HTMLButtonElement | null;
const pinRetryBtn = document.getElementById('pin-retry-btn') as HTMLButtonElement | null;

let isAnalyzing = false;
let currentFireworkDiameter: number | undefined;
// モバイル: ピン設置済みの座標を保持（API未呼び出し）
let pendingViewerLat: number | null = null;
let pendingViewerLng: number | null = null;

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
  setLoadingText('分析中');
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
  scoreHereBtn.addEventListener('click', runMobileGPS);
}

// ピン設置後の確認ボタン
if (isMobile && pinAnalyzeBtn) {
  pinAnalyzeBtn.addEventListener('click', () => {
    if (pendingViewerLat != null && pendingViewerLng != null) {
      hidePinActions();
      scoreFromLocation(pendingViewerLat, pendingViewerLng);
    }
  });
}
if (isMobile && pinRetryBtn) {
  pinRetryBtn.addEventListener('click', () => {
    clearPendingPin();
    editorHint.classList.remove('hidden');
    editorHintText.textContent = '地図タップで見え方を確認';
  });
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

/** GPS取得 → ピン設置 → 確認ボタン表示 */
async function runMobileGPS(): Promise<void> {
  const lat = parseFloat(latInput.value);
  const lng = parseFloat(lngInput.value);

  if (isNaN(lat) || isNaN(lng)) {
    if (isMobile && presetHint) {
      presetHint.textContent = '花火大会を選ぶと使えます';
      presetHint.classList.remove('hidden');
      presetSelect.style.borderColor = 'var(--yellow)';
      presetSelect.addEventListener('change', () => {
        presetHint.classList.add('hidden');
        presetSelect.style.borderColor = '';
      }, { once: true });
    } else {
      editorHint.classList.remove('hidden');
      editorHintText.textContent = '花火大会を選択してください';
    }
    return;
  }

  if (scoreHereBtn) {
    scoreHereBtn.disabled = true;
    scoreHereBtn.textContent = '位置を取得中…';
  }

  try {
    const pos = await getCurrentPosition();
    placePinAndShowActions(pos.coords.latitude, pos.coords.longitude);
  } catch (err) {
    console.error('GPS failed:', err);
    // GPS失敗 → 地図タップモードに切り替え
    if (scoreHereBtn) {
      scoreHereBtn.disabled = false;
      scoreHereBtn.textContent = 'ここから見える？';
    }
    editorHint.classList.remove('hidden');
    editorHintText.textContent = '地図をタップして場所を選択';
  }
}

/** ピンを設置し、確認用アクションボタンを表示する */
function placePinAndShowActions(viewerLat: number, viewerLng: number): void {
  pendingViewerLat = viewerLat;
  pendingViewerLng = viewerLng;
  setViewerMarker(viewerLat, viewerLng);
  // ピン設置後に両ピンが見えるようフィット（アクションボタン分のpadding）
  fitToLaunchAndViewer(140);
  editorHint.classList.add('hidden');
  showPinActions();
}

function showPinActions(): void {
  if (scoreHereBtn) scoreHereBtn.classList.add('hidden');
  if (mobilePinActions) mobilePinActions.classList.remove('hidden');
}

function hidePinActions(): void {
  if (mobilePinActions) mobilePinActions.classList.add('hidden');
}

function clearPendingPin(): void {
  pendingViewerLat = null;
  pendingViewerLng = null;
  clearViewerMarker();
  hidePinActions();
  if (scoreHereBtn) scoreHereBtn.classList.remove('hidden');
}

async function scoreFromLocation(viewerLat: number, viewerLng: number): Promise<void> {
  const lat = parseFloat(latInput.value);
  const lng = parseFloat(lngInput.value);

  isAnalyzing = true;
  setLoadingText('計算中');
  if (loadingEl) loadingEl.classList.remove('hidden');
  editorHint.classList.add('hidden');

  try {
    setViewerMarker(viewerLat, viewerLng);

    const response = await scorePoint({
      launchSite: { lat, lng },
      viewerLocation: { lat: viewerLat, lng: viewerLng },
      fireworkDiameter: currentFireworkDiameter,
    });

    showMobileScoreCard(response);
    // カード表示後にピンが隠れないよう、ボトムシートの高さ分を考慮してフィット
    const cardHeight = mobileScoreCard?.offsetHeight ?? 0;
    fitToLaunchAndViewer(cardHeight + 40);
  } catch (err) {
    console.error('Score failed:', err);
    const message = err instanceof Error ? err.message : '不明なエラー';
    alert(`スコア計算に失敗しました: ${message}`);
  } finally {
    isAnalyzing = false;
    if (loadingEl) loadingEl.classList.add('hidden');
    pendingViewerLat = null;
    pendingViewerLng = null;
  }
}

function showMobileScoreCard(response: ScorePointResponse): void {
  if (!mobileScoreCard) return;

  const v = response?.viewer;
  if (!v?.score) {
    console.error('Invalid score response:', response);
    alert('スコアデータの取得に失敗しました');
    return;
  }
  const totalPercent = Math.round(v.score.total * 100);

  // Score + color
  const scoreValueEl = document.getElementById('score-value');
  if (scoreValueEl) scoreValueEl.textContent = String(totalPercent);
  const mainEl = mobileScoreCard.querySelector('.score-card-main') as HTMLElement | null;
  const badge = document.getElementById('score-badge');

  if (totalPercent >= 70) {
    if (mainEl) mainEl.style.borderLeftColor = '#6ee7a0';
    if (badge) { badge.textContent = 'よく見える'; badge.className = 'score-badge excellent'; }
  } else if (totalPercent >= 50) {
    if (mainEl) mainEl.style.borderLeftColor = '#8bb3e4';
    if (badge) { badge.textContent = 'まあまあ'; badge.className = 'score-badge good'; }
  } else if (totalPercent >= 30) {
    if (mainEl) mainEl.style.borderLeftColor = '#fbbf24';
    if (badge) { badge.textContent = 'ほぼ見えない'; badge.className = 'score-badge fair'; }
  } else {
    if (mainEl) mainEl.style.borderLeftColor = '#f87171';
    if (badge) { badge.textContent = '見えない'; badge.className = 'score-badge poor'; }
  }


  // Details: human-friendly labels + values
  const distEl = document.getElementById('sc-distance');
  if (distEl) distEl.textContent = distanceWithWalk(v.distanceMeters);
  const angleEl = document.getElementById('sc-angle');
  if (angleEl) angleEl.textContent = `${v.viewingAngleDeg}°`;

  const losRaw = v.score.lineOfSight;
  const losEl = document.getElementById('sc-los');
  if (losEl) losEl.textContent =
    losRaw < 0 ? '周辺データ不足' :
    losRaw >= 0.9 ? '視界が開けている' : losRaw >= 0.5 ? '一部障害物あり' : '建物が視界を遮る';

  const accessScore = v.score.accessibility;
  const accessEl = document.getElementById('sc-access-label');
  if (accessEl) accessEl.textContent =
    accessScore >= 0.9 ? '公園・広場' : accessScore <= 0.3 ? '住宅地' : '一般';

  const relElev = v.relativeElevation;
  const elevEl = document.getElementById('sc-elevation');
  if (elevEl) elevEl.textContent =
    relElev > 10 ? `高台 +${relElev}m` : relElev > 3 ? `やや高い +${relElev}m` :
    relElev < -5 ? `低地 ${relElev}m` : `${relElev > 0 ? '+' : ''}${relElev}m`;

  // Bars
  const barAngle = document.getElementById('bar-angle') as HTMLElement | null;
  const barLos = document.getElementById('bar-los') as HTMLElement | null;
  const barAccess = document.getElementById('bar-access') as HTMLElement | null;
  const barSlope = document.getElementById('bar-slope') as HTMLElement | null;
  if (barAngle) barAngle.style.width = `${v.score.viewingAngle * 100}%`;
  if (barLos) barLos.style.width = losRaw < 0 ? '0%' : `${losRaw * 100}%`;
  if (barAccess) barAccess.style.width = `${accessScore * 100}%`;
  if (barSlope) barSlope.style.width = `${v.score.slope * 100}%`;

  mobileScoreCard.classList.remove('hidden');
  mobileScoreCard.classList.remove('minimized');
  mobileScoreCard.style.transform = '';
  bsMinimized = false;
  // カード表示中はフローティングボタンとピンアクションを隠す
  if (scoreHereBtn) scoreHereBtn.classList.add('hidden');
  hidePinActions();
}

/** カードを閉じてフローティングボタンを復帰 */
function closeScoreCard(): void {
  if (!mobileScoreCard) return;
  mobileScoreCard.classList.add('hidden');
  mobileScoreCard.style.transform = '';
  bsMinimized = false;
  hidePinActions();
  if (scoreHereBtn) scoreHereBtn.classList.remove('hidden');
}

// ============================================================
// Bottom sheet minimize / expand
// ============================================================

const BOTTOM_SHEET_PEEK = 72; // minimized時に見える高さ (px)
let bsMinimized = false;

function minimizeScoreCard(): void {
  if (!mobileScoreCard || mobileScoreCard.classList.contains('hidden')) return;
  const fullHeight = mobileScoreCard.offsetHeight;
  const minY = fullHeight - BOTTOM_SHEET_PEEK;
  bsMinimized = true;
  mobileScoreCard.classList.add('minimized');
  mobileScoreCard.style.transform = `translateY(${minY}px)`;
}

function expandScoreCard(): void {
  if (!mobileScoreCard) return;
  bsMinimized = false;
  mobileScoreCard.classList.remove('minimized');
  mobileScoreCard.style.transform = '';
}

if (isMobile && mobileScoreCard) {
  // ×ボタンでカードを閉じる
  const closeBtn = document.getElementById('score-card-close');
  closeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeScoreCard();
  });

  // 最小化状態のカードタップで展開
  mobileScoreCard.addEventListener('click', () => {
    if (bsMinimized) expandScoreCard();
  });

  // 「別の場所で調べる」ボタン → カードを閉じて地図タップモードへ
  const retryBtn = document.getElementById('score-retry-btn');
  retryBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeScoreCard();
    editorHint.classList.remove('hidden');
    editorHintText.textContent = '地図タップで見え方を確認';
  });
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
  flyToCenter(lat, lng, 14);
  if (isMobile) {
    mobileScoreCard?.classList.add('hidden');
    clearPendingPin();
    // タップでもスコア確認できることを案内
    editorHint.classList.remove('hidden');
    editorHintText.textContent = '地図タップで見え方を確認';
  }
});

initMap('map', (lat, lng) => {
  if (isAnalyzing) return;
  if (isMobile) {
    const launchLat = parseFloat(latInput.value);
    const launchLng = parseFloat(lngInput.value);
    if (isNaN(launchLat) || isNaN(launchLng)) return;

    // 地図タップでピン設置（APIはまだ叩かない）
    placePinAndShowActions(lat, lng);
    return;
  }
  presetSelect.value = '';
  setLaunchSite(lat, lng);
});
