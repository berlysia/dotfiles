# ADR-0015: Document Workflow の帳簿を機構側に移し、operator guide と機構仕様を分離する

## Status

accepted (2026-09-10)

## Context

Opus 5 を Document Workflow の下で動かすと、計画フェーズが総ターンの 70〜98% を占め、レビューが収束せず、必須 step が抜け、ゲートが閉じたまま固着するか逆に素通りする、という報告が続いた。2026-09-10 に `~/.claude/projects/**/*.jsonl` 1,075 セッションを横断計測し、Opus 5 main loop でワークフローが実働した 26 セッションを Fable 5 の 2 セッションと比較した。観測された失敗は 8 パターンに分かれる（`docs/plans/document-workflow-overhaul/research.md` §2）。

- 環境固有（Fable でも同率以上）: 「〜します」と宣言してツールを呼ばずにターンを閉じる（8/12 セッション、ユーザー催促 24 回）、レビュー非収束と文書肥大（hook 1 本の修正で計画文書 448KB、Round 11）、hook 出力の再注入（`plan-review-automation` が 1 セッション 439 回 ≈ 150k tokens、実レビューは 35 回）
- Opus 5 固有: plan/spec を `python3 - <<'PY'` で書き換える強い選好（plan 編集の 13〜86%、Fable は 0〜7%）。これが `Write|Edit|NotebookEdit` にしか掛からない PostToolUse hook 群と、固定コマンド列しか見ない guard の Bash 分類器に噛み合い、「文書を書くとレビュー自動化が発火せず、実装は逆に素通りする」双方向の破れを生んでいた。deny 文は固定文で原因を示さず、ハイフン 1 つの書式差で数日固着した例もある

根本原因は、機構が ADR-0001〜0013 で積層的に足される中で、hash 転記・marker 記入・Reviewer Outputs・triage marker・Executive Summary といった帳簿をモデルの手作業に載せ続けたこと、および常時ロードの `workflow.md`（36KB）の大半がモデルの行動指示ではなく機構仕様になっていたことである。各コンポーネントは `empirical-prompt-tuning` で個別に収束判定されていたが、繰り返し・逸脱の系列（同じ hook 出力を 185 回受け取る、Bash で編集する、deny が 3 連続する）は評価対象外だった。

## Decision

設計の全文は `docs/plans/document-workflow-overhaul/spec.md`（K1〜K10、7 名 × 3 ラウンドのレビューと intent triage を経て verdict=pass）にある。ここでは決定の骨子と、却下した代替案を記す。

### 1. 帳簿は `workflow-cli` が書き、reviewer の実行は台帳で裏付ける（K5）

`workflow-cli {status,round,stamp,triage}` が Review Status 行・auto-review marker（hash / design-hash / parent-spec-hash）・`## Reviewer Outputs (Round N)` 骨格・intent-triage marker を書く。モデルは hash を転記しない。`stamp` は `reviewer-run-recorder`（PostToolUse `Agent`）が `<wfDir>/reviewer-runs.log` に記録した必須 reviewer の起動証跡が揃わないと非 0 で終了する。CLI は Approval 行に触れる変更を拒否する（承認は人間のみ、ADR-0001 不変）。

**却下**: 状態を文書外の JSON に移す白紙案。guard の判定・テスト・進行中成果物が文書内 marker を読む前提で、全経路の書き換えになる。marker を CLI が書けば転記ミスは消え、白紙案の利益はほぼ得られる。

### 2. 文書変更の検知は tool 経路でなく内容 hash で行う（K1）

`workflow-bash-sync`（PostToolUse `Bash`）が wfDir 内 spec.md / plan.md / plan-N.md の hash を per-doc cache と比較し、変化した文書に `plan-review-automation` と同じ推奨を出す。判定の実体は `lib/workflow-review-core.ts` の `canSkip` / `buildRecommendation` に 1 本化し、両 hook が同じ関数を呼ぶ。subagent 由来の Bash（`agent_id` あり）は早期 return する。実測で subagent Bash は親の 4 倍発火しており、この gate が無いと 79s/セッションの追加コストになる。

**却下**: 既存の PostToolUse Bash hook（`command-logger` 等）に fold する案。それらは `async: true` で `additionalContext` を運べない。

### 3. gate 閉時の書換は tripwire で事後検知し、インタプリタ書込は狭い条件で事前 deny する（K2/K3）

承認前に repo 内ファイルが変わると、`workflow-bash-sync` が `git --no-optional-locks -c core.fsmonitor= status --porcelain -z -uall` の rolling baseline 差分で検知し、`off-plan-writes.log` に記録して告知する（200ms 予算、超過で `.tripwire-disabled` を残して一度だけ告知）。加えて `python|node|bun|deno` の inline script に書込指標があり、書込先が scratch root 外か証明不能なら guard が保守的に deny する。scratch root の判定は segment 境界比較で、wfDir 内パスは scratch から除外する（台帳を最安の unblock として書かせない）。

**却下**: 「書込先が証明できない限り deny」。解析用スクリプトを誤 deny し、deny を誤読して言い換え再送する失敗（P4）を再生産する。narrow な事前 deny + tripwire の二層で取りこぼしを拾う。

### 4. deny は診断にし、判定 regex と hash 正規化は変えない（K4）

deny 理由を「どの条件が不成立か・見つかった status 行・期待する厳密形・次の 1 手」に置き換える。`lib/workflow-gate.ts` の `diagnoseGate` を guard と `workflow-cli status` が共有する。ハイフン欠落などの近似行は寛容 regex で**表示専用**に拾い、判定の厳密 regex（`lib/workflow-marker.ts` の `STRICT_*`）と `lib/document-hash.ts` の正規化は一切変えない。

**却下**: `Review Status` を正規化対象に加える案。既承認文書の hash が動き、旧 normalizer で承認済みの進行中成果物が自己ロックする（S3 型移行が必要になる）。レビューで blocker として 2 名が指摘し、設計側で除去した。

### 5. レビュー推奨は (文書, round) ごとに 1 回、以後は pointer（K6/K10）

推奨全文は文書の `## Reviewer Outputs (Round N)` 数が cache の `fullTextEmittedForRound` を超えた最初の変更で出し、それ以外は ≤160B の pointer にする。round ≥ 2 は「前 round で needs-work / blocker だった reviewer のみ再確認」、round ≥ 3 で未収束なら「人間へエスカレーションし、指示なく Round 4 を始めない」を含める。`spec-plan-self-audit` と `spec-plan-placeholder-scan` は「書込後の文書が complete かつ hash が変わった」ときだけ発火する。

**却下**: `Plan Status` でゲートする案。実測では complete 化がセッションの 5% 時点に起き、以後の 95% で節約ゼロだった。

### 6. 宣言だけで止まる Stop を差し戻す（K7）

`resume-incomplete-work` に分岐を足し、wfDir に research.md があり、最終行が宣言語尾で人間待ちの語を含まない場合、既存の持続カウンタ（上限 2）の範囲で `decision: block` する。

### 7. `workflow.md` を operator guide に絞り、機構仕様を skill に分離する（K8/K9）

`~/.claude/rules/workflow.md` はモデルが行動する順の ≤12KB ガイドに書き直す。SSoT marker 区間（`<!-- ssot:*-reviewers:start/end -->`）は残し drift テストを維持する。hash 3 種の意味・DOCUMENT_WORKFLOW_DIR 引き継ぎ・S3 移行手順・carry-forward の責務分離・mechanical-lane 4 条件・ISO 25010 ガイド・`workflow-cli` 仕様は `.skills/document-workflow-reference/SKILL.md` に移す。ADR-0005/0006/0009 由来の不変条件テストは「機構が文書化され発見可能」を守るものなので、参照先を skill に向け直した。verdict 語彙は `pass/needs-work/blocker` に統一し、`code-simplicity-reviewer` を catalog に追加し、内部設計コードの hook 出力への漏れを除去した。

### 8. 本 ADR の位置づけ

ADR-0001（human-only approval、hook enforcement）、ADR-0003（enforce 既定）、ADR-0006（二層 hash 連鎖）、ADR-0009（mechanical-lane は amendment）、ADR-0013（wfDir は session_id 導出）はいずれも維持する。本 ADR はそれらの上に「帳簿と検知を機構側へ移す」層を足す amendment であり、supersede しない。`docs/plans/workflow-guard-followups.md` の課題 A/B/D は tripwire と Bash 対称化で事後検知の対象になり、課題 D（Bash 経由の spec/plan 編集が hook を迂回する）は解消した。

## Consequences

- モデルは hash を転記せず、deny の原因と次の 1 手を読める。Bash で文書を書いてもレビュー自動化が動く。reviewer 未起動のまま pass を書けない
- 推奨の再注入は実測ベースで約 87% 減る見込み（35 round × 1.5KB + 404 × 146B ≈ 83KB）。受入基準は変更後 5 セッションで `docs/scripts/workflow-session-audit.mjs` を回し、Reviewer Outputs / intent-triage の欠落 0、推奨注入量が round 数 × 2KB 以下
- 受容したリスク: `Approval Status: approved` の書込は prompt 統制のまま（研究で自己承認 0/20、単一ユーザー環境）。reviewer 台帳は session 単位で文書単位ではない（過剰許容側の fail-open、再評価トリガー「台帳通過後に無関係文書へ verdict が付いた事例 1 件」）。tripwire は ignore 済みパス・repo 外・nested repo・`git` 不在が盲点（主ゲートは guard）
- `stamp` の Round 1 baseline は session 全体の窓とする。wfDir mtime を使う案は cache / baseline / 台帳自身の書込で mtime が前進し、直前の正当な reviewer 実行を弾くため採らなかった
- 実装は 4 コミット（`128e08f` / `2801abb` / `4065170` / `3d599a4`）。全 1264 テストと typecheck を pre-commit で通している。`chezmoi apply` は別途実行する
- `stop-reflection.ts` の `messageForUser` は Stop での到達先を実機確認するまで変更しない。intent-triage marker の guard 必須化は warn 表示に留め、deny 昇格は「warn 後に triage 無しで承認へ進んだ事例 2 件」を再評価トリガーとする

## References

- `docs/plans/document-workflow-overhaul/research.md` — 失敗パターン P1〜P8 と根本原因
- `docs/plans/document-workflow-overhaul/spec.md` — K1〜K10、Risks、Reviewer Outputs（3 ラウンド）
- `docs/plans/document-workflow-overhaul/plan-1.md` / `plan-2.md` / `plan-3.md` — 実行層
- `docs/plans/document-workflow-overhaul/evidence/` — hook 注入テキスト棚卸し、成果物品質監査、コードマップ
- `docs/plans/workflow-guard-followups.md` — 課題 A/B/D の扱い
- `docs/decisions/0001-document-workflow.md`, `0006-document-workflow-two-layer.md`, `0013-workflow-dir-session-derivation.md`
