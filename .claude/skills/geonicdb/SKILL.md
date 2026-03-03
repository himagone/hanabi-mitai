---
name: geonicdb
version: 1.0.0
description: GeonicDB（FIWARE Context Broker）のエンティティ操作ガイド。NGSI-LD エンティティの作成・更新・削除、サブスクリプション設定、地理空間クエリを行う際に使用する。「GeonicDB」「FIWARE」「Context Broker」「NGSI」と言われたら必ずこのスキルを参照する。
license: MIT
tags:
  - geonicdb
  - fiware
  - ngsi
  - context-broker
---

# GeonicDB 操作ガイド

## 概要

GeonicDB は Geolonia が提供する FIWARE Context Broker ベースのデータプラットフォーム。NGSI-LD 標準に準拠したエンティティの管理が可能。

## エンティティ操作

### エンティティ作成

```bash
curl -X POST 'https://api.geonicdb.geolonia.com/ngsi-ld/v1/entities' \
  -H 'Content-Type: application/ld+json' \
  -H 'Authorization: Bearer $TOKEN' \
  -d '{
    "@context": "https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context.jsonld",
    "id": "urn:ngsi-ld:Building:001",
    "type": "Building",
    "name": {
      "type": "Property",
      "value": "東京オフィス"
    },
    "location": {
      "type": "GeoProperty",
      "value": {
        "type": "Point",
        "coordinates": [139.6503, 35.6762]
      }
    }
  }'
```

### エンティティ取得

```bash
curl 'https://api.geonicdb.geolonia.com/ngsi-ld/v1/entities/urn:ngsi-ld:Building:001' \
  -H 'Authorization: Bearer $TOKEN'
```

### エンティティ更新

```bash
curl -X PATCH 'https://api.geonicdb.geolonia.com/ngsi-ld/v1/entities/urn:ngsi-ld:Building:001/attrs' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer $TOKEN' \
  -d '{
    "name": {
      "type": "Property",
      "value": "新東京オフィス"
    }
  }'
```

### エンティティ削除

```bash
curl -X DELETE 'https://api.geonicdb.geolonia.com/ngsi-ld/v1/entities/urn:ngsi-ld:Building:001' \
  -H 'Authorization: Bearer $TOKEN'
```

## 地理空間クエリ

### 近傍検索

```bash
curl 'https://api.geonicdb.geolonia.com/ngsi-ld/v1/entities?type=Building&georel=near;maxDistance==1000&geometry=Point&coordinates=[139.6503,35.6762]' \
  -H 'Authorization: Bearer $TOKEN'
```

### ポリゴン内検索

```bash
curl 'https://api.geonicdb.geolonia.com/ngsi-ld/v1/entities?type=Building&georel=within&geometry=Polygon&coordinates=[[[139.6,35.6],[139.7,35.6],[139.7,35.7],[139.6,35.7],[139.6,35.6]]]' \
  -H 'Authorization: Bearer $TOKEN'
```

## サブスクリプション

### サブスクリプション作成

```bash
curl -X POST 'https://api.geonicdb.geolonia.com/ngsi-ld/v1/subscriptions' \
  -H 'Content-Type: application/ld+json' \
  -H 'Authorization: Bearer $TOKEN' \
  -d '{
    "@context": "https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context.jsonld",
    "type": "Subscription",
    "entities": [{"type": "Building"}],
    "notification": {
      "endpoint": {
        "uri": "https://example.com/webhook",
        "accept": "application/json"
      }
    }
  }'
```

## 認証

API キーは環境変数 `GEONICDB_TOKEN` から取得：

```javascript
const token = process.env.GEONICDB_TOKEN;
```

## 参考資料

- [NGSI-LD 仕様](https://www.etsi.org/deliver/etsi_gs/CIM/001_099/009/01.04.01_60/gs_cim009v010401p.pdf)
- [FIWARE Context Broker](https://fiware-orion.readthedocs.io/)
