# add-skill

Manage Claude Code skills in chezmoi configuration

## 概要

`add-skill` は、`.chezmoidata/claude_skills.yaml` を操作してClaude Code skillsを宣言的に管理するCLIコマンドです。元の`npx add-skill`コマンドをラップし、YAML設定の追加・削除・一覧・検索機能を提供します。

## 使用方法

```bash
add-skill add <repo> <skill>     # スキル追加
add-skill remove <skill>         # スキル削除
add-skill list                   # 現在の設定表示
add-skill search <repo>          # リポジトリ内のスキル検索
add-skill install                # YAML設定からスキルをインストール
add-skill help                   # ヘルプ表示
```

## サブコマンド

### add - スキルを追加

```bash
add-skill add <repo> <skill>
```

指定されたリポジトリからスキルをYAML設定に追加します。

**引数:**
- `<repo>`: GitHubリポジトリ（例: `vercel-labs/agent-skills`）
- `<skill>`: スキル名（例: `web-design-guidelines`）

**例:**
```bash
add-skill add vercel-labs/agent-skills web-design-guidelines
```

### remove - スキルを削除

```bash
add-skill remove <skill>
```

指定されたスキルをYAML設定から削除します。

**引数:**
- `<skill>`: 削除するスキル名

**例:**
```bash
add-skill remove web-design-guidelines
```

### list - 現在の設定を表示

```bash
add-skill list
```

`.chezmoidata/claude_skills.yaml` に設定されている全スキルを表示します。

**出力例:**
```
📋 Current skills configuration:

[vercel-labs/agent-skills]
  vercel-react-best-practices
  web-design-guidelines
```

### search - リポジトリ内のスキルを検索

```bash
add-skill search <repo>
```

指定されたリポジトリで利用可能なスキルを検索します。内部的に`npx add-skill --list`に委譲します。

**引数:**
- `<repo>`: GitHubリポジトリ（例: `vercel-labs/agent-skills`）

**例:**
```bash
add-skill search vercel-labs/agent-skills
```

### install - YAML設定からスキルをインストール

```bash
add-skill install
```

`.chezmoidata/claude_skills.yaml` に記載されている全スキルを即座にインストールします。`chezmoi apply`を経由せずに明示的にインストールしたい場合に使用します。

**例:**
```bash
# YAML更新
add-skill add vercel-labs/agent-skills pdf

# 即座にインストール（chezmoi applyを待たずに）
add-skill install
```

**動作:**
- YAMLに記載された全リポジトリ・スキルを順次インストール
- 内部的に`pnpm dlx add-skill`を使用
- `--global --yes`フラグで自動確認

## オプション

- `--help`, `-h`, `help`: ヘルプメッセージを表示

## 動作フロー

1. **YAML読み込み**: `.chezmoidata/claude_skills.yaml` を読み込み
2. **YAML → JSON変換**: daselを使用してJSON形式に変換
3. **jq変換**: jqを使用してJSON操作（追加/削除）
4. **JSON → YAML変換**: daselを使用してYAML形式に変換
5. **差分表示**: 変更内容を確認
6. **アトミック置換**: 成功時のみファイルを更新

## 技術スタック

- **Bash**: スクリプト本体
- **dasel**: YAML ↔ JSON 変換（mise経由で実行）
- **jq**: JSON操作（配列追加/削除/重複除去）
- **npx add-skill**: search機能の委譲

## 依存関係

以下のツールが必要です：

- `mise`: daselの実行環境
- `jq`: JSON処理
- `chezmoi`: chezmoi設定の読み込み
- `dasel`: YAML/JSON変換（miseでインストール）

## 使用例

### スキルを追加してapply

```bash
# スキル追加
add-skill add vercel-labs/agent-skills web-design-guidelines

# 差分確認
git diff .chezmoidata/claude_skills.yaml

# chezmoi適用
chezmoi apply

# インストール確認
ls -la ~/.claude/skills/web-design-guidelines/
```

### 複数スキルの管理

```bash
# スキル追加
add-skill add vercel-labs/agent-skills react-hooks
add-skill add vercel-labs/agent-skills web-design-guidelines

# 一覧表示
add-skill list

# スキル削除
add-skill remove react-hooks
```

### 利用可能なスキルを検索

```bash
# リポジトリ内のスキルを検索
add-skill search vercel-labs/agent-skills
```

### YAMLを更新して即座にインストール

```bash
# スキル追加
add-skill add vercel-labs/agent-skills pdf

# chezmoi applyを待たずに即座にインストール
add-skill install

# インストール確認
ls -la ~/.claude/skills/pdf/
```

## 注意事項

### YAML更新後の適用

`add-skill add/remove` コマンドはYAML設定を更新するのみです。実際にスキルをインストール/削除するには以下のいずれかを実行します：

**方法1: chezmoi経由（推奨）**
```bash
add-skill add vercel-labs/agent-skills web-design-guidelines
chezmoi apply  # これで実際にインストールされる
```

**方法2: 即座にインストール**
```bash
add-skill add vercel-labs/agent-skills web-design-guidelines
add-skill install  # chezmoi applyを待たずに即座にインストール
```

### 冪等性

同じスキルを複数回追加しても、重複は自動的に排除されます。

### リポジトリエントリの自動削除

スキル削除時、リポジトリに残っているスキルがなくなった場合、リポジトリエントリも自動的に削除されます。

### 物理ファイルの削除

`remove`コマンドはYAMLから削除するのみです。`~/.claude/skills/`内の物理ファイルは手動で削除する必要があります：

```bash
rm -rf ~/.claude/skills/<skill-name>
```

## エラーハンドリング

### 依存関係チェック

コマンド実行時に必要なツールの存在を確認し、不足している場合はインストール手順を表示します。

### YAML妥当性検証

各操作前にYAMLの構文妥当性を確認し、エラーがある場合は即座に終了します。

### アトミック更新

一時ファイルで変換・変更を行い、成功時のみ元のファイルを置換することで、部分的な更新を防ぎます。

## 関連ファイル

- **YAML設定**: `.chezmoidata/claude_skills.yaml`
- **インストール先**: `~/.claude/skills/<skill-name>/`
- **インストールスクリプト**: `run_onchange_install-packages-7.sh.tmpl`

## 実装

スクリプトの場所: `~/.local/bin/add-skill`

ソースコード: `dot_local/bin/executable_add-skill`

実装計画: `docs/plans/add-skill-wrapper.md`

## 関連ドキュメント

- chezmoi公式ドキュメント: https://www.chezmoi.io/
- npx add-skill: GitHub repository with Claude Code skills
