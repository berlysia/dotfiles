# Session Context

## User Prompts

### Prompt 1

Implement the following plan:

# 計画: 外部通知の共通化 + Slack通知追加

## Context

Discord通知hookに蓄積されたイベント処理ロジック（Stop/PermissionRequest/Notification分岐、
transcript抽出、permission_prompt重複排除、footer構築）をプラットフォーム中立な共通モジュールに
抽出し、Discord/Slackを薄いアダプターとして実装する。

**動機**: Slack通知を追加したいが、イベント処理ロジックをコピ...

### Prompt 2

コミットして

