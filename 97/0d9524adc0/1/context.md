# Session Context

## User Prompts

### Prompt 1

Implement the following plan:

# Plan: Claude Code Plugin Management YAML Migration

## Context

現在のプラグイン管理は `.settings.plugins.json`（空オブジェクト `{}`）+ `show-missing-plugins.sh`（手動コマンド表示）という半手動の仕組み。
`claude plugin` CLIサブコマンドが `--json` 出力対応で利用可能であることが判明したため、`claude_skills.yaml` と同様のYAML宣言的管理に移行し、`chezmoi apply` 時に自動インス�...

### Prompt 2

コミットしてプッシュ

