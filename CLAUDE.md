# Dotfiles Project - Development Context

## Development Guidelines

### Language
- Japanese for discussion, English for code

## Project Overview

This is a chezmoi-managed dotfiles repository for daily maintenance.

### Chezmoi ファイル管理

#### 一般的なルール
- **ファイル名変換**: `dot_*` → `.*` (例: `${projectRoot}/dot_claude/foo.txt` → `~/.claude/foo.txt`)
- **パーミッション**: `private_*` → パーミッション600で配置
- **テンプレート**: `.tmpl` 拡張子で動的生成

#### このプロジェクト独自のルール
- **グローバル設定**: `${projectRoot}/dot_claude/.CLAUDE.md` → `~/.claude/CLAUDE.md`
  - 一般ルールでは `~/.claude/.CLAUDE.md` になるはずだが、`run_update-CLAUDE-md.sh` スクリプトが `.` を除去して配置
  - スクリプトは `includeTemplate` で内容を読み込み、ハッシュ値で変更検知
  - 編集する場合は `${projectRoot}/dot_claude/.CLAUDE.md` を変更してから `chezmoi apply` を実行

### Claude Code Skills Management

このプロジェクトは`add-skill`を使用して、Gitリポジトリから選択的にClaude Codeスキルをインストールします。

#### スキル管理の仕組み

- **手作りスキル**: `${projectRoot}/dot_claude/skills/` で直接管理（semantic-commit, react-hooks, codex-review）
- **外部スキル**: `.chezmoidata/claude_skills.yaml` で宣言的に管理し、`add-skill` 経由でインストール
- **インストール先**: 両方とも `~/.claude/skills/` に展開され、共存

#### スキルの追加方法

1. 利用可能なスキルを確認:
   ```bash
   npx add-skill <repository> --list
   ```

2. `.chezmoidata/claude_skills.yaml` を編集:
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

1. `.chezmoidata/claude_skills.yaml` から該当スキルを削除
2. `chezmoi apply` を実行
   ```bash
   chezmoi apply
   ```

**自動削除**: yamlから削除されたスキルは、次回の `chezmoi apply` 実行時に自動的に `~/.claude/skills/` から削除されます。削除されたスキルがある場合は、削除ログが表示されます。

**安全性**: 削除対象は `.claude/.external-skills-installed` に記録されたスキル（このスクリプトでインストールしたもの）のみです。手作りスキルは誤削除されません。

#### トラブルシューティング

**npx not found**:
- miseでnodeがインストールされているか確認: `mise list`
- `run_onchange_install-packages-7.sh.tmpl` が実行されているか確認

**スキルのインストール失敗**:
- リポジトリが存在するか確認: `gh api repos/<owner>/<repo>`
- スキル名が正しいか確認: `npx add-skill <repo> --list`
- ネットワーク接続を確認

**冪等性の確認**:
- 2回目の `chezmoi apply` でスキルが再インストールされないことを確認
- ハッシュ値が変更されない限り、スクリプトは再実行されません

## Testing Tool
常に node:test, node:assert を好みます。Bunの組み込みメソッドの利用は禁じられます。
テストの実行時は node --test ${testfile} で実行します。
