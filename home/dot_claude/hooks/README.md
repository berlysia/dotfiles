# Claude Code Hook Scripts

このディレクトリには、Claude Codeのフックスクリプト（TypeScript実装）が含まれています。

## ディレクトリ構造

```
hooks/
├── implementations/              # Hook実装スクリプト（TypeScript）
│   ├── auto-approve.ts          # 自動承認スクリプト
│   ├── deny-repository-outside.ts  # リポジトリ外アクセス制限
│   ├── block-tsx.ts             # tsx/ts-node実行制限
│   ├── deny-node-modules.ts     # node_modules書き込み制限
│   ├── block-package-json-tsx.ts   # package.json tsx制限
│   ├── web-fetch-guardian.ts    # WebFetch制限
│   ├── command-logger.ts        # コマンド実行ログ
│   ├── session.ts               # セッション管理
│   ├── notification.ts          # 通知処理
│   ├── speak-notification.ts    # 音声通知
│   └── user-prompt-logger.ts    # プロンプトログ
├── lib/                         # 共有ライブラリ（TypeScript）
│   ├── bash-parser.ts           # Bashコマンド構造解析
│   ├── centralized-logging.ts   # 統合ロギング
│   ├── chezmoi-utils.ts         # chezmoi関連ユーティリティ
│   ├── command-parsing.ts       # コマンド解析・危険コマンド検出
│   ├── context-helpers.ts       # コンテキストヘルパー
│   ├── decision-maker.ts        # 判定ロジック
│   ├── file-permission-inference.ts # ファイルパーミッション推論
│   ├── git-context.ts           # Git リポジトリ情報管理
│   ├── path-utils.ts            # パス操作ユーティリティ
│   ├── pattern-matcher.ts       # パターンマッチング
│   ├── permission-analyzer.ts   # パーミッション分析
│   ├── permission-request-helpers.ts # パーミッション要求ヘルパー
│   ├── risk-assessment.ts       # リスク評価
│   ├── sed-parser.ts            # sedコマンド解析
│   └── structured-llm-evaluator.ts # LLM評価ロジック
├── utilities/                   # スタンドアロンツール
│   └── generate-stats.ts        # 統計レポート生成
├── types/                       # 型定義
│   ├── project-types.ts           # Hook型定義
│   └── tool-schemas.ts          # ツールスキーマ
├── tests/                       # テストスイート
│   ├── integration/             # 統合テスト
│   ├── unit/                    # 単体テスト
│   └── README_TESTING.md        # テスト実行ガイド
├── scripts/                     # 実行用シェルスクリプト
│   ├── all_tests.sh             # 全テスト実行
│   ├── ci_test.sh               # CI用テスト
│   └── test-with-types.sh       # 型チェック付きテスト
├── sounds/                      # 通知音ファイル
├── common.json.tmpl             # hook設定テンプレート
├── README.md                    # このファイル
└── SAMPLE.md                    # Hook I/Oリファレンス
```

## 主要なHook実装

### auto-approve.ts

権限設定に基づいてコマンドを自動承認/拒否するスクリプトです。

#### 機能

1. **危険なコマンドの検出**（`command-parsing.ts` の `checkDangerousCommand` で実装）
   - **ファイル操作**: `rm -rf`（変数展開/ルート指定）、`sudo rm`、`dd`、`mkfs`
   - **Git操作**: `push --force/-f`、`reset --hard`、`clean -fd`、`branch -D`、`--no-verify`
   - **GitHub CLI**: `pr merge/close`、`issue close/delete`、`repo delete/archive`
   - **パッケージマネージャ**: `npm/pnpm/bun publish/unpublish/deprecate`
   - **その他**: piped shell execution、環境変数操作

2. **パターンマッチング**
   - GitIgnore形式のパターンサポート
   - 複合コマンド（&&, ||, ;）の個別検証
   - Allow/Denyリストによる柔軟な制御

3. **ログ記録**
   - 詳細な分析結果をログファイルに記録

#### アーキテクチャ

モジュール化されたTypeScript設計により、保守性と拡張性を向上：

- **bash-parser.ts**: 複合コマンド（`&&`, `||`, `;`）の構造解析
- **command-parsing.ts**: コマンド抽出と危険なコマンドの検出（`checkDangerousCommand`）
- **pattern-matcher.ts**: Allow/Denyパターンとのマッチング処理
- **decision-maker.ts**: 最終的な承認/拒否の判定ロジック
- **centralized-logging.ts**: 分析結果のロギング

### 設定例

`.claude/settings.json`:
```json
{
  "permissions": {
    "allow": [
      "Bash(git status)",
      "Bash(git diff *)",
      "Bash(git log *)",
      "Bash(npm install *)",
      "Bash(pnpm install *)",
      "Edit(src/**)",
      "Read(**)"
    ],
    "deny": [
      "Bash(rm -rf *)",
      "Edit(.git/**)"
    ]
  }
}
```

**注意**: パターン構文は `Bash(command *)` 形式を使用します（旧 `:*` 形式は非推奨）。
安全のため、`git *` や `npm *` のような広範なワイルドカードは避け、個別のサブコマンドを指定してください。

## 技術仕様

### 実行環境
- **Runtime**: Bun (推奨) または Node.js
- **Language**: TypeScript
- **Framework**: cc-hooks-ts (型安全なhook定義)

### 依存関係管理
- **Package Manager**: pnpm
- **Location**: プロジェクトルート (`/home/berlysia/.local/share/chezmoi/`)

### Hook設定
- **設定ファイル**: `common.json.tmpl` (chezmoi管理)
- **実行パス**: `{{ .chezmoi.homeDir }}/.claude/hooks/implementations/`

## テスト

```bash
# 型チェック付き全テスト実行
./scripts/test-with-types.sh

# 統合テスト実行
./tests/integration/run-ts-hook-tests.sh

# CI環境でのテスト
./scripts/ci_test.sh
```

## 開発

### 新しいHookの追加

1. `implementations/` に TypeScript ファイルを作成
2. `cc-hooks-ts` の `defineHook` を使用
3. `common.json.tmpl` に設定を追加
4. テストケースを `tests/` に追加

### 例: 新しいHook実装

```typescript
#!/usr/bin/env bun

import { defineHook } from "cc-hooks-ts";

export default defineHook({
  trigger: { PreToolUse: true },
  run: (context) => {
    const { tool_name, tool_input } = context.input;
    
    // validation logic here
    
    return context.success({
      messageForUser: "Hook executed successfully"
    });
  }
});
```

## ユーティリティ

### generate-stats.ts
コマンド実行統計の生成とレポート出力


## トラブルシューティング

### 実行エラー
1. プロジェクトルートから実行しているか確認
2. 依存関係が正しくインストールされているか確認
3. TypeScriptの型エラーがないか確認

### デバッグ
```bash
# 個別hookの実行テスト
echo '{"tool_name": "Bash", "tool_input": {"command": "ls"}}' | bun implementations/auto-approve.ts

# 型チェック
npx tsgo --noEmit implementations/*.ts
```