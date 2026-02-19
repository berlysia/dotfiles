---
name: annotated-plan-workflow
description: "Execute document-first workflow (research -> plan -> annotation loop -> todo -> implementation) without relying on built-in Plan Mode."
context: inherit
---

# Annotated Plan Workflow

Plan Mode ではなく `.tmp/research.md` / `.tmp/plan.md` を中心に実装を進める。

## Trigger

- 3ステップ以上の作業、または設計判断を含む実装
- ユーザーが計画ドキュメント中心の進行を要求した場合
- 既存 `plan.md` があり、実装フェーズに入る場合

## Workflow

1. 深掘り調査を行い `.tmp/research.md` を作成する
2. 実装計画を `.tmp/plan.md` に作成する
3. ユーザー注釈を反映する反復を行う
4. 具体的 TODO を `plan.md` に追加する
5. 承認 + 自動レビュー pass を満たしてから実装する
6. タスク完了ごとに `plan.md` を更新する

## Hard Rules

- 計画承認前は実装しない
- 注釈反復中は必ず `don’t implement yet` を含める
- 進捗管理の単一真実源は `.tmp/plan.md` とする
- 小タスク（1-2ステップ、設計判断なし）には適用しない

## Approval Contract

`.tmp/plan.md` に以下を必須とする:

```markdown
## Approval
- Plan Status: drafting
- Review Status: pending
- Approval Status: pending
- Approved by: (human)
- Approved at:
```

実装開始は `Plan Status: complete` + `Review Status: pass` + `Approval Status: approved` かつ `<!-- auto-review: verdict=pass; hash=... -->` が最新計画に一致している状態になってから。

## Templates

テンプレートは `references/templates.md` を使う。
