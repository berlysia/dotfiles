# Dotfiles Project - Development Context

**Note:** This project inherits global development guidelines from `~/.claude/CLAUDE.md`. This file contains dotfiles-specific context only.

## Project Overview

This is a chezmoi-managed dotfiles repository for daily maintenance.

### Document Workflow 方針

- 中規模以上の作業（3ステップ以上、または設計判断を伴う変更）は、Plan Mode より **Document Workflow** を優先する
- セッション開始時に `DOCUMENT_WORKFLOW_DIR` 環境変数が設定される（例: `.tmp/sessions/abcd1234/`）。未設定時は `.tmp/` にフォールバック
- 実装前に `$DOCUMENT_WORKFLOW_DIR/research.md` と `$DOCUMENT_WORKFLOW_DIR/plan.md` を作成し、`Plan Status: complete` + `Review Status: pass` + `Approval Status: approved` と `auto-review: verdict=pass` を満たしてから実装する
- `plan.md` 更新時は `plan-review-automation` hook が自動で `logic-validator` + 設計系レビューを実行し、同ディレクトリに `plan-review.md` / `plan-review.json` を生成する
- 実装系書き込みは `document-workflow-guard` hook で制御し、導入初期は `DOCUMENT_WORKFLOW_WARN_ONLY=1` で観測する
- 複数セッションが並行してワークフローを実行可能（セッションIDでディレクトリ分離）

### Chezmoi ファイル管理

#### 一般的なルール
- **ファイル名変換**: `dot_*` → `.*` (例: `${projectRoot}/home/dot_claude/foo.txt` → `~/.claude/foo.txt`)
- **パーミッション**: `private_*` → パーミッション600で配置
- **テンプレート**: `.tmpl` 拡張子で動的生成

#### ディレクトリ構造
- **`.chezmoiroot`**: リポジトリルートの `.chezmoiroot` ファイルに `home` と記載
  - chezmoi source stateは `${projectRoot}/home/` 配下に格納
  - `.chezmoi.sourceDir` → `${projectRoot}/home/`
  - `.chezmoi.workingTree` → `${projectRoot}/`（リポジトリルート、不変）
  - リポジトリルートにあるファイル（`package.json`等）を参照するテンプレートでは `workingTree` を使用

#### このプロジェクト独自のルール
- **グローバル設定**: `${projectRoot}/home/dot_claude/CLAUDE.md` → `~/.claude/CLAUDE.md`
  - スクリプトは `includeTemplate` で内容を読み込み、ハッシュ値で変更検知
  - 編集する場合は `${projectRoot}/home/dot_claude/CLAUDE.md` を変更してから `chezmoi apply` を実行

- **Settings.json分割管理**: `~/.claude/settings.json`は複数ファイルに分割して管理
  - `.settings.base.json`: 基本設定（model、language、statusLine、alwaysThinkingEnabled等）
  - `.settings.permissions.json`: パーミッション設定（allow/deny）
  - `.settings.hooks.json.tmpl`: Hooks設定（chezmoi変数で動的生成）
  - これらは`run_onchange_update-settings-json.sh.tmpl`でjq統合され、`chezmoi apply`時に自動更新
  - **重要**: hooks設定を変更する場合は`.settings.hooks.json.tmpl`を編集してから`chezmoi apply`を実行
  - `enabledPlugins`は`claude plugin` CLIが管理し、既存値はsettings.json更新時に保持される

- **~/.claude.json自動管理**: MCPサーバー設定を`package.json`のバージョンから自動生成
  - `run_onchange_update-claude-json.sh.tmpl`が`package.json`の`dependencies`からバージョンを読み取る
  - テンプレート内容と既存の`~/.claude.json`をjqでマージ（mcpServers, preferredNotifChannel, defaultModeを更新）
  - 変更前に自動バックアップ、変更内容の差分表示
  - **管理対象MCPサーバー**: @mizchi/readability, chrome-devtools-mcp, @playwright/mcp, @upstash/context7-mcp, @openai/codex
  - **バージョン更新方法**: `package.json`のdependenciesを編集してから`chezmoi apply`を実行

- **プラグイン管理**: `home/.chezmoidata/claude_plugins.yaml`で宣言的に管理、`chezmoi apply`時に自動インストール
  - `run_onchange_install-claude-plugins-8.sh.tmpl`が`claude plugin` CLIでマーケットプレイス登録・プラグインインストール・削除を実行
  - `.claude/.managed-plugins-installed`でインストール済みプラグインを追跡
  - YAMLから削除されたプラグインは自動アンインストール
  - **監査ツール**: `~/.claude/scripts/show-missing-plugins.sh`で宣言状態と実際の状態を比較
  - **逆同期**: `~/.claude/scripts/sync-enabled-plugins.sh`でインストール済みプラグインからYAMLスニペットを生成

### Claude Code Skills Management

このプロジェクトは`add-skill`を使用して、Gitリポジトリから選択的にClaude Codeスキルをインストールします。

#### スキル管理の仕組み

- **手作りスキル**: `${projectRoot}/.skills/` で一元管理
  - Claude Code と Codex の両方で使用するスキルを統合
  - `run_after_sync-skills.sh.tmpl` が `chezmoi apply` 時に自動的に `~/.claude/skills/` と `~/.codex/skills/` に同期
  - rsyncで完全同期され、常に最新の状態を維持

- **外部スキル**: `home/.chezmoidata/claude_skills.yaml` で宣言的に管理し、`add-skill` 経由でインストール
  - `run_onchange_install-claude-skills-9.sh.tmpl`がインストール・削除を実行
  - `.claude/.external-skills-installed`でインストール済みスキルを追跡
  - yamlから削除されたスキルを自動削除（手作りスキルは保護される）
  - リポジトリごとにバッチインストール（効率化）

- **共存**: 手作りスキルと外部スキルが両方のディレクトリに展開され、共存

#### スキルの追加方法

1. 利用可能なスキルを確認:
   ```bash
   add-skill search <repository>
   ```

2. `home/.chezmoidata/claude_skills.yaml` を編集:
   ```yaml
   claude_skills:
     repositories:
       - repo: "vercel-labs/agent-skills"
         skills:
           - "web-design-guidelines"
       - repo: "owner/custom-skills"
         skills:
           - "skill-name"
   ```

3. chezmoi apply で自動インストール:
   ```bash
   chezmoi apply
   ```

#### スキルの削除方法

1. `home/.chezmoidata/claude_skills.yaml` から該当スキルを削除
2. `chezmoi apply` を実行
   ```bash
   chezmoi apply
   ```

**自動削除**: yamlから削除されたスキルは、次回の `chezmoi apply` 実行時に自動的に `~/.claude/skills/` から削除されます。削除されたスキルがある場合は、削除ログが表示されます。

**安全性**: 削除対象は `.claude/.external-skills-installed` に記録されたスキル（このスクリプトでインストールしたもの）のみです。手作りスキルは誤削除されません。

#### トラブルシューティング

**pnpm not found**:
- miseでnodeがインストールされているか確認: `mise list`
- `run_onchange_install-packages-7.sh.tmpl` が実行されているか確認

**add-skill でエラーが発生する場合**:
- package.json の add-skill バージョンを確認: `jq '.dependencies["add-skill"]' package.json`
- pnpm が正しくインストールされているか確認: `mise list`

**スキルのインストール失敗**:
- リポジトリが存在するか確認: `gh api repos/<owner>/<repo>`
- スキル名が正しいか確認: `add-skill search <repo>`
- ネットワーク接続を確認

**冪等性の確認**:
- 2回目の `chezmoi apply` でスキルが再インストールされないことを確認
- ハッシュ値が変更されない限り、スクリプトは再実行されません

### Hooks Development

#### フックの依存パッケージ

フック（`~/.claude/hooks/`）は bun で絶対パス実行される（`bun ~/.claude/hooks/implementations/*.ts`）。
bun はスクリプト位置から `node_modules` を上方探索するため、`~/.claude/node_modules/` に依存パッケージが必要。

**パッケージ管理構造**:
- **hook依存の定義**: `home/dot_claude/package.json`（pnpm workspace パッケージ）
- **開発時**: `pnpm install` で `home/dot_claude/node_modules/` にインストール
- **deploy後**: `chezmoi apply` → install script が `~/.claude/` で `bun install` を実行

**依存パッケージの追加方法**:
1. `home/dot_claude/package.json` の `dependencies` に追加
2. `pnpm install` で lockfile を更新
3. `chezmoi apply` で deploy（自動的に `~/.claude/node_modules/` にインストールされる）

**主要な依存パッケージ**:
- `cc-hooks-ts`: フック定義ヘルパー
- `@anthropic-ai/claude-agent-sdk`: LLM評価用（Claude Codeライセンスで認証）
