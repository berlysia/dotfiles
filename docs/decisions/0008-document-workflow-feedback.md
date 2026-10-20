# ADR-0008: Document Workflow フィードバック (08535ebf) — Deferred 改善案

## Status

proposed

ADR-0032 が改訂した: P3（test fixture 共通化規約）を廃止し、Deferred-2 (P11) を閉じた。plan にコード本体を書かなくなったため。

deferred 案の再評価条件は持ち越した課題の一覧（adr-followups）にある。

## Context

my-secretary セッション (08535ebf) のフィードバックで提案された 13 件 (P1〜P13) のうち、7 件 (P1 / P3 / P9 / P10 / P12 軽量パス MVP / P13 + plan-1 T1〜T9 / plan-2 T1〜T3) を採用して実装した。本 ADR は **deferred とした改善案** を構造的に記録し、将来採用検討時の出発点を残す。

- **採用**: P1 (コード参照宣言フィールド) / P3 (test fixture 共通化規約) / P9 (PreToolUse self-audit) / P10 (PostToolUse placeholder grep) / P12 (lessons-learned 自動継承、軽量パス MVP) / P13 (Phase 1 非提供フォーマット)
- **Deferred (本 ADR)**: P4 / P11 / P8 / cross-session Memory 化 / `workflow-paths.ts` 未使用定数活用 / HMAC 改ざん検知 / P12 LLM 抽出版

## Decision

以下の改善案を deferred とし、将来の文脈変化（コード規模拡大 / 多人数化 / 失敗パターンの再発頻度上昇等）で採用判断を再評価する。見送った理由は項目ごとに 1 行で記す。

- **Deferred-1: P4 — code-aware draft hook**: spec/plan に新しい関数名・API を書いたとき、関連する既存ファイルの Read を促す hook。完全自動化は誤検知ノイズの管理が難しく、grep 候補の noise filtering / namespace 衝突 / 多言語対応が要件として未確定のため見送る
- **Deferred-2: P11 — TDD Step 3 compilable check**: **closed（ADR-0032）**。plan-N.md がコード本体を持たなくなり、typecheck する対象が無くなった
- **Deferred-3: P8 — 早期 1 reviewer 段階導入**: plan-N の起草前に最初の 1-2 タスクだけ logic-validator 1 名で確認する案。`plan-review-automation.ts` を early/full モード化する変更は副作用が大きく、SSoT (`SPEC_REVIEWERS` / `PLAN_REVIEWERS` 定数 + drift detection テスト) への影響評価が要るため見送る
- **Deferred-4: cross-session Memory 化**: lessons-learned を cross-session の永続層に置き、プロジェクト横断で継承する案。単一プロジェクトの dotfiles 環境では session-scoped で足り、cross-session 化には threat model の再評価（改ざん検知、別プロジェクトの教訓の混入の filtering）が要るため見送る
- **Deferred-5: `workflow-paths.ts` の未使用定数活用**: 未使用の `plan-review.md` / `plan-review.json` の定数を、別ファイル capture の副経路に使う案。主経路（Reviewer Outputs section）で足りる見込みで、副経路には追加 hook と責務分離の検討が要るため見送る
- **Deferred-6: HMAC 改ざん検知**: lessons-learned.md の改ざんを HMAC 署名で検知する案。単一ユーザー dotfiles 環境で attack surface が極小（accepted risk R11）のため見送る。Deferred-4 と併せて検討する
- **Deferred-7: lessons-learned の本番 LLM 抽出**: **closed（2026-09-24 に撤去、Amendments）**。軽量パス（regex で主指摘の行を抽出）で MVP を運用していた（元の設計 K4 は LLM 抽出）が、lessons-learned 自体を撤去したので LLM 化はしない

## Consequences

- 採用 7 件の効果測定が先行できる。deferred 案の再評価条件が定量的に明示され、判断基準が透明になる
- F7 (TDD Step 3 placeholder-bag) は P10 の警告だけでは構造的に解決しない（Deferred-2 は、コード本体を plan に書かない形で閉じた）
- lessons-learned が同セッション内に閉じていた（Deferred-4 は未実施）。抽出粒度の粗さ（Deferred-7）は、撤去で解消した

## Amendments

### 2026-09-24: lessons-learned の撤去

`lessons-learned-extractor.ts` と、`spec-plan-self-audit.ts` が lessons-learned.md を注入する処理を撤去した。16 セッション分の lessons-learned.md を確認すると、中身は同じ文書の `## Reviewer Outputs (Round N)` にある主指摘の写しで、spec/plan を編集するたびに最大 200 行を二重に注入していた。セッション間で持ち越す経路（Deferred-4）も無く、教訓として働いていなかったため、LLM 化せずに撤去する。

## References

- ADR-0007: 直前の ADR
- ADR-0032: P3 の廃止と Deferred-2 の close
