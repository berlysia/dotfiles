# ADR-0007: superpowers process discipline (Spec Self-Review + 一問一答)

## Status

proposed

ADR-0006 デプロイ後の運用観察を経て accept/reject を判断する候補として起票した。採否の判定は持ち越した課題の一覧（adr-followups）にある。

## Context

ADR-0006 で Document Workflow を二層化 (spec.md + plan-N.md) する際、obra/superpowers の brainstorming スキルから盗む P0 規律を 3 件特定した:

1. **No Placeholders 禁則** — ADR-0006 と同時に採用済み
2. **Spec Self-Review ゲート** — 本 ADR で扱う
3. **一問一答・多肢選択優先ルール** — 本 ADR で扱う

ADR-0006 ではファイル構造 (spec/plan 分離) とプレースホルダ禁則のみを採用した。プロセス規律の 2 件 (Spec Self-Review / 一問一答) は責務軸が直交するため、別 ADR として分離した。

## Decision

**proposed**。次の 2 規律を、採用条件を満たしたときに accepted へ進める。

- **Spec Self-Review ゲート**: spec.md (または単層 plan.md) を `Plan Status: complete` にする直前に、Claude が placeholder scan / 内部整合 / scope / 曖昧さの 4 点を自分で確認し、通過を marker として spec.md に残す。自動レビュアー (plan-review-automation) のサイクル消費を減らし、明らかな品質問題を spec 完成前に解消するのが目的
- **一問一答・多肢選択優先ルール**: `workflow.md` の注釈反復で、同一ラウンドに複数質問を出さず、A/B/C 形式で出せるときはそうする。ユーザーの認知負荷を下げ、注釈反復の収束を速めるのが目的

### 採用条件

ADR-0006 デプロイ後の最初の **5 セッションまたは 30 日**の二層モード運用で、以下の品質ギャップが **2 件以上**観測された場合に accepted に進める:

1. plan-review-automation の reviewer 指摘で「placeholder/曖昧語」が指摘された回数 (Spec Self-Review が機能していれば事前に解消されるはず)
2. brainstorming セッション 1 ラウンドあたりの質問数の中央値が 2 以上 (一問一答ルールが機能していれば 1 になるはず)
3. spec.md に対する self-review marker の有無 (運用習慣として定着していなければ marker が無い)

### 不採用条件

- ADR-0006 単独で品質が十分な水準に達していると判断された場合
- Spec Self-Review が plan-review-automation の自動レビューと役割重複する場合
- 一問一答ルールがユーザー側のフリクションを増やすと判断された場合

## 却下した代替案

- **ADR-0006 と同時に同梱**: ファイル構造変更 (二層化) とプロセス規律の責務軸が直交するため、独立に accept/reject 可能。同梱は scope creep と判断
- **No Placeholders 禁則と統合**: No Placeholders は spec.md / plan-N.md テンプレートへの記述で完結する静的ルール。Spec Self-Review は動的な実行ステップで責務粒度が異なる
- **無採用 (放置)**: 観察結果次第。採用条件を満たさなければ本 ADR は close する

## Consequences

- accepted になった場合、`workflow.md` の注釈反復に質問規律 2 件が入り、spec.md / plan.md のテンプレートに Self-Review のチェックリストが入る
- plan-review-automation hook が self-review marker の有無を検証する形も取れる (オプション)

## References

- ADR-0006: 本 ADR の起源
- obra/superpowers (`https://github.com/obra/superpowers`): brainstorming スキルの Spec Self-Review 節と "One question at a time"、writing-plans スキルの Self-Review 節
