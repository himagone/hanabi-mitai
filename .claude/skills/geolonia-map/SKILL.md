---
name: geolonia-map
version: 1.0.0
description: Geolonia Maps の実装ガイド。地図の埋め込み、マーカー表示、GeoJSON レイヤー描画を行う際に使用する。「地図を表示したい」「マーカーを追加したい」「Geolonia」「MapLibre」と言われたら必ずこのスキルを参照する。
license: MIT
tags:
  - geolonia
  - maps
  - maplibre
  - geospatial
---

# Geolonia Maps 実装ガイド

## 重要な原則

- **Geolonia Maps のみ使用**（Google Maps、Mapbox は禁止）
- **API キーは環境変数 `GEOLONIA_API_KEY` から取得**（ハードコード禁止）
- **MapLibre GL JS と完全互換**

## セットアップ

### Embed API（HTML のみで動作）

```html
<script src="https://cdn.geolonia.com/v1/embed?geolonia-api-key=YOUR-API-KEY"></script>

<div
  class="geolonia"
  data-lat="35.6762"
  data-lng="139.6503"
  data-zoom="14"
  data-style="geolonia/gsi"
></div>
```

### JavaScript API

```html
<script src="https://cdn.geolonia.com/v1/embed?geolonia-api-key=YOUR-API-KEY"></script>

<div id="map" style="width: 100%; height: 400px;"></div>

<script>
const map = new geolonia.Map({
  container: 'map',
  style: 'geolonia/gsi',
  center: [139.6503, 35.6762],
  zoom: 14
});
</script>
```

### npm パッケージ

```bash
npm install @geolonia/embed
```

```javascript
import geolonia from '@geolonia/embed';

const map = new geolonia.Map({
  container: 'map',
  style: 'geolonia/gsi',
  center: [139.6503, 35.6762],
  zoom: 14
});
```

### 環境変数から API キーを取得

```javascript
// Next.js の場合
const apiKey = process.env.NEXT_PUBLIC_GEOLONIA_API_KEY;

// Node.js の場合
const apiKey = process.env.GEOLONIA_API_KEY;
```

## 利用可能なスタイル

| スタイル | 説明 |
|---------|------|
| `geolonia/gsi` | 国土地理院ベース（推奨） |
| `geolonia/basic` | シンプルなベースマップ |
| `geolonia/midnight` | ダークモード |
| `geolonia/notebook` | 手書き風 |
| `geolonia/red-planet` | 火星風 |

## マーカー追加

### Embed API（data 属性）

```html
<div
  class="geolonia"
  data-lat="35.6762"
  data-lng="139.6503"
  data-zoom="14"
  data-marker="on"
  data-marker-color="#FF0000"
></div>
```

### JavaScript API

```javascript
const marker = new geolonia.Marker({ color: '#FF0000' })
  .setLngLat([139.6503, 35.6762])
  .addTo(map);
```

### ポップアップ付きマーカー

```javascript
const popup = new geolonia.Popup({ offset: 25 })
  .setHTML('<h3>タイトル</h3><p>説明文</p>');

const marker = new geolonia.Marker()
  .setLngLat([139.6503, 35.6762])
  .setPopup(popup)
  .addTo(map);
```

## GeoJSON レイヤー描画

### 基本的な GeoJSON 追加

```javascript
map.on('load', () => {
  map.addSource('points', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [139.6503, 35.6762]
          },
          properties: {
            title: 'Tokyo'
          }
        }
      ]
    }
  });

  map.addLayer({
    id: 'points-layer',
    type: 'circle',
    source: 'points',
    paint: {
      'circle-radius': 8,
      'circle-color': '#FF0000'
    }
  });
});
```

### 外部 GeoJSON ファイルの読み込み

```javascript
map.on('load', () => {
  map.addSource('external-data', {
    type: 'geojson',
    data: 'https://example.com/data.geojson'
  });
});
```

### クラスタリング

```javascript
map.addSource('earthquakes', {
  type: 'geojson',
  data: 'https://example.com/earthquakes.geojson',
  cluster: true,
  clusterMaxZoom: 14,
  clusterRadius: 50
});

map.addLayer({
  id: 'clusters',
  type: 'circle',
  source: 'earthquakes',
  filter: ['has', 'point_count'],
  paint: {
    'circle-color': '#51bbd6',
    'circle-radius': 20
  }
});
```

## React コンポーネント例

```tsx
'use client';

import { useEffect, useRef } from 'react';
import geolonia from '@geolonia/embed';

interface MapProps {
  center?: [number, number];
  zoom?: number;
  style?: string;
  className?: string;
}

export function GeoloniaMap({
  center = [139.6503, 35.6762],
  zoom = 14,
  style = 'geolonia/gsi',
  className = 'w-full h-96'
}: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<geolonia.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    mapRef.current = new geolonia.Map({
      container: containerRef.current,
      style,
      center,
      zoom
    });

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [center, zoom, style]);

  return <div ref={containerRef} className={className} />;
}
```

## MapLibre GL JS との互換性

Geolonia Maps は MapLibre GL JS と完全互換。MapLibre のドキュメントも参照可能：

- https://maplibre.org/maplibre-gl-js/docs/

```javascript
// MapLibre の機能をそのまま使用可能
map.flyTo({
  center: [139.6503, 35.6762],
  zoom: 16,
  pitch: 45,
  bearing: -17.6
});
```

## 参考資料

- [Geolonia Maps ドキュメント](https://docs.geolonia.com/)
- [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/)
- [GeoJSON 仕様](https://geojson.org/)
