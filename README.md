# 花火みたい

花火のベストポジションを地形データから分析するWebアプリケーション。

## 機能

### デスクトップ

- 花火大会の打上地点を中心にグリッド分析を実行し、おすすめの観覧地点をランキング表示
- ヒートマップで各地点のスコアを可視化
- 立入禁止エリアを矩形ドラッグで描画し、候補から除外

### モバイル

- 花火大会を選択し、地図タップまたはGPSで現在地のスコアを確認
- スコアの内訳（距離・仰角・見通し・周辺環境・地形）をバー付きカードで表示

## スコアリング

地形・建物・土地利用データから5つの観点で評価し、距離による視認性を乗数として適用。

詳細は [SCORING.md](./SCORING.md) を参照。

## 技術スタック

| レイヤー | 技術 |
|----------|------|
| フロントエンド | TypeScript, Vite, MapLibre GL JS |
| バックエンド | AWS Lambda (Node.js 20), API Gateway v2 |
| インフラ | AWS SAM |
| ホスティング | GitHub Pages（フロント）, API Gateway（API） |
| データソース | 国土地理院 DEM5A/DEM10B（標高）, OpenStreetMap Overpass API（土地利用・建物） |

## ローカル開発

```bash
# フロントエンド
npm install
npm run dev          # http://localhost:5173

# Lambda ローカルサーバー
cd lambda
npm install
npm run dev          # http://localhost:3001
```

開発時は Vite のプロキシで `/api` → `localhost:3001` に転送される。

## デプロイ

### フロントエンド（GitHub Pages）

`main` ブランチに push すると GitHub Actions で自動デプロイ。

### バックエンド（AWS Lambda）

```bash
# SSO ログイン
aws sso login --profile AWSAdministratorAccess-314146318183

# Lambda ビルド & デプロイ
cd lambda && npm run build && cd ..
sam deploy --profile AWSAdministratorAccess-314146318183 --no-confirm-changeset
```

## 対応花火大会

| 大会 | 開花直径 |
|------|----------|
| 隅田川花火大会（第一会場） | 100m |
| 隅田川花火大会（第二会場） | 80m |
| 足立の花火 | 90m |
| 江戸川区花火大会 | 90m |
| 葛飾納涼花火大会 | 90m |
| いたばし花火大会 | 120m |
| STAR ISLAND | 70m |
| お台場レインボー花火 | 70m |
| 神宮外苑花火大会 | 80m |
| 東京競馬場花火 | 110m |
| 調布花火 | 100m |
| 世田谷区たまがわ花火大会 | 80m |

花火の開花直径は大会ごとに設定され、スコアリング（見かけの大きさ・開花高度）に反映される。一部の大会は打上地点が推定値。
