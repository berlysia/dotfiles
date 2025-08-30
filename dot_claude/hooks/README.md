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
│   ├── auto-format.ts           # ファイル自動フォーマット
│   ├── session.ts               # セッション管理
│   ├── notification.ts          # 通知処理
│   ├── speak-notification.ts    # 音声通知
│   └── user-prompt-logger.ts    # プロンプトログ
├── lib/                         # 共通ライブラリ（TypeScript）
│   ├── hook-common.ts           # フック共通機能
│   ├── pattern-matcher.ts       # パターンマッチング
│   ├── dangerous-commands.ts    # 危険なコマンドの検出
│   ├── decision-maker.ts        # 判定ロジック
│   ├── logging.ts               # ロギング機能
│   ├── notification-logging.ts  # 通知ログ機能
│   └── voicevox-audio.ts        # VoiceVox音声合成
├── utilities/                   # スタンドアロンツール
│   ├── generate-stats.ts        # 統計レポート生成
│   └── play-notification-sound.ts  # 通知音再生
├── types/                       # 型定義
│   ├── hooks-types.ts           # Hook型定義
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

1. **危険なコマンドの検出**
   - `git push -f`: 強制プッシュをブロック
   - `git commit --no-verify`: 検証スキップを手動レビュー
   - `git config` の書き込み操作: 手動レビュー
   - `rm -rf`: 強制削除をブロック
   - `.git` ディレクトリへの操作: 保護

2. **パターンマッチング**
   - GitIgnore形式のパターンサポート
   - 複合コマンド（&&, ||, ;）の個別検証
   - Allow/Denyリストによる柔軟な制御

3. **ログ記録**
   - 詳細な分析結果をログファイルに記録

#### アーキテクチャ

モジュール化されたTypeScript設計により、保守性と拡張性を向上：

- **hook-common.ts**: JSON入力の解析、設定ファイルの読み込み
- **pattern-matcher.ts**: コマンドとパターンのマッチング処理
- **dangerous-commands.ts**: 危険なコマンドパターンの定義と検出
- **decision-maker.ts**: 判定ロジック
- **logging.ts**: 分析結果のロギング

### 設定例

`.claude/settings.json`:
```json
{
  "permissions": {
    "allow": [
      "Bash(git:*)",
      "Bash(npm:*)",
      "Edit(src/**)",
      "Read(**)"
    ],
    "deny": [
      "Bash(rm:*)",
      "Edit(.git/**)"
    ]
  }
}
```

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

### play-notification-sound.ts
プラットフォーム別通知音再生（macOS, Linux, WSL対応）

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