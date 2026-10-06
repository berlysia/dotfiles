# Spec: <feature/change name>

> **Template usage**: 二層モードの設計層。承認後に plan-1.md … を切り出す。単層モードでは使わず、plan.md に Goal / Greenfield View / Decisions を短く書く。

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

各 Key Decision には **コード参照行** (`参照: <file>:<lines>`) を最低 1 つ含めること (P1)。引用無しは「想像で書いた」と明示扱いとなり、auto-review で reviewer が優先検証する。

- **K1: <決定の名前>** — <決定内容と根拠>
  - 参照: `path/to/file.ts:LINE-LINE` (関数 / API シグネチャの実コード参照)
  - 参照: `path/to/lib/foo.ts:LINE` (再利用する既存関数の根拠)
- **K2: <決定の名前>** — <決定内容と根拠>
  - 参照: `path/to/other.ts:LINE-LINE`
- ...

## Scope

このセクションは **任意**。plan-N.md の承認を委任したいときだけ書く。書かなければ、plan-N.md は 1 つずつ承認する。

plan-N.md が書き込んでよい範囲を、コードブロックに 1 行 1 パス（プロジェクトルート相対）で書く。末尾が `/` の行は dir、それ以外はファイルを表す。行の制限と、書いても委任されないパスは、`document-workflow-reference` skill の「委任」にある。下の例の行は、書き換えるまで無効である。

```
<dir>/
<path/to/file>
```

## Risks

- **R1**: <リスク内容> → <対処>
- **R2**: <リスク内容> → <対処>
- ...

## Phase 1 で意図的に提供しない体験 (任意)

このセクションは **任意**。項目を足す前に「この機能は本当に提供しないのが正しいか、実コード上で代替経路の有無を確認したか」を P9 self-audit で必ず確認する (P13)。フォーマット未準拠の項目は reviewer agent が divergent 指摘 (intent-triage で除外候補) として扱う。

### 例: <非提供項目名>

- **代替経路確認**: `path/to/parser.ts:LINE` (代替手段の実コード位置 / シグネチャ)
- **非提供対象**: <UI 専用機能 / 一括処理 / 等、提供しない範囲を限定>
- **将来の予定**: <Phase 2 以降で提供するか、恒久的に非提供か>

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
