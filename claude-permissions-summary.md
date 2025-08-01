# Claude Permissions Summary

## 各プロジェクトの設定概要

### 1. vertical-writing-compliance-test
- **特徴**: 縦書き関連のテストプロジェクト
- **主な許可コマンド**:
  - ビルド・テスト系: `pnpm build:*`, `pnpm test:*`, `pnpm vitest run:*`
  - 開発系: `pnpm dev:*`, `pnpm run:*`
  - ツール系: `biome check:*`, `npx unocss:*`, `npx tsc:*`
  - MCP Playwright: 各種ブラウザ操作
  - その他: `find:*`, `ls:*`, `grep:*`, `rg:*`, `cat:*`

### 2. o3-mini-mcp
- **特徴**: MCPプロジェクト
- **主な許可コマンド**:
  - 基本操作: `mkdir:*`, `chmod:*`
  - パッケージ管理: `pnpm add:*`, `pnpm run:*`

### 3. gbf-automation
- **特徴**: ゲーム自動化プロジェクト
- **主な許可コマンド**:
  - フォーマット・チェック: `npx biome check:*`, `npx biome format:*`
  - ビルド・テスト: `NODE_ENV=development pnpm build`, `E2E_HEADLESS=* pnpm test:e2e`
  - MCP: `mcp__context7__get-library-docs`, Playwright操作
  - その他: `timeout:*`, `find:*`

### 4. blog.berlysia.net
- **特徴**: ブログプロジェクト
- **主な許可コマンド**:
  - 標準的な開発コマンド: `npm run lint`, `npm run typecheck:*`, `npm run build:*`
  - Playwright: `npx playwright:*`
  - MCP Context7: ライブラリドキュメント取得
  - WebFetch: `domain:localhost`のみ許可

### 5. proposal-auto-check
- **特徴**: 提案チェックプロジェクト
- **主な許可コマンド**:
  - MCP Readability: `mcp__readability__read_url_content_as_markdown`のみ

### 6. ml_aniv_tools
- **特徴**: 最も包括的な設定を持つプロジェクト
- **主な許可コマンド**:
  - パッケージ管理: `pnpm add:*`, `pnpm remove:*`, `pnpm install:*`
  - ビルド・テスト: `pnpm build:*`, `pnpm test:*`, `npx vitest:*`
  - フォーマット・リント: `pnpm lint:*`, `pnpm format:*`, `biome check:*`
  - Git操作: `git add:*`, `git commit:*`, `git worktree:*`, `gh pr:*`
  - 分析ツール: `similarity-ts:*`, `npx dpdm:*`
  - MCP: TypeScript診断、Playwright操作

## 共通パターンの分析

### 頻出する許可コマンド（3プロジェクト以上）
1. **ビルド系**:
   - `pnpm build:*` (3/6)
   - `npm run build:*` (3/6)

2. **検査系**:
   - `npx biome check:*` (3/6)
   - `pnpm run:*` (3/6)
   - `npm run typecheck:*` (2/6)
   - `pnpm typecheck:*` (2/6)

3. **ユーティリティ**:
   - `find:*` (3/6)
   - `mkdir:*` (3/6)
   - `node:*` (3/6)

4. **MCP系**:
   - Playwright browser操作 (3/6)
   - `mcp__context7__get-library-docs` (2/6)

### プロジェクトタイプ別の傾向
1. **Web開発プロジェクト**: Playwright、ビルド・テストツールを広く許可
2. **ツール系プロジェクト**: 基本的なファイル操作とパッケージ管理に限定
3. **ドキュメント系プロジェクト**: MCP Readabilityなど最小限の許可

## 推奨される全体設定

### 基本的な開発コマンド（安全性が高い）
```json
{
  "permissions": {
    "allow": [
      // ファイル検索・読み取り（読み取り専用）
      "Bash(find:*)",
      "Bash(ls:*)",
      "Bash(grep:*)",
      "Bash(rg:*)",
      "Bash(cat:*)",
      
      // ディレクトリ操作（基本的）
      "Bash(mkdir:*)",
      
      // パッケージマネージャー（ビルド・テスト）
      "Bash(pnpm build:*)",
      "Bash(pnpm test:*)",
      "Bash(pnpm typecheck:*)",
      "Bash(pnpm lint:*)",
      "Bash(npm run build:*)",
      "Bash(npm run test:*)",
      "Bash(npm run typecheck:*)",
      "Bash(npm run lint)",
      
      // コード品質ツール
      "Bash(npx biome check:*)",
      "Bash(npx biome format:*)",
      "Bash(biome check:*)",
      
      // TypeScript
      "Bash(npx tsc:*)",
      "Bash(tsc:*)",
      
      // テストランナー
      "Bash(npx vitest run:*)",
      
      // Node.js実行（プロジェクトのスクリプトのみ）
      "Bash(node:*)",
      
      // MCP基本ツール
      "mcp__context7__resolve-library-id",
      "mcp__context7__get-library-docs"
    ],
    "deny": []
  }
}
```

### プロジェクトタイプ別の追加設定

#### Webアプリケーション開発
```json
// 基本設定に追加
"mcp__playwright__browser_navigate",
"mcp__playwright__browser_click",
"mcp__playwright__browser_take_screenshot",
"mcp__playwright__browser_wait_for",
"mcp__playwright__browser_snapshot",
"WebFetch(domain:localhost)",
"WebFetch(domain:docs.anthropic.com)"
```

#### パッケージ開発・管理が必要な場合
```json
// 基本設定に追加
"Bash(pnpm add:*)",
"Bash(pnpm remove:*)",
"Bash(pnpm install:*)",
"Bash(npm install)"
```

#### CI/CD・Git操作が必要な場合
```json
// 基本設定に追加
"Bash(git add:*)",
"Bash(git commit:*)",
"Bash(git worktree:*)",
"Bash(gh pr:*)",
"Bash(gh run view:*)"
```

## セキュリティ上の考慮事項

### 避けるべき許可
1. **システム全体に影響する操作**
   - `Bash(rm -rf:*)` 
   - `Bash(sudo:*)`
   - `Bash(chmod 777:*)`

2. **外部通信（特定ドメイン以外）**
   - `WebFetch` は信頼できるドメインのみに限定

3. **環境変数の変更**
   - 必要な場合は特定の変数のみ許可

### 推奨事項
1. **最小権限の原則**: プロジェクトに必要な最小限の権限のみ許可
2. **段階的な許可**: 開発の進行に応じて必要な権限を追加
3. **定期的な見直し**: 不要になった権限は削除