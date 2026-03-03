---
name: dev-conventions
version: 1.0.0
description: Geolonia の開発規約・コーディングスタイルガイド。プロジェクトセットアップ、コーディング規約、Git ワークフローを確認する際に使用する。「規約」「コーディングスタイル」「開発ルール」と言われたら必ずこのスキルを参照する。
license: MIT
tags:
  - conventions
  - coding-style
  - best-practices
---

# Geolonia 開発規約

## プロジェクトセットアップ

### パッケージマネージャ

**pnpm のみ使用**（npm、yarn は禁止）

```bash
# 推奨
pnpm install
pnpm add <package>

# 禁止
npm install
yarn add
```

### TypeScript 設定

**strict モード必須、any 型禁止**

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true
  }
}
```

### Node.js バージョン

**Node.js 18 以上**

```json
{
  "engines": {
    "node": ">=18"
  }
}
```

## コーディング規約

### 命名規則

| 対象 | 規則 | 例 |
|------|------|-----|
| 変数・関数 | camelCase | `getUserById` |
| クラス・型 | PascalCase | `UserService` |
| 定数 | SCREAMING_SNAKE_CASE | `MAX_RETRY_COUNT` |
| ファイル（コンポーネント） | PascalCase | `UserCard.tsx` |
| ファイル（その他） | kebab-case | `user-service.ts` |

### インポート順序

```typescript
// 1. Node.js 組み込みモジュール
import path from 'node:path';

// 2. 外部パッケージ
import { z } from 'zod';

// 3. 内部モジュール（絶対パス）
import { UserService } from '@/services/user';

// 4. 相対パス
import { formatDate } from './utils';
```

### エラーハンドリング

```typescript
// ✅ Good: 明示的なエラーハンドリング
try {
  const user = await userService.findById(id);
  if (!user) {
    throw new NotFoundError(`User not found: ${id}`);
  }
  return user;
} catch (error) {
  if (error instanceof NotFoundError) {
    throw error;
  }
  throw new InternalError('Failed to fetch user', { cause: error });
}

// ❌ Bad: エラーを握りつぶす
try {
  return await userService.findById(id);
} catch {
  return null;
}
```

### 環境変数

```typescript
// ✅ Good: 明示的な検証
const apiKey = process.env.API_KEY;
if (!apiKey) {
  throw new Error('API_KEY environment variable is required');
}

// ❌ Bad: 暗黙の undefined
const apiKey = process.env.API_KEY!;
```

## Git ワークフロー

### ブランチ命名

```
feature/<issue-number>-<short-description>
fix/<issue-number>-<short-description>
docs/<short-description>
```

### コミットメッセージ

Conventional Commits を使用：

```
<type>(<scope>): <subject>

<body>

<footer>
```

| Type | 用途 |
|------|------|
| feat | 新機能 |
| fix | バグ修正 |
| docs | ドキュメント |
| style | フォーマット |
| refactor | リファクタリング |
| test | テスト |
| chore | ビルド・ツール |

### PR ルール

1. **main への直接 push 禁止**
2. **PR 前に `/code-review-expert` でローカルレビュー**
3. **P0/P1 の指摘は修正必須**
4. **CodeRabbit の Actionable 以上に対応**

## テスト

### テストファースト

実装前にテストを書く：

```typescript
// 1. テストを書く
describe('UserService', () => {
  it('should return user by id', async () => {
    const user = await userService.findById('123');
    expect(user).toEqual({ id: '123', name: 'Test User' });
  });
});

// 2. 実装する
class UserService {
  async findById(id: string): Promise<User | null> {
    // ...
  }
}
```

### E2E テスト重視

ユニットテストよりも E2E テストを優先：

```typescript
// E2E テスト例（Playwright）
test('ユーザーがログインできる', async ({ page }) => {
  await page.goto('/login');
  await page.fill('[name=email]', 'user@example.com');
  await page.fill('[name=password]', 'password');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL('/dashboard');
});
```

## 地図実装

**Geolonia Maps のみ使用**（Google Maps、Mapbox 禁止）

```typescript
// ✅ Good
import geolonia from '@geolonia/embed';

// ❌ Bad
import mapboxgl from 'mapbox-gl';
```

詳細は `geolonia-map` スキルを参照。

## 参考資料

- [TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)
- [Conventional Commits](https://www.conventionalcommits.org/)
