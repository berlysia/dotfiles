# Spec: <feature/change name>

> **Template usage**: 二層モード (spec.md + plan-N.md) の設計層テンプレート。承認後に plan-1.md / plan-2.md ... を切り出す。
> 単層モード (plan.md のみ) を選択した場合は本テンプレートは使わず、`plan.md` 内に軽量 spec セクション (Goal / Greenfield View / Decisions) を短文で内包する。

## Goal

<このオーダーが達成したいことを 1-2 行で>

## Experience Delta

<変更前の体験 → 変更後の体験。具体的な違いを 2-3 行で>

## Architecture

<採用する設計の構造概要。図やコンポーネント関係を含む>

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

<既存コードに最小限の手を入れた場合の方針>

### 白紙設計案 (Greenfield)

<このオーダーをゼロから設計するならどう実現するか。「ゼロから設計したらこの選択になった理由」(origin) を含む>

### 採用案と理由

<どちらを採用するか、または両者のハイブリッドか。具体的根拠（既存テスト・外部契約・計測コスト等）に基づく選択理由>

## Key Decisions

- **K1: <決定の名前>** — <決定内容と根拠>
- **K2: <決定の名前>** — <決定内容と根拠>
- ...

## Risks

- **R1**: <リスク内容> → <対処>
- **R2**: <リスク内容> → <対処>
- ...

## ISO 25010 次元選択

<本変更で関連する品質特性を選択。具体的なテストケースは plan-N.md に記載>

- **<選択した品質特性>**: <なぜこの特性が関連するか>
- **対象外**: <検討したが除外した特性と理由>

## Approval

- Plan Status: draft
- Review Status: pending
- Approval Status: pending

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

---

<!--
No Placeholders 禁則（spec.md / plan-N.md / 単層 plan.md 共通）

以下を本テンプレート内に残してはならない（実装フェーズ前に全て解消する）:
- "TBD" / "TODO" / "後で実装" / "fill in details"
- "適切にエラー処理" / "バリデーションを追加" / "エッジケース対応"
- "上記と同様" / "Task N と類似"
- 他タスクで未定義の型・関数・メソッドへの参照
- 評価語のみの根拠（"シンプル" / "安全" / "リスクが低い" のみで具体的根拠なし）

判定基準に曖昧語を使わない（「正しく」「適切に」「問題なく」→ 具体的な期待値・状態で記述）。
-->
