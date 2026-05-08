# ADR-0007: superpowers process discipline (Spec Self-Review + 一問一答)

## Status

proposed

## Context

ADR-0006 で Document Workflow を二層化 (spec.md + plan-N.md) する際、obra/superpowers の brainstorming スキルから盗む P0 規律を 3 件特定した:

1. **No Placeholders 禁則** — ADR-0006 と同 PR で採用済み (workflow.md / templates に記載)
2. **Spec Self-Review ゲート** — 本 ADR で扱う
3. **一問一答・多肢選択優先ルール** — 本 ADR で扱う

ADR-0006 ではファイル構造 (spec/plan 分離) とプレースホルダ禁則のみを採用し、プロセス規律 2 件 (Spec Self-Review / 一問一答) は責務軸が直交するため別 ADR として分離した。本 ADR は ADR-0006 デプロイ後の運用観察を経て accept/reject を判断する候補として **proposed** で起票する。

## Analysis

### Spec Self-Review ゲート

spec.md (または単層 plan.md) の `Plan Status: complete` 直前に、Claude が以下のインライン self-review を実施する:

- **placeholder scan**: "TBD" / "TODO" / 評価語のみの根拠 / 他タスク未定義の識別子参照を grep で検出
- **internal consistency**: 後段タスクの識別子と前段の定義が一致するか
- **scope check**: 単一の plan で完結するか、分解が必要か
- **ambiguity check**: 要件が二通りに解釈されないか

self-review pass を marker (`<!-- spec-self-review: passed; at=ISO8601 -->`) として spec.md 末尾に追記してから `Plan Status: complete` にする。

**目的**: 自動レビュアー (plan-review-automation) のサイクル消費を減らし、明らかな品質問題を spec 完成前に Claude 自身が解消する。superpowers の writing-plans Self-Review 節と対応。

### 一問一答・多肢選択優先ルール

`workflow.md` の「注釈反復」節に以下を追記:

- **一問一答**: 同一ラウンドで複数質問を出さない (依存質問の逐次化を一段強める)
- **多肢選択優先**: 自由回答よりも A/B/C 形式で提示できる場合は必ずそうする

**目的**: ユーザーの認知負荷を最小化し、注釈反復ラウンドの収束を速くする。superpowers の brainstorming スキル "One question at a time / Multiple choice preferred" に対応。

## Decision (proposed)

### 採用条件

ADR-0006 デプロイ後の最初の **5 セッションまたは 30 日**の二層モード運用で、以下の品質ギャップが **2 件以上**観測された場合に本 ADR を accepted に進める:

1. plan-review-automation の reviewer 指摘で「placeholder/曖昧語」が指摘された回数 (Spec Self-Review が機能していれば事前に解消されるはず)
2. brainstorming セッション 1 ラウンドあたりの質問数の中央値が 2 以上 (一問一答ルールが機能していれば 1 になるはず)
3. spec.md に対する self-review marker の有無 (運用習慣として定着していなければ marker が無い)

### 不採用条件

- ADR-0006 単独で品質が十分な水準に達していると判断された場合
- Spec Self-Review が plan-review-automation の自動レビューと役割重複する場合
- 一問一答ルールがユーザー側のフリクションを増やすと判断された場合

## Rejected alternatives

- **ADR-0006 と同 PR で同梱**: ファイル構造変更 (二層化) とプロセス規律の責務軸が直交するため、独立に accept/reject 可能。同梱は scope creep と判断
- **No Placeholders 禁則と統合**: No Placeholders は spec.md / plan-N.md テンプレートへの記述で完結する静的ルール。Spec Self-Review は動的な実行ステップで責務粒度が異なる
- **無採用 (放置)**: ADR-0006 デプロイ後の観察結果次第。観察指標を満たさなければ本 ADR は close する

## Consequences (potential)

- workflow.md の「注釈反復」節に質問規律 2 件を追加
- spec.md / plan.md テンプレートに Self-Review チェックリストを追加
- plan-review-automation hook が `<!-- spec-self-review: passed; at=... -->` marker の有無を検証 (オプション)

## Open observation items

ADR-0006 デプロイ後 5 セッション or 30 日の運用ログを以下の指標で記録する:

- placeholder/曖昧語の reviewer 指摘回数 (spec.md / plan.md / plan-N.md 別)
- brainstorming 1 ラウンドあたりの質問数 (中央値・最頻値)
- spec self-review marker の有無 (本 ADR は未デプロイなので、有 = ユーザーが手動運用、無 = 想定通り)

## References

- ADR-0006 (`docs/decisions/0006-document-workflow-two-layer.md`): 本 ADR の起源
- obra/superpowers (`https://github.com/obra/superpowers`):
  - `skills/brainstorming/SKILL.md` (Spec Self-Review 節 / Key Principles "One question at a time")
  - `skills/writing-plans/SKILL.md` (Self-Review 節)
- 関連 rules (本 ADR が accepted になった場合に編集対象):
  - `home/dot_claude/rules/workflow.md` (Document Workflow Protocol > 注釈反復)
  - `home/dot_claude/templates/spec.md` (Self-Review チェックリスト追加)
  - `home/dot_claude/templates/plan-execution.md` (Self-Review チェックリスト追加)
