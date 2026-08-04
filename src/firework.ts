// ============================================================
// 打上地点の上空に立体花火を描く MapLibre カスタムレイヤー。
//
// 責務: 打上→開花→消滅→小休止を 1 サイクルとしてループ再生する
//       3D パーティクル花火を、地図と同じカメラ行列で描画する。
// 呼び出し元: map.ts（initLayers で addLayer、setFireworkAt で位置更新）。
// 前提: 打上地点は海抜 0m 付近（東京の花火大会プリセット）。地面標高は
//       考慮せず、開花高度は海抜基準で局所メートル系に置く。
// ============================================================

import maplibregl from 'maplibre-gl';
import * as THREE from 'three';

/** サイクルごとに巡回する色。スプラッシュ画面の花火と同一の3色 */
const PALETTE = [0xfbbf24, 0x8bb3e4, 0x6ee7a0];

/** 開花パーティクル数。多すぎると低性能端末で重くなるため抑える */
const SPARK_COUNT = 140;

// アニメーション各位相の長さ（秒）
const T_RISE = 0.6; // 打上: 地上から開花高度まで光跡が上昇
const T_BURST = 0.9; // 開花: 球状に放射し重力で減速・落下
const T_FADE = 0.6; // 消滅: 全体をフェードアウト
const T_PAUSE = 0.5; // 小休止
const T_CYCLE = T_RISE + T_BURST + T_FADE + T_PAUSE;

/** 開花後の重力加速度（m/s^2）。実測ではなく見た目のための値 */
const GRAVITY = 9.0;

type Anchor = {
  merc: maplibregl.MercatorCoordinate;
  scale: number; // 1メートルあたりのメルカトル座標単位
  burstHeight: number; // 開花高度（m）
  radius: number; // 開花半径（m）
};

/**
 * 発光する円形スプライトのテクスチャを生成する。
 * PointsMaterial の既定は矩形のため、中心が明るい放射グラデーションで
 * 花火の火の粉らしい丸い光点にする。
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
  private trail!: THREE.Points;
  private sparks!: THREE.Points;
  private sparkMaterial!: THREE.PointsMaterial;
  private trailMaterial!: THREE.PointsMaterial;

  // 各パーティクルの初速方向（単位球面上のベクトル、東・北・上）
  private readonly dirs: THREE.Vector3[] = [];
  // 各パーティクルの初速の大きさ（m/s）
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

    // 開花パーティクル: 方向と速さを事前に決め、位置は毎フレーム再計算する
    const sparkGeom = new THREE.BufferGeometry();
    sparkGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(SPARK_COUNT * 3), 3),
    );
    for (let i = 0; i < SPARK_COUNT; i++) {
      // 単位球面上に一様分布（緯度方向の偏りを避けるため acos で分布）
      const u = i / SPARK_COUNT;
      const theta = Math.acos(1 - 2 * ((i + 0.5) / SPARK_COUNT));
      const phi = u * Math.PI * 2 * 7.0; // 黄金角に近い巻きで方位を散らす
      this.dirs.push(
        new THREE.Vector3(
          Math.sin(theta) * Math.cos(phi),
          Math.sin(theta) * Math.sin(phi),
          Math.cos(theta),
        ),
      );
      // 速さに個体差をつけ、球殻に厚みを出す
      this.speeds.push(0.75 + 0.25 * Math.sin(i * 12.9898));
    }

    this.sparkMaterial = new THREE.PointsMaterial({
      size: 7,
      map: texture,
      transparent: true,
      depthWrite: false, // 加算合成では深度を書かず、建物には depthTest で隠れる
      blending: THREE.AdditiveBlending,
      sizeAttenuation: false,
    });
    this.sparks = new THREE.Points(sparkGeom, this.sparkMaterial);
    this.sparks.frustumCulled = false;
    this.scene.add(this.sparks);

    // 打上光跡: 1点が地上から開花高度へ上昇する
    const trailGeom = new THREE.BufferGeometry();
    trailGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.trailMaterial = new THREE.PointsMaterial({
      size: 6,
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: false,
    });
    this.trail = new THREE.Points(trailGeom, this.trailMaterial);
    this.trail.frustumCulled = false;
    this.scene.add(this.trail);

    this.startMs = performance.now();
  }

  onRemove(): void {
    this.sparks.geometry.dispose();
    this.trail.geometry.dispose();
    this.sparkMaterial.dispose();
    this.trailMaterial.dispose();
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
    // 位置を変えたらサイクルを最初から再生する
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
    // reduced-motion では開花直後（見栄えのする瞬間）で時間を固定する
    const elapsed = this.reduceMotion
      ? T_RISE + T_BURST * 0.35
      : ((performance.now() - this.startMs) / 1000) % T_CYCLE;

    const cycleIndex = this.reduceMotion
      ? 0
      : Math.floor((performance.now() - this.startMs) / 1000 / T_CYCLE);
    const color = PALETTE[cycleIndex % PALETTE.length];
    this.sparkMaterial.color.setHex(color);
    this.trailMaterial.color.setHex(color);

    const sparkPos = this.sparks.geometry.attributes.position as THREE.BufferAttribute;
    const trailPos = this.trail.geometry.attributes.position as THREE.BufferAttribute;

    if (elapsed < T_RISE) {
      // 打上位相: 光跡のみ表示し、開花パーティクルは原点に畳んで隠す
      const p = elapsed / T_RISE;
      const y = burstHeight * (1 - (1 - p) * (1 - p)); // ease-out で減速しながら上昇
      trailPos.setXYZ(0, 0, 0, y);
      trailPos.needsUpdate = true;
      this.trailMaterial.opacity = 1;
      this.sparkMaterial.opacity = 0;
      return;
    }

    // 開花・消滅位相: 光跡を消し、パーティクルを放射させる
    this.trailMaterial.opacity = 0;

    const tb = elapsed - T_RISE; // 開花からの経過秒
    const inFade = tb > T_BURST;
    const fadeP = inFade ? (tb - T_BURST) / T_FADE : 0;
    this.sparkMaterial.opacity = inFade ? Math.max(0, 1 - fadeP) : 1;

    // 空気抵抗で速度が減衰する見た目を、指数で近似した到達距離で表現する
    const spread = radius * (1 - Math.exp(-tb * 2.2));
    const drop = 0.5 * GRAVITY * tb * tb; // 自由落下による下降量

    for (let i = 0; i < SPARK_COUNT; i++) {
      const d = this.dirs[i];
      const s = this.speeds[i];
      sparkPos.setXYZ(
        i,
        d.x * spread * s,
        d.y * spread * s,
        burstHeight + d.z * spread * s - drop,
      );
    }
    sparkPos.needsUpdate = true;
  }
}
