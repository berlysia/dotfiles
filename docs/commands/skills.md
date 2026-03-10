# skills

Manage Claude Code external skills

## 概要

外部スキルは `home/.chezmoidata/claude_skills.yaml` で宣言的に管理し、`chezmoi apply` で自動インストール/削除される。スキルの検索・追加操作には [vercel-labs/skills](https://github.com/vercel-labs/skills) CLI を使用する。

## ワークフロー

### スキルを追加

```bash
# 1. YAML設定を手動編集、または以下で直接インストール
npx skills add vercel-labs/agent-skills --skill web-design-guidelines -g -y

# 2. claude_skills.yaml に追記（chezmoi apply で自動インストールするため）
# home/.chezmoidata/claude_skills.yaml を編集

# 3. chezmoi 適用
chezmoi apply
```

### スキルを削除

```bash
# 1. claude_skills.yaml から該当スキルを削除
# 2. chezmoi apply（自動で物理ファイルも削除される）
chezmoi apply
```

### スキルを検索

```bash
npx skills find <query>
npx skills add <repo> --list
```

### インストール済みスキルの確認

```bash
npx skills list -g
```

### スキルの更新確認

```bash
npx skills check
npx skills update
```

## 内部動作

`chezmoi apply` 時に `run_onchange_install-claude-skills-10.sh.tmpl` が実行される:

1. `claude_skills.yaml` のハッシュ変更を検知
2. 前回の `.external-skills-installed` と比較して削除対象を検出・削除
3. `pnpm dlx skills add <repo> --global --skill <names> --yes` でバッチインストール
4. 現在のスキル一覧を `.external-skills-installed` に保存

## 関連ファイル

- **YAML設定**: `home/.chezmoidata/claude_skills.yaml`
- **インストールスクリプト**: `home/.chezmoiscripts/run_onchange_install-claude-skills-10.sh.tmpl`
- **手作りスキル同期**: `home/.chezmoiscripts/run_after_sync-skills.sh.tmpl`
- **追跡ファイル**: `~/.claude/.external-skills-installed`
- **インストール先**: `~/.claude/skills/<skill-name>/`
