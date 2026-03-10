# Dotfiles Project - Development Context

**Note:** This project inherits global development guidelines from `~/.claude/CLAUDE.md`. This file contains dotfiles-specific context only.

## Project Overview

This is a chezmoi-managed dotfiles repository for daily maintenance.

### Document Workflow 方針

- このプロジェクトでは Plan Mode より **Document Workflow** を優先する（`@~/.claude/rules/workflow.md` 参照）
- 複数セッション並行可能（`DOCUMENT_WORKFLOW_DIR` でディレクトリ分離）

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
  - 編集する場合は `${projectRoot}/home/dot_claude/CLAUDE.md` を変更してから `chezmoi apply` を実行

- **Settings.json分割管理**: `.settings.base.json`, `.settings.permissions.json`, `.settings.hooks.json.tmpl`, `.settings.plugins.json` → `run_onchange_update-settings-json.sh.tmpl` で jq 統合
  - **重要**: hooks変更は `.settings.hooks.json.tmpl` を編集 → `chezmoi apply`
  - `enabledPlugins` は `claude plugin` CLI が管理、settings.json 更新時に保持

- **~/.claude.json自動管理**: `package.json` の dependencies からバージョン読み取り → jq マージ
  - **管理対象MCP**: @mizchi/readability, chrome-devtools-mcp, @playwright/mcp, @upstash/context7-mcp, @openai/codex, @drawio/mcp

- **プラグイン管理**: `home/.chezmoidata/claude_plugins.yaml` で宣言管理 → `chezmoi apply` で自動インストール/削除

### Claude Code Skills Management

- **手作りスキル**: `${projectRoot}/.skills/` で一元管理、`chezmoi apply` で `~/.claude/skills/` と `~/.codex/skills/` に rsync 同期
- **外部スキル**: `home/.chezmoidata/claude_skills.yaml` で宣言的管理、`npx skills add` 経由でインストール
  - `.claude/.external-skills-installed` で追跡、yaml から削除したスキルは自動削除（手作りスキルは保護）

#### 変更手順

1. `home/.chezmoidata/claude_skills.yaml` を編集（追加/削除）
2. `chezmoi apply` を実行
3. スキル検索: `npx skills find <query>`

### Hooks Development

フック（`~/.claude/hooks/`）は bun で絶対パス実行（`bun ~/.claude/hooks/implementations/*.ts`）。

**パッケージ管理**:

- **hook依存の定義**: `home/dot_claude/package.json`（pnpm workspace パッケージ）
- **開発時**: `pnpm install` → `home/dot_claude/node_modules/`
- **deploy後**: `chezmoi apply` → `~/.claude/` で `bun install`

**依存パッケージ追加**: `home/dot_claude/package.json` に追加 → `pnpm install` → `chezmoi apply`

**主要パッケージ**: `cc-hooks-ts`（フック定義ヘルパー）, `@anthropic-ai/claude-agent-sdk`（LLM評価用）
