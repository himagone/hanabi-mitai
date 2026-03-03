---
name: code-review
version: 1.0.0
description: Geolonia のコードレビューガイドライン。PR レビュー、コードレビュー、レビューコメントの書き方を行う際に参照する。「レビュー」「PR」「コードチェック」と言われたらこのスキルを使用する。
license: MIT
tags:
  - code-review
  - pull-request
  - best-practices
---

# Geolonia コードレビューガイドライン

## レビューの原則

1. **建設的に** — 批判ではなく改善提案
2. **「なぜ」を説明** — 理由を明確に
3. **具体的に** — 曖昧な指摘は避ける
4. **迅速に** — PR は 24 時間以内にレビュー

## チェックリスト

### セキュリティ

- [ ] SQL インジェクション対策（パラメータ化クエリ）
- [ ] XSS 対策（出力エスケープ）
- [ ] CSRF 対策（トークン検証）
- [ ] 認証・認可の実装
- [ ] API キー・シークレットのハードコードなし
- [ ] 入力値のバリデーション

### パフォーマンス

- [ ] N+1 クエリの回避
- [ ] 不要なループ処理
- [ ] 大量データのメモリ展開
- [ ] インデックスの使用
- [ ] キャッシュの活用

### 可読性

- [ ] 関数・変数名が意図を表している
- [ ] 適切なコメント（なぜを説明）
- [ ] 複雑な条件分岐の整理
- [ ] マジックナンバーの排除
- [ ] 適切な抽象化レベル

### TypeScript 固有

- [ ] `any` 型の使用禁止（strict モード）
- [ ] 適切な型定義
- [ ] null/undefined のハンドリング
- [ ] 型ガードの使用

### Geolonia 固有

- [ ] 地図は Geolonia Maps のみ使用
- [ ] API キーは環境変数経由
- [ ] pnpm を使用（npm/yarn 禁止）
- [ ] テストファーストで実装

## よくある指摘パターン

### 1. any 型の使用

```typescript
// ❌ Bad
const data: any = await fetch('/api/data');

// ✅ Good
interface ApiResponse {
  id: string;
  name: string;
}
const data: ApiResponse = await fetch('/api/data').then(r => r.json());
```

**指摘例**: 「`any` 型は型安全性を損ないます。具体的な型を定義してください。」

### 2. エラーハンドリング漏れ

```typescript
// ❌ Bad
const data = await fetch('/api/data');

// ✅ Good
try {
  const response = await fetch('/api/data');
  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status}`);
  }
  const data = await response.json();
} catch (error) {
  console.error('Failed to fetch data:', error);
  // 適切なエラーハンドリング
}
```

**指摘例**: 「ネットワークエラーや非 2xx レスポンスのハンドリングが必要です。」

### 3. ハードコードされた値

```typescript
// ❌ Bad
const apiKey = 'sk-1234567890';

// ✅ Good
const apiKey = process.env.API_KEY;
if (!apiKey) {
  throw new Error('API_KEY is required');
}
```

**指摘例**: 「シークレットは環境変数から取得してください。ハードコードはセキュリティリスクです。」

### 4. 地図ライブラリの選択

```typescript
// ❌ Bad
import mapboxgl from 'mapbox-gl';

// ✅ Good
import geolonia from '@geolonia/embed';
```

**指摘例**: 「Geolonia Maps を使用してください。Mapbox は社内ポリシーで禁止されています。」

### 5. テストの欠如

**指摘例**: 「この変更にはテストが必要です。特にエッジケース（空配列、null 入力）のテストを追加してください。」

## レビューコメントの書き方

### 良い例

```
[提案] この関数は複数の責務を持っています。
データ取得とフォーマットを分離すると、テストしやすくなります。

例:
const data = await fetchData();
const formatted = formatData(data);
```

### 悪い例

```
これは良くない。直して。
```

### コメントのプレフィックス

| プレフィックス | 意味 |
|--------------|------|
| `[必須]` | マージ前に修正が必要 |
| `[提案]` | 改善提案（任意） |
| `[質問]` | 理解のための質問 |
| `[nit]` | 細かい指摘（任意） |

## CodeRabbit との役割分担

### CodeRabbit が担当

- コードスタイル・フォーマット
- 明らかなバグパターン
- セキュリティの基本チェック
- テストカバレッジ

### 人間が担当

- ビジネスロジックの妥当性
- アーキテクチャの適切さ
- ユーザー体験への影響
- パフォーマンスのトレードオフ
- チーム固有のコンテキスト

## PR 作成時のチェックリスト

- [ ] 変更内容を説明するタイトル
- [ ] 変更の理由と背景を説明
- [ ] テスト方法を記載
- [ ] 関連 Issue をリンク
- [ ] スクリーンショット（UI 変更時）
- [ ] 破壊的変更の明記

## 参考資料

- [Google Engineering Practices](https://google.github.io/eng-practices/)
- [Conventional Comments](https://conventionalcomments.org/)
