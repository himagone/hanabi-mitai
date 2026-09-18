// ============================================================
// 打上地点の上空に割物（菊型）3D花火を描く MapLibre カスタムレイヤー。
//
// 責務: 打上→開花→消滅→小休止 を 1 サイクルとしてループ再生する
//       菊型花火を、地図と同じカメラ行列で描画する。
// 呼び出し元: map.ts（initLayers で addLayer、setFireworkAt で位置更新）。
// 前提: 打上地点は海抜 0m 付近。開花高度は海抜基準で局所メートル系に置く。
//
// 菊型の特徴:
//   - 均一球面分布（Fibonacci lattice）のスターが同時放射
//   - 各スターに光跡（中心 → スター頭部への線分）= 花弁
//   - 開花瞬間に白い閃光（短時間で消滅）
// ============================================================

import maplibregl from 'maplibre-gl';
import * as THREE from 'three';

/** サイクルごとに巡回する色 */
const PALETTE = [0xfbbf24, 0x8bb3e4, 0x6ee7a0];

/** 開花スター数。菊は均一球面分布で多めにする */
const SPARK_COUNT = 200;

// アニメーション各位相の長さ（秒）
const T_RISE  = 0.7;  // 打上: 光跡が上昇
const T_BURST = 1.2;  // 開花: スターが放射・落下
const T_FADE  = 0.6;  // 消滅
const T_PAUSE = 0.8;  // 小休止
const T_CYCLE = T_RISE + T_BURST + T_FADE + T_PAUSE;

/** 重力加速度（m/s²）*/
const GRAVITY = 9.0;

/** 展開係数: 大きいほど爆発的に広がる（菊は速い初期展開） */
const EXPANSION_K = 3.0;

/**
 * 光跡始点の内分比。
 * 0 = バースト中心、1 = スター頭部と同じ位置。
 * 0.3: 中心から30%の位置を始点にし、70%の長さの花弁を形成する。
 */
const TRAIL_RATIO = 0.3;

type Anchor = {
  merc: maplibregl.MercatorCoordinate;
  scale: number;
  burstHeight: number;
  radius: number;
};

/**
 * 発光する円形スプライトのテクスチャを生成する。
 * PointsMaterial の既定は矩形のため、中心が明るい放射グラデーションで
 * 火の粉らしい丸い光点にする。
 */
function makeSparkTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

export class FireworkLayer implements maplibregl.CustomLayerInterface {
  readonly id = 'firework-3d';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  private map: maplibregl.Map | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();

  // onAdd で必ず初期化され、render/onRemove からのみ参照される
  private stars!: THREE.Points;           // 各スターの頭部（明るい点）
  private starTails!: THREE.LineSegments; // スターの光跡（菊の花弁）
  private launchTrail!: THREE.Points;     // 打上光跡（上昇中の 1 点）
  private flash!: THREE.Points;           // 開花瞬間の閃光

  private starMaterial!: THREE.PointsMaterial;
  private tailMaterial!: THREE.LineBasicMaterial;
  private launchMaterial!: THREE.PointsMaterial;
  private flashMaterial!: THREE.PointsMaterial;

  /** Fibonacci lattice（黄金角）で生成した均一球面分布の方向ベクトル */
  private readonly dirs: THREE.Vector3[] = [];
  /** 速さ: 菊は均一な球殻を見せるため変動幅を小さく抑える */
  private readonly speeds: number[] = [];

  private anchor: Anchor | null = null;
  private startMs = 0;
  private readonly reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  onAdd(map: maplibregl.Map, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
      antialias: true,
    });
    this.renderer.autoClear = false;

    const texture = makeSparkTexture();

    // 黄金角 Fibonacci lattice で均一球面分布を生成
    for (let i = 0; i < SPARK_COUNT; i++) {
      const theta = Math.acos(1 - 2 * (i + 0.5) / SPARK_COUNT);
      const phi = i * Math.PI * (3 - Math.sqrt(5)); // 黄金角 ≈ 2.4rad
      this.dirs.push(new THREE.Vector3(
        Math.sin(theta) * Math.cos(phi),
        Math.sin(theta) * Math.sin(phi),
        Math.cos(theta),
      ));
      // 菊は速さのばらつきを小さくして綺麗な球殻に見せる
      this.speeds.push(0.92 + 0.08 * Math.sin(i * 12.9898));
    }

    // ---- スター頭部（明るい点）----
    const starGeom = new THREE.BufferGeometry();
    starGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(SPARK_COUNT * 3), 3),
    );
    this.starMaterial = new THREE.PointsMaterial({
      size: 8,
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: false,
    });
    this.stars = new THREE.Points(starGeom, this.starMaterial);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);

    // ---- スター光跡（菊の花弁）----
    // SPARK_COUNT 本の線分 × 2 頂点。LineSegments は [v0,v1], [v2,v3], ... と独立線分を描く。
    const tailGeom = new THREE.BufferGeometry();
    tailGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(SPARK_COUNT * 2 * 3), 3),
    );
    this.tailMaterial = new THREE.LineBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.starTails = new THREE.LineSegments(tailGeom, this.tailMaterial);
    this.starTails.frustumCulled = false;
    this.scene.add(this.starTails);

    // ---- 開花瞬間の閃光（白い大点が 0.15s で消える）----
    const flashGeom = new THREE.BufferGeometry();
    flashGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.flashMaterial = new THREE.PointsMaterial({
      size: 50,
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: false,
      color: 0xffffff,
    });
    this.flash = new THREE.Points(flashGeom, this.flashMaterial);
    this.flash.frustumCulled = false;
    this.scene.add(this.flash);

    // ---- 打上光跡（1 点が上昇）----
    const launchGeom = new THREE.BufferGeometry();
    launchGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.launchMaterial = new THREE.PointsMaterial({
      size: 6,
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: false,
    });
    this.launchTrail = new THREE.Points(launchGeom, this.launchMaterial);
    this.launchTrail.frustumCulled = false;
    this.scene.add(this.launchTrail);

    this.startMs = performance.now();
  }

  onRemove(): void {
    // starMaterial/launchMaterial/flashMaterial は同一テクスチャを参照するため 1 回だけ解放する
    this.starMaterial.map?.dispose();
    this.stars.geometry.dispose();
    this.starTails.geometry.dispose();
    this.launchTrail.geometry.dispose();
    this.flash.geometry.dispose();
    this.starMaterial.dispose();
    this.tailMaterial.dispose();
    this.launchMaterial.dispose();
    this.flashMaterial.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    this.map = null;
  }

  /** 打上地点と開花規模を設定する。radius/burstHeight はメートル */
  setAnchor(lat: number, lng: number, burstHeight: number, radius: number): void {
    const merc = maplibregl.MercatorCoordinate.fromLngLat([lng, lat], 0);
    this.anchor = {
      merc,
      scale: merc.meterInMercatorCoordinateUnits(),
      burstHeight,
      radius,
    };
    this.startMs = performance.now();
    this.map?.triggerRepaint();
  }

  /** 花火を消す。setAnchor するまで何も描画しない */
  clear(): void {
    this.anchor = null;
    this.map?.triggerRepaint();
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, matrix: ArrayLike<number>): void {
    if (!this.renderer || !this.anchor) return;

    const { merc, scale, burstHeight, radius } = this.anchor;

    // 局所メートル系（東, 北, 上）→ メルカトル座標。y を反転するのは
    // メルカトル座標の y が南向きに増えるため。z（高度）はそのまま上向き。
    const model = new THREE.Matrix4()
      .makeTranslation(merc.x, merc.y, merc.z)
      .scale(new THREE.Vector3(scale, -scale, scale));
    this.camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(model);

    this.updateParticles(burstHeight, radius);

    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);

    // reduced-motion では静止画のため再描画をループさせない
    if (!this.reduceMotion) this.map?.triggerRepaint();
  }

  /** 現在時刻から各パーティクルの位置と不透明度を計算する */
  private updateParticles(burstHeight: number, radius: number): void {
    const elapsedMs = performance.now() - this.startMs;
    const nowSec = this.reduceMotion
      ? T_RISE + T_BURST * 0.4
      : (elapsedMs / 1000) % T_CYCLE;
    const cycleIndex = this.reduceMotion
      ? 0
      : Math.floor(elapsedMs / 1000 / T_CYCLE);

    const color = PALETTE[cycleIndex % PALETTE.length];
    this.starMaterial.color.setHex(color);
    this.tailMaterial.color.setHex(color);
    this.launchMaterial.color.setHex(color);

    const starPos   = this.stars.geometry.attributes.position as THREE.BufferAttribute;
    const tailPos   = this.starTails.geometry.attributes.position as THREE.BufferAttribute;
    const launchPos = this.launchTrail.geometry.attributes.position as THREE.BufferAttribute;
    const flashPos  = this.flash.geometry.attributes.position as THREE.BufferAttribute;

    if (nowSec < T_RISE) {
      // 打上位相: 光跡のみ表示し、開花要素は非表示
      const p = nowSec / T_RISE;
      const y = burstHeight * (1 - (1 - p) * (1 - p)); // ease-out で減速しながら上昇
      launchPos.setXYZ(0, 0, 0, y);
      launchPos.needsUpdate = true;
      this.launchMaterial.opacity = 1;
      this.starMaterial.opacity = 0;
      this.tailMaterial.opacity = 0;
      this.flashMaterial.opacity = 0;
      return;
    }

    this.launchMaterial.opacity = 0;

    const tb = nowSec - T_RISE; // 開花からの経過秒
    const inFade = tb > T_BURST;
    const fadeP = inFade ? (tb - T_BURST) / T_FADE : 0;
    const burstOpacity = inFade ? Math.max(0, 1 - fadeP) : 1;

    // 開花瞬間閃光: 最初の 0.15s だけ白く光る
    this.flashMaterial.opacity = Math.max(0, 1 - tb / 0.15) * 0.85;
    flashPos.setXYZ(0, 0, 0, burstHeight);
    flashPos.needsUpdate = true;

    this.starMaterial.opacity = burstOpacity;
    // 光跡はスター頭部より控えめに、菊の花弁の透け感を出す
    this.tailMaterial.opacity = burstOpacity * 0.65;

    const spread = radius * (1 - Math.exp(-tb * EXPANSION_K));
    const drop = 0.5 * GRAVITY * tb * tb;

    for (let i = 0; i < SPARK_COUNT; i++) {
      const d = this.dirs[i];
      const s = this.speeds[i];

      const px = d.x * spread * s;
      const py = d.y * spread * s;
      const pz = burstHeight + d.z * spread * s - drop;

      // スター頭部
      starPos.setXYZ(i, px, py, pz);

      // 光跡（菊の花弁）: バースト中心(0,0,burstHeight) と現在位置の内分点 → 現在位置
      // 始点 = lerp(center, current, TRAIL_RATIO)、終点 = current
      tailPos.setXYZ(i * 2,     px * TRAIL_RATIO, py * TRAIL_RATIO, burstHeight + (pz - burstHeight) * TRAIL_RATIO);
      tailPos.setXYZ(i * 2 + 1, px, py, pz);
    }

    starPos.needsUpdate = true;
    tailPos.needsUpdate = true;
  }
}
