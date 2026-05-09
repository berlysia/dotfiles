# ADR-0008: Document Workflow フィードバック (08535ebf) — Deferred 改善案

## Status

proposed

## Context

my-secretary セッション (08535ebf) のフィードバックファイル `document-workflow-feedback-08535ebf.md` で提案された 13 件 (P1〜P13) のうち、本セッション (85f6f6e4) で採用した 7 件 (P1 / P3 / P9 / P10 / P12 軽量パス MVP / P13 + plan-1 T1〜T9 / plan-2 T1〜T3) は plan-1 / plan-2 で実装された。本 ADR は **deferred とした改善案** を構造的に記録し、将来採用検討時の出発点を残す。

採用 / deferred の対応関係:

- **採用 (本セッション)**: P1 (コード参照宣言フィールド) / P3 (test fixture 共通化規約) / P9 (PreToolUse self-audit) / P10 (PostToolUse placeholder grep) / P12 (lessons-learned 自動継承、軽量パス MVP) / P13 (Phase 1 非提供フォーマット)
- **Deferred (本 ADR)**: P4 / P11 / P8 / cross-session Memory 化 / `workflow-paths.ts` 未使用定数活用 / HMAC 改ざん検知 / P12 LLM 抽出版

## Decision

以下の改善案を deferred とし、将来の文脈変化（コード規模拡大 / 多人数化 / 失敗パターンの再発頻度上昇等）で採用判断を再評価する。

### Deferred-1: P4 — code-aware draft hook

**概要**: spec/plan に新しい関数名 / メソッド名 / SQL 文 / ライブラリ API を記述した時、PostToolUse hook で関連既存ファイルを自動 Read 推奨する。書く前の self-check として「この関数名/API名を spec に書いたなら、grep してから書け」のリマインダ。

**deferred 理由**: 完全自動化は誤検知ノイズ管理が難しい。grep 候補の noise filtering / namespace 衝突 / 多言語対応が要件として未確定。

**再評価条件**: spec/plan で「想像で関数名を書く」失敗パターンが Round 5 以降の複数セッションで再発した場合（具体閾値: 同一 my-secretary 系プロジェクトで 3 セッション連続で同種の指摘）。

### Deferred-2: P11 — TDD Step 3 compilable check

**概要**: plan-N の Tasks セクションから fenced TypeScript code block を抽出し、scratch dir に書き出して `bun run typecheck` を走らせる。型エラーがあれば警告。

**deferred 理由**: 技術的に可能（TS で fenced code block 抽出 + scratch dir + tsc）だが、運用合意が要る（型定義不足の許容範囲、scratch dir lifecycle 管理、テスト・タイプチェックの責務境界）。

**再評価条件**: F7 (TDD Step 3 placeholder-bag) が P10 警告だけで構造的に解決しないと判明した場合（具体例: P10 deploy 後 3 セッション以内に同種の指摘が plan-N で再発）。

### Deferred-3: P8 — 早期 1 reviewer 段階導入

**概要**: plan-N 全体起草前に最初の 1-2 タスク（例: T1 + T2）を書いた段階で **logic-validator 1 名だけ走らせる早期チェック**。コード参照と前提整合性を確認してから残りタスクを書く。

**deferred 理由**: `plan-review-automation.ts` を「early/full」モード化する変更で副作用大。SSoT (`SPEC_REVIEWERS` / `PLAN_REVIEWERS` 定数 + drift detection テスト) 構造への影響評価が要る。

**再評価条件**: 単一 plan-N で複数 reviewer の同一前提誤認が頻発した場合（具体閾値: 2 セッション以内に同一前提誤認が 2 件以上、本セッションの T2 想像補完再発などが該当）。

### Deferred-4: cross-session Memory 化 (greenfield Finding 1)

**概要**: lessons-learned を `.tmp/sessions/<id>/lessons-learned.md` ではなく、cross-session 永続層 (`~/.claude/memory/document-workflow-lessons/` 等) に格納し、プロジェクト横断で再発防止知識を継承する。

**deferred 理由**: 単一プロジェクト dotfiles 環境では session-scoped で十分。cross-session 化には threat model 再評価（HMAC 改ざん検知 / 別プロジェクトの教訓が混入する場合の filtering）が必要。

**再評価条件**: 別プロジェクトでも Document Workflow を使い始め、共通の起草精度問題が現れた場合（具体: 2 つ以上のプロジェクトで同じ失敗パターンが lessons-learned 抽出される）。

### Deferred-5: `workflow-paths.ts` の未使用定数活用

**概要**: `REVIEW_MARKDOWN_FILENAME = "plan-review.md"` / `REVIEW_JSON_FILENAME = "plan-review.json"` は定数宣言のみで未使用。本 spec の主経路（Reviewer Outputs section）はファイル本文に書き戻す方式を採用したが、別ファイル capture（LLM 抽出の入力ソース別経路）として活用できる。

**deferred 理由**: 主経路（Reviewer Outputs section）で十分機能する見込み。副経路導入は追加 hook (`reviewer-output-capture.ts` 等) が必要で、責務分離の追加検討が要る。

**再評価条件**: Reviewer Outputs section 方式で reviewer 出力が長大化し、本文 hash 計算コストや読み手の読了 friction が問題化した場合（具体: spec/plan の本文行数の半数以上が Reviewer Outputs section で占有される状態が継続）。

### Deferred-6: HMAC 改ざん検知

**概要**: lessons-learned.md は同一マシンの別プロセス / chezmoi apply で書換可能。HMAC 署名で改ざん検知する。

**deferred 理由**: 単一ユーザー dotfiles 環境前提で attack surface が極小（spec.md R11 で accepted risk 化済）。

**再評価条件**: (a) cross-session Memory 化（Deferred-4）と併せて検討、Deferred-4 が実装される際に同時実装するか accept-risk のまま残すか判断する、または (b) Deferred-4 非依存の独立条件として「lessons-learned.md が外部ストレージ（chezmoi 外、別マシン同期、共有ファイルシステム等）に移行され、複数 write 主体が想定される状況になった場合」も再評価対象とする。

### Deferred-7: lessons-learned-extractor の本番 LLM 抽出

**概要**: plan-1 T7 で実装した `lessons-learned-extractor.ts` は MVP として軽量パス（regex で `- 主指摘:` 行抽出）のみ実装し、`@anthropic-ai/claude-agent-sdk` を使った LLM 抽出は本セッションでは見送った。spec K4 で「LLM 抽出が解釈精度で優位」と記述された通り、軽量パスは reviewer の指摘 1-2 文を pattern matching で取り出すだけで、複数 reviewer 出力からの教訓抽象化や類似パターンの集約はできない。

**deferred 理由**: `@anthropic-ai/claude-agent-sdk` の hook 内利用パターンが既存 hooks に存在せず（`structured-llm-evaluator.ts` は PermissionRequest 用、SDK 直接呼び出しの例なし）、SDK 公式 doc 参照 + テスト整備 + 認証 fallback 設計が要る。MVP として軽量パスで「lessons 蓄積 + P9 hook で次セッション提示」のループを先に確立し、教訓粒度に不満が出た時点で LLM 化する段階導入。

**再評価条件**: 軽量パスで蓄積した lessons-learned.md が起草者から「粗すぎて使えない」とフィードバックされた場合、または同一 pattern の指摘が異なる文言で 3 件以上 lessons-learned に保存され dedup が機能しない事態が発生した場合。

## Consequences

- **Positive**:
  - 採用 7 件（元 6 件 + plan-1 T7 軽量パス MVP）の効果測定が先行できる
  - deferred 案の再評価条件が定量的に明示され、将来の判断基準が透明化
  - greenfield perspective（orchestrator パターン / cross-session Memory）を accept gap として記録、incremental 採用判断の妥当性が ADR レベルで検証可能になる
- **Negative**:
  - F7 (TDD Step 3 placeholder-bag) は P10 警告のみで構造的解決には届かない（Deferred-2 待ち）
  - lessons-learned が同セッション内に閉じる（Deferred-4 待ち）
  - lessons-learned 抽出粒度が粗い（Deferred-7 待ち、軽量パスでの MVP 運用）

## References

- フィードバック原本: `~/workspace/my-secretary/.tmp/document-workflow-feedback-08535ebf.md`
- spec: `.tmp/sessions/85f6f6e4/spec.md`（採用 6 件の根拠 + R11 accepted risks）
- research: `.tmp/sessions/85f6f6e4/research.md` §7（実装現状調査の再確認結果）
- plan-1: `.tmp/sessions/85f6f6e4/plan-1.md` T7（軽量パス MVP の実装、本 ADR Deferred-7 と対）
- plan-2: `.tmp/sessions/85f6f6e4/plan-2.md`（template / rules 改訂）
- 直前 ADR: `docs/decisions/0007-superpowers-process-discipline.md`
