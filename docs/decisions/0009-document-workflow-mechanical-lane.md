# ADR-0009: Document Workflow mechanical-lane（ADR 抵触する小規模・機械的変更の軽量レーン）

## Status

accepted

## Context

ADR-0006 は routing 表の ceremony 量代理指標を「設計判断の本数（単一/複数）」に置いた。しかし ADR-0006 自身が Analysis/Rejected (`0006:33,111,128`) で「6+ ステップだが単一判断（機械的書き換え等）が AND 条件だと過剰 ceremony 化する」と自認していた。Accepted ADR を機械的に覆す決定論的変更（例: 21 git mv + 参照追従 + 新規 ADR1本）が routing 表「複数判断」に該当し spec+plan-N 二層へ強制され、最大12レビュアー起動 / 人間承認2ゲート / プロトコル自己誘発の再発火を招く。

## Analysis

検討案:

- **Option A**（文書のみ最小、routing row のみ、hash 機構不変）= 摩擦B（プロトコル自己誘発の再発火）が残り routing 改善が相殺されるため、本義（手続きコスト削減）を部分的にしか達成しない
- **Option B**（軽量レーン + hash 不変条件の単一定義化）【採用】
- **Option C**（専用レビュアー集合で greenfield/decision-quality を drop）= ユーザー禁則「安全機構の一方的弱体化」に抵触し reject

ceremony 代理指標を「判断数」から **「design-in-motion の機械的証明」（設計セクションの section-scoped hash が前回人間承認時から不変か）** へ移す。これは ADR-0006 の自認した既存欠陥の構造的修正であり、新規抽象レイヤの導入ではない。

**Status を accepted とする理由**: 本 ADR は plan-2（routing）+ plan-1（S3 hash 機構 / S2 prescribed-fix）で実装される決定の記録であり、deferred 案の構造記録（ADR-0008 = proposed）とは性質が異なる。実装と同時に有効化される accepted 決定として扱う（ADR-0005/0006 と同様）。

## Decision

### mechanical-lane criteria（4 条件 AND）

ADR-0006 routing 表に mechanical-lane row を**追加**（既存 row は廃止しない）。4 条件すべて AND 成立時のみ plan.md-only 単層へ routing:

- (i) 全設計判断が「ユーザー明示確定済の既存 ADR 特定条項の改訂」、net-new 設計空間ゼロ
- (ii) 残差が決定論的変換（rename/move/文字列置換）、新規 control flow/data model/API shape 非導入
- (iii) 既存テスト + typecheck が当該変換を被覆（`bun run test` / `bun run typecheck`）
- (iv) 新規 ADR 自体を設計記録とする（複数判断 → 1 ADR 起草判断に collapse）

1 条件でも非該当なら二層 row へ自動 fallback。判定根拠を plan.md に明記必須。

### ADR-0006 との関係（K6）

**Amends ADR-0006 routing criteria（supersede しない / not supersede）**。ADR-0006 の「複数判断 → spec+plan-N」row は廃止せず、より特定的な mechanical-lane row を優先評価で追加。ADR-0006 は accepted のまま。**ADR-0005 は無改訂**（`SPEC_REVIEWERS` / `PLAN_REVIEWERS` レビュアー定数は不変・immutable、drift 機構は無風）。

### guard 観測不能の明示トレードオフ（R1）

レーン分類は人間/Claude の routing 表参照で決まり hook には観測されない（ADR-0006 K1 境界維持）。複雑な ADR 反転の mechanical 誤分類に対する guard 側バックストップは無く、緩和は criteria 4条件 AND + 判定根拠明記のみ。既存 routing 表と同一信頼モデルとして受容する明示的トレードオフ。

## Rejected alternatives

- **Option A（文書のみ最小、S3 なし）**: 摩擦B（プロトコル自己誘発再発火）が残り routing 改善が相殺され本義を部分的にしか達成しない。
- **Option C（専用レビュアー集合）**: ADR reversal から decision-quality / greenfield 精査を外すのはユーザー禁則「安全機構の一方的弱体化」抵触。hook モード自動判定は ADR-0006 K1 で既に rejected。
- **ADR-0006 を supersede**: routing 表全体の置換は不要。特定 row 追加で足り、既存二層判定を保全すべき。

## Consequences

- **Positive**: 機械判定 criteria 合致時に最大12→7 レビュアー / 承認2→1 ゲート / 構造的再発火 ≥1→0（plan-1 S3 と併せて）。ADR-0006 の自認欠陥が構造的に修正される。
- **Negative**: 「mechanical-lane 機械判定」という新分類面が増え、誤判定リスクを criteria 厳格化で抑える必要。guard 側バックストップ非対称が残る（明示トレードオフ）。

## References

- ADR-0006 (`docs/decisions/0006-document-workflow-two-layer.md`): 本 ADR が amend する二層化決定
- ADR-0005 (`docs/decisions/0005-always-on-reviewers-ssot.md`): レビュアー SSoT（本 ADR で無改訂）
- ADR-0008 (`docs/decisions/0008-document-workflow-feedback.md`): sibling follow-up ADR の構造先例
- spec: `.tmp/sessions/63b75201/spec.md`（Option B / K1 / K6 / R1）
- research: `.tmp/sessions/63b75201/research.md` §4（amend vs supersede）/ §6（criteria）
- 連動実装: plan-1（S3 hash 機構 + S2 prescribed-fix）/ plan-2（S1 routing、本 ADR）
