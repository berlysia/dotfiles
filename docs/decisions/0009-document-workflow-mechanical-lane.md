# ADR-0009: Document Workflow mechanical-lane（ADR 抵触する小規模・機械的変更の軽量レーン）

## Status

accepted

Amends ADR-0006 の routing criteria。ADR-0006 を supersede しない。

## Context

ADR-0006 は routing 表の ceremony 量の代理指標を、設計判断の本数（単一か複数か）に置いた。しかし ADR-0006 自身が、「6+ ステップだが単一判断（機械的書き換え等）が AND 条件だと過剰 ceremony 化する」と自認していた。Accepted ADR を機械的に覆す決定論的変更（例: 21 git mv + 参照追従 + 新規 ADR 1 本）が routing 表の「複数判断」に該当し、spec+plan-N の二層へ強制される。その結果、最大 12 レビュアーの起動、人間承認 2 ゲート、プロトコル自己誘発の再発火を招く。

## Decision

ceremony の代理指標を判断の数から **「design-in-motion の機械的証明」（設計セクションの section-scoped hash が前回の人間承認時から不変か）** へ移す。これは ADR-0006 の自認した既存欠陥の構造的修正であり、新規抽象レイヤの導入ではない。軽量レーンと、hash 不変条件の単一定義化を組み合わせる（Option B）。

### mechanical-lane criteria（4 条件 AND）

ADR-0006 routing 表に mechanical-lane row を**追加**する（既存 row は廃止しない）。4 条件すべてが AND で成立したときだけ plan.md-only の単層へ routing する:

- (i) 全設計判断が「ユーザー明示確定済の既存 ADR 特定条項の改訂」で、net-new 設計空間ゼロ
- (ii) 残差が決定論的変換（rename/move/文字列置換）で、新規 control flow/data model/API shape を導入しない
- (iii) 既存テスト + typecheck が当該変換を被覆する（`bun run test` / `bun run typecheck`）
- (iv) 新規 ADR 自体を設計記録とする（複数判断 → 1 ADR 起草判断に collapse）

1 条件でも非該当なら二層 row へ自動で戻る。判定根拠を plan.md に明記する。

### K6: 二層化の決定（ADR-0006）との関係

**Amends ADR-0006 routing criteria（supersede しない / not supersede）**。ADR-0006 の「複数判断 → spec+plan-N」row は廃止せず、より特定的な mechanical-lane row を優先評価で追加する。ADR-0006 は accepted のまま。**ADR-0005 は無改訂**（`SPEC_REVIEWERS` / `PLAN_REVIEWERS` レビュアー定数は不変・immutable、drift 機構は無風）。

### guard 観測不能の明示トレードオフ（R1）

レーン分類は人間/Claude の routing 表参照で決まり hook には観測されない（ADR-0006 の K1 の境界を維持する）。複雑な ADR 反転の mechanical 誤分類に対する guard 側バックストップは無く、緩和は criteria 4 条件 AND + 判定根拠の明記のみ。既存 routing 表と同一信頼モデルとして受容する明示的トレードオフ。

## 却下した代替案

- **Option A（文書のみ最小、routing row のみ、hash 機構不変）**: 摩擦B（プロトコル自己誘発の再発火）が残り routing 改善が相殺され、本義（手続きコスト削減）を部分的にしか達成しない。
- **Option C（専用レビュアー集合で greenfield/decision-quality を drop）**: ADR reversal から decision-quality / greenfield 精査を外すのは、ユーザー禁則「安全機構の一方的弱体化」に抵触する。hook によるモード自動判定は ADR-0006 の K1 で既に rejected。
- **ADR-0006 を supersede**: routing 表全体の置換は不要。特定 row の追加で足り、既存の二層判定を保全すべき。

## Consequences

- **Positive**: 機械判定 criteria に合致するとき、最大 12→7 レビュアー / 承認 2→1 ゲート / 構造的再発火 ≥1→0（S3 の hash 機構と併せて）。ADR-0006 の自認欠陥が構造的に修正される。
- **Negative**: 「mechanical-lane 機械判定」という新分類面が増え、誤判定リスクを criteria の厳格化で抑える必要がある。guard 側バックストップの非対称が残る（明示トレードオフ）。

## References

- ADR-0006: 本 ADR が amend する二層化決定
- ADR-0005: レビュアー SSoT（本 ADR で無改訂）
- ADR-0008: sibling follow-up ADR の構造先例
