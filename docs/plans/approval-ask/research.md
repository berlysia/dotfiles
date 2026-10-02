# Research: AskUserQuestion による承認の経路を足す

## オーダー

- 利用者（2026-10-03）: 「Document Workflow がファイルの承認を一括でできなくなった。AskUserQuestion で一気に聞けばいいという話をしたはずがなくなったか？」
- 続く会話で決まったこと:
  - 手で打てない完全一致の文字列（`承認 spec.md plan-3.md`）は、事実上使えない。
  - 承認できずに議論したいときは、質問をキャンセルしてチャットし、済んだら `approve` と打てばよい。だから「任意の時点で承認と打てなくなる」という (c) の却下理由は成り立たない。
  - 議論の後の素の `approve` で承認待ちが複数あるときは、記録せず AskUserQuestion で聞き直させる（案 (i)）。
  - 判断を求める点が複数あるときは AskUserQuestion でまとめて聞く、というルールも入れる（前回の会話で一度従っただけで、ルールに書いていなかった）。

## 現状（コード）

- 承認の記録は UserPromptSubmit の `approval-recorder.ts` だけが行う（ADR-0023 K7）。
  - 発話の形: `^(?:承認|approve)( (spec.md|plan.md|plan-N.md))*[。.!！]?$`（`lib/workflow-approval.ts:31-32`）。区切りは空白だけで、`、` や 2 つ目の `承認` を含む形は一致しない。
  - 文書名なしで承認待ちが 2 件以上のとき、何も記録せず「`承認 spec.md` / `承認 plan-3.md`」と並べて返す（`approval-recorder.ts:191-199`）。1 件ずつ打つよう案内している。
  - 文書名ありは全か無か（`approval-recorder.ts:178-189`）。
  - 記録の手順は `recordOne`（`:102-131`）と `setApprovalLineApproved`（`:69-94`）で、どちらも export されていない。
- 再利用できる関数（変更不要）: `evaluateApprovalReadiness`（`lib/workflow-gate.ts:568`、ready / alreadyApproved / 現在の hash）、`listApprovalCandidates`（`:611`）、`evaluateDocument`、`setApprovalStatusLine`（`lib/workflow-marker.ts:122`）、`resolveWorkflowDir`、`appendApproval`（`lib/workflow-approval.ts:84`）。
- guard（`document-workflow-guard.ts`）:
  - `GUARDED_TOOLS`（`:37-45`）は Write / Edit / MultiEdit / NotebookEdit / Bash / CronCreate / ScheduleWakeup。AskUserQuestion は含まない。
  - 予約ツールの判定（`:89-110`）は wfDir の解決より前に置かれ、自分の try を持つ fail-closed。同じ形で AskUserQuestion の判定を足せる。
  - K9（`:139-153`）の deny 文は「利用者に『承認 X』と打ってもらう」と案内している。
  - `lib/guarded-tools.ts` が同じ集合を持ち、`session.ts:85-110` が SessionStart で settings の matcher と突き合わせる。`tests/unit/guarded-tools.test.ts` が一覧を固定している。settings の matcher は `.settings.hooks.json.tmpl:4`。
- permission 層: `permission-llm-evaluator.ts:287` は AskUserQuestion を `USER_DECISION_TOOLS` として常に `ask` にする。`permission-auto-approve.ts` と `lib/` に AskUserQuestion の扱いは無い（grep で 0 件）。`updatedInput` を返す層は無い。
- 型（cc-hooks-ts 2.1.281 / `@anthropic-ai/claude-agent-sdk` の `sdk-tools.d.ts`）:
  - 入力: `questions[1-4]`（`question` / `header` / `options[2-4]`（`label` / `description` / `preview?`）/ `multiSelect`）、`answers?`、`annotations?`。
  - 出力（`AskUserQuestionOutput`、`sdk-tools.d.ts:3749-3935`）: `questions`、`answers`（質問文 → 回答。multiSelect は `, ` 区切り）、`response?`（選ばずに自由記述したとき）、`annotations?`、`afkTimeoutMs?`（「離席で自動解決したときに付く。人が答えた経路では必ず無い」）。
- 文書:
  - `rules/workflow.md` は 13,312 byte で、`workflow-md-budget.test.ts` の上限（13 × 1024）ちょうど。文言を足すなら同じ量を削るか上限を上げる。
  - 承認の記述: `rules/workflow.md` の共通フロー step 7、ターン終端規則、CRITICAL 節、Executive Summary の Next Action。`.skills/document-workflow-reference/SKILL.md` の 16 行目と「承認の記録」節（24-32 行目）。ADR-0023 の K7 と「改訂（2026-10-03）」節（(c) の却下）。
  - `.skills/execute-plan/SKILL.md` と `.skills/intent-alignment-triage/SKILL.md` に承認の記述は無い（grep で 0 件）。ADR-0023 は `/execute-plan` の案内も変わると書いたが、今は該当箇所が無い。
  - 承認の文言を固定するテストは無い。

## 実測（2026-10-03、本セッション、各 1 試行）

計測: リポジトリの `.claude/settings.local.json` に、AskUserQuestion の PreToolUse / PostToolUse で hook の入力を scratchpad に書き出す一時 hook を置いた（利用者が設置し、測定後に元へ戻した）。

| 試行 | 操作                                                      | PreToolUse の `tool_input.answers` | PostToolUse の `tool_response.answers` | PostToolUse    |
| ---- | --------------------------------------------------------- | ---------------------------------- | -------------------------------------- | -------------- |
| T2   | model が `answers` に `A` を先に入れ、利用者が `B` を選ぶ | `A`（model の値）                  | `B`（利用者の回答）                    | 発火           |
| T3   | multiSelect で 2 つ選ぶ                                   | なし                               | `"spec.md, plan-1.md"`                 | 発火           |
| T4   | Esc でキャンセル                                          | なし                               | —                                      | **発火しない** |

- T2 では PostToolUse の `tool_input.answers` も `B` だった。model の値が見えるのは PreToolUse の時点だけ。
- PostToolUse の `tool_response.questions` に、表示した質問がそのまま載る。T2・T3 とも、質問のキーは `question` / `header` / `options` / `multiSelect`、選択肢のキーは `label` / `description` で、入力に無かった `preview` のキーは無かった（入力に無いキーは足されない）。
- `approvals.log` の読み手（`lib/workflow-approval.ts` の `parseRecord`）は `v` / `doc` / `hash` / `session` / `at` だけを取り出し、それ以外のキーは無視する。キーを足しても既存の読み手は壊れない。
- どの試行でも `afkTimeoutMs` と `response` は無かった。
- 1 回目の設置は `~/.claude/settings.local.json` で、読まれなかった（user scope に local の設定ファイルは無い）。設定の変更が実行中のセッションに入るかは、ファイルの場所で決まる。

ADR-0023 の再訪の条件「(c) を、PostToolUse の `answers` を実測してから再検討する」の実測は、これで満たした。

## 未確認

- 離席による自動解決（`afkTimeoutMs`）が実際に起きる条件と、そのとき `answers` に何が入るか。型の説明だけが根拠。
- サブエージェントの中で呼んだ AskUserQuestion の PostToolUse に `agent_id` が載るか。
- PermissionRequest が UI なしで通る経路（hook が `answers` を返す、など）で、model の `answers` が結果になるか。公式ドキュメントはどのモードでも自動承認しないと書くが、実測はしていない。
