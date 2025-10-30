# Dotfiles Project - Development Context

## Development Guidelines

### Language
- Japanese for discussion, English for code

## Current Active Project
**Completed**: TypeScript conversion project is finished. See CURRENT_WORK.md for details.

現在は特定のアクティブプロジェクトはありません。日常的なdotfilesメンテナンスが行われています。

## Project Structure Context
このプロジェクトはchezmoi管理のdotfiles設定です。

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

## Testing Tool
常に node:test, node:assert を好みます。Bunの組み込みメソッドの利用は禁じられます。
テストの実行時は node --test ${testfile} で実行します。
