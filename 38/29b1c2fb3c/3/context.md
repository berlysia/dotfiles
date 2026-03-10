# Session Context

## User Prompts

### Prompt 1

```
document-workflow-guard の plan hash 計算で、Approval Status 変更のたびにハッシュが不一致になる問題を修正して。

## 問題
plan.md の `Approval Status: pending` → `approved` に変更すると、auto-review マーカーのハッシュが不一致になり、実装がブロックされる。成功条件のチェックボックス更新でも同様。承認後の正当な編集のたびにハッシュ再計算が必要で煩雑。

## 関連コード
- `compute...

### Prompt 2

<bash-input>echo $DOCUMENT_WORKFLOW_DIR</bash-input>

### Prompt 3

<bash-stdout>.tmp/sessions/e2aab528</bash-stdout><bash-stderr></bash-stderr>

### Prompt 4

コミットして

