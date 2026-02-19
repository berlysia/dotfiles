# Session Context

## User Prompts

### Prompt 1

直近追加されている自動レビューの仕組みがうまくうごいてないっぽい。レポートをもらったので渡す

## plan-review-automation hook の不具合レポート

### 動作確認

- **トリガー**: `.tmp/plan.md` への `Edit` で正常に発火する
- **成果物生成**: `.tmp/plan-review.md`, `.tmp/plan-review.json`, `.tmp/plan-review.cache.json` が生成される
- **plan.md への埋め込み**: `Review Status` と `<!-- auto-review: verdict=...; hash=...

### Prompt 2

commit apply push

