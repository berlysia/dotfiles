# Spec: Document Workflow の同一性（セッション・版・場所）を確定させる

対象 Issue: #197, #221, #209, #216。調査は `research.md`。H = `home/dot_claude/hooks`。

## Goal

Document Workflow の各部品（hook・`workflow-cli`・gate）が、「どのセッションの workflow か」「人間がどの版を承認したか」「どのディレクトリを基準にするか」を、同じ情報源から同じ答えで得るようにする。

## Experience Delta

- **変更前**: `/clear` 後の `workflow-cli` が別セッションの承認済み plan を黙って書き換える（#197）。承認後に plan を改訂しても、レビューを通し直せば再承認なしで実装に進める（#221）。worktree に入る・`cd` するたびに、guard・CLI・status が別の workflow dir を見る（#209）。worktree の中では `git-worktree-create` が失敗する（#216）
- **変更後**: CLI は hook と同じセッション ID・同じ workflow dir を使い、書き込んだファイルの絶対パスを表示する。決められないときは黙って別の dir を使わずに失敗する。承認は会話で「承認」と書いた時点の版に結びつき、版が変われば gate が「再承認が必要」と理由付きで止める。workflow dir は session 開始時の root に 1 つだけあり、`cd` や worktree への移動で変わらない

## Architecture

3 つの同一性を、それぞれ 1 つの関数と 1 つの情報源に寄せる。

| 同一性     | 情報源                                                                                                                           | 集約先                                                                 | 利用者                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| 場所       | hook: Claude Code が渡す `CLAUDE_PROJECT_DIR`。Bash: SessionStart が export する同じ値                                           | `H/lib/project-root.ts`（新設、node 組込みのみに依存する葉モジュール） | `resolveWorkflowDir` を呼ぶ 9 hook、CLI、file-access-guard |
| セッション | hook: 入力の `session_id`。Bash: Claude Code が渡す `CLAUDE_CODE_SESSION_ID`（CHANGELOG が hook の `session_id` との一致を明記） | 既存 `H/lib/workflow-resolve.ts` `resolveWorkflowDir`                  | 9 hook、CLI                                                |
| 版         | 人間の発話時点の文書 hash を記録した `<wfDir>/approvals.log`                                                                     | `H/lib/workflow-approval.ts`（新設）                                   | gate、承認記録 hook                                        |

依存の向き（矢印は import される側 ← する側）:

```
project-root ← workflow-resolve ← { 9 hooks, cli/workflow.ts, file-access-guard }
document-hash ← workflow-approval ← workflow-gate ← { document-workflow-guard, cli/workflow.ts, approval-recorder }
workflow-files（repo toplevel 探索を追加）← workflow-gate
```

- `workflow-gate` は 2 層で export する。`evaluateDocument(path)`: 文書単体の条件評価（approval-recorder も使う）。`evaluateTarget(projectRoot, wfDir, target)`: 書き込み対象に対する判定（guard と CLI が使う）
- `evaluateTarget` の戻り値は判別共用体 `{ kind: "inactive" } | { kind: "allow", ... } | { kind: "no-plan-owner", ... } | { kind: "deny", conditions: ConditionResult[], nextAction: string }`。guard は `no-plan-owner` を実装フェーズなら warn + `off-plan-writes.log` に降格する（現行の挙動を保つ）
- 文書 hash の計算は `document-hash.ts` の `computeDocumentHash` だけを使う（guard の私有 `computePlanHash` は廃止）
- CLI は guard を import しない（guard は import 時に hook を登録する副作用を持つ）

```
UserPromptSubmit ─(「承認」)─▶ approval-recorder ─▶ approvals.log（正本）→ Approval 行（表示）
PreToolUse ─▶ document-workflow-guard ─▶ workflow-gate.evaluateTarget(projectRoot, wfDir, target)
Bash ─▶ workflow-cli ──────────────────▶ workflow-gate.evaluateTarget(同上)
            wfDir = resolveWorkflowDir({ cwd: getProjectRoot(), sessionId: CLAUDE_CODE_SESSION_ID })
```

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

- #197: CLI の不一致警告を強化し、書き込み系の出力に絶対パスを出す。または書き込み系に `--wf-dir` を必須にする（research §6-1 候補 B）
- #221: `stamp` / `round` が文書 hash の変化を検出したら、承認行を `pending` に戻す（無効化案）
- #209: guard の `## Files` 解決だけ `CLAUDE_PROJECT_DIR` 基準にする
- #216: `--git-common-dir` に変える

不採用の理由:

- 警告の強化は、観測された障害（両 env が同じ古いセッションを指す。research §1 のコメント 3 で実値を確認済み）を env 同士の比較では検出できない
- `--wf-dir` 必須化は、model が毎回正しい dir を書く前提に戻る。その dir を model が知る手段が、古くなりうる env（`$DOCUMENT_WORKFLOW_DIR`）しかない
- 無効化案は #221 の経路（改訂 → round → stamp）は塞ぐ。しかし承認行を `approved` にする操作は、現行規約でもユーザーの発話を受けた model が行う（rules/workflow.md CRITICAL 節）。人間の承認と model の書き込みを区別できないまま残る。ユーザーは「会話の承認を hook が記録する」方式を選んだ（research §5）

### 白紙設計案 (Greenfield)

ゼロから作るなら、ADR-0013 が hook について採った原則「毎回必ず手元にある入力から導出する」（docs/decisions/0013-workflow-dir-session-derivation.md Analysis 節）を、CLI と承認にも当てはめる。

- セッション: Claude Code 自身が渡す値だけを使う。hook は入力の `session_id`、Bash は `CLAUDE_CODE_SESSION_ID`。利用者側の配送（`CLAUDE_ENV_FILE`）でセッションを表す値は配らない
- 版: 承認は「人間がその版を見て承認した」という出来事なので、人間の操作でしか発火しない経路（UserPromptSubmit）で、その瞬間の hash を記録する。model が書ける文書の 1 行を承認の正本にしない
- 場所: workflow はセッションに属するので、基準はセッションと同じ寿命の値（session 開始時の root）にする。プロセスの cwd はツール呼び出しごとに動く（research §3 の観測）ので基準にしない
- 判定は 1 関数にし、表示（status）と強制（guard）が同じ結果を返す

### 採用案と理由

白紙設計案を採る。理由:

1. `CLAUDE_CODE_SESSION_ID` は本セッションの Bash env に実在し、fork したセッションでは fork 先の ID に追従した（research §1）。CHANGELOG で hook の `session_id` との一致が明記されている。新しい配送経路を作らずに済む。ただし `/clear` 後の値は未実測で、承認前の検証 V1 の結果で確定する（下記 Open Questions）
2. guard と `workflow-gate.ts` で判定が重複しており、#209-2（status と guard で `## Files` の解決基準が違う）の直接の原因になっている。#221 で条件を 1 つ足すときにも 2 か所の同期が要る
3. 承認の正本を log にしたうえで承認行を残すのは、テンプレート・`workflow-cli` の `wouldTouchApprovalStatus`・人間の目視確認がこの行を前提にしているためと、行を `pending` に戻す操作を取り消しの手段として使えるため。log だけに状態を持たせ表示を導出する形は、これらの置き換えを伴うので本変更では採らない
4. hook の `updatedInput` で CLI にセッションを注入する案（research §6-1 候補 A）は、`permissionDecision: allow`（権限確認を飛ばす）か `ask` との組が必要で、複数 hook の合成も未規定（research §1）。V1 が失敗した場合の代替としてだけ残す

## Key Decisions

- **K1: プロジェクト root は `getProjectRoot(inputCwd?)` 1 つで決める** — 優先順は `CLAUDE_TEST_CWD`（テスト専用。production での扱いは docs/plans/workflow-guard-followups.md 課題 E で追跡中のため本変更では触れない）→ `CLAUDE_PROJECT_DIR` → `inputCwd` → `process.cwd()`。compaction-testament の私有関数をそのまま移設し、挙動を変えない
  - 適用先: `CLAUDE_TEST_CWD` を読んで root を決める実装（`git grep -l CLAUDE_TEST_CWD -- home/dot_claude/hooks/implementations` の 11 ファイル: compaction-testament / document-workflow-guard / spec-plan-placeholder-scan / workflow-bash-sync / block-plan-mode / spec-plan-self-audit / reviewer-run-recorder / session / resume-incomplete-work / plan-review-automation / file-access-guard）。workflow と無関係に `process.cwd()` を使う hook（completion-gate など）は対象外。lib 側で `resolveWorkflowDir` を呼ぶ箇所は無い（workflow-paths.ts の言及はコメントのみ）。この 11 ファイルは Architecture 節の「`resolveWorkflowDir` を呼ぶ 9 hook」とは別の集合で、plan-review-automation と file-access-guard は root を決めるが `resolveWorkflowDir` は呼ばない
  - compaction-testament の `getWorkingDirectory`（compaction-testament.ts:219-221、相対の Write 先の解決にだけ使う）は、ツール呼び出し時点の cwd を表す別の値なので残す。この関数も `CLAUDE_TEST_CWD` を読むが、root の決定ではない用途なので K1 の置き換え対象に数えない
  - session.ts も同じ関数を使う。session.ts:129-132 のコメントは「`process.cwd()` を使い `input.cwd` は使わない」と定めているが、その目的は Claude Code の起動位置を root にすることで、`CLAUDE_PROJECT_DIR` がその値の正本なので置き換える。hook の env には Claude Code が `CLAUDE_PROJECT_DIR` を渡すので、自分が export する値を自分で読む循環は起きない。session.ts:244-248 の cwd 不一致の表示は、`input.cwd` と解決した root の比較に変える（worktree / `cd` の検出という目的は同じ）
  - Bash への配送: session.ts が `CLAUDE_ENV_FILE` に `CLAUDE_PROJECT_DIR` を毎回 export する（hook からは Bash の env を見られないので、書くかどうかを条件分岐しない。Claude Code が将来 Bash にも渡すようになっても、同じ値の上書きなので害がない）。hook の env に `CLAUDE_PROJECT_DIR` がある状態で export 行が書かれることをテストで固定する。export する値は、新設の `shellSingleQuote`（単一引用符で包み、`'` を `'\''` に置換）を通して書く。残る既存の export（`CLAUDE_TRANSCRIPT_PATH` / `CLAUDE_PROJECT_HASH` / `CLAUDE_TASK_LIST_ID`、session.ts:146-160）も同じ関数に通し、同じファイルに書き方を 2 通り残さない
  - CLI（Bash 経路）は `CLAUDE_PROJECT_DIR` が無ければ、`--wf-dir` 指定時を除き失敗する（黙って cwd に落ちない）。この値は `/clear` をまたいでも同じ Claude Code プロセスのプロジェクトを指すので、古い値が残っても別プロジェクトを指さない
  - 参照: `home/dot_claude/hooks/implementations/compaction-testament.ts:231-237`（移設元 `getProjectDirectory`）
  - 参照: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:292-294`（置き換え対象 `getWorkingDirectory`）
  - 参照: `home/dot_claude/hooks/implementations/session.ts:129-135`
- **K2: `## Files` の相対エントリは、対象ファイルが属する同一リポジトリの worktree からの repo 相対パスで照合する** — 対象パスの存在する最も近い祖先を realpath し、そこから上へ辿って最初に `.git` を持つディレクトリを toplevel 候補とする。候補は次のどちらかのときだけ採用する: (a) プロジェクト root の realpath と一致する、(b) 候補の `.git` がファイルで、その `gitdir:` が `<プロジェクト root>/.git/worktrees/` の下を指す。どちらでもなければ現行どおりプロジェクト root 基準で照合する（別リポジトリの同名相対パスには一致しない）。絶対パス・`~` のエントリは現行どおり realpath で比べる。git を spawn しない。探索は `H/lib/workflow-files.ts` に置く
  - `gitdir:` の値は相対パスのことがあるので、`.git` ファイルのあるディレクトリ基準で resolve し realpath してから比べる。`<root>/.git/worktrees/`（git が worktree のメタデータを置く場所）と、本リポジトリの規約で作業ツリーを置く `<root>/.git/worktree/<branch>` は別物で、テストで両方を使い分ける
  - テストで固定する負例: root 配下にネストした `.git` ディレクトリ（別 clone）は採用しない。別リポジトリの同名相対パスに一致しない。worktree の中で開始したセッション（root = その worktree）から兄弟 worktree のファイルは (a) にも (b) にも合致しない
  - 参照: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:528-531`（現行 `parseFilesSection`）
  - 参照: `home/dot_claude/hooks/lib/workflow-resolve.ts:70-78`（realpath と字句パスを混ぜない規律）
- **K3: CLI の wfDir は `resolveWorkflowDir({ cwd: getProjectRoot(), sessionId: CLAUDE_CODE_SESSION_ID })` で決める** — hook と同じ関数・同じ入力にする。`CLAUDE_SESSION_ID` は読まない。`CLAUDE_CODE_SESSION_ID` が無いとき（人間のターミナル）は `--wf-dir` を必須とする
  - `DOCUMENT_WORKFLOW_DIR` は**入力としての起動時 pin**（`DOCUMENT_WORKFLOW_DIR=… claude`）だけを意味する。K4 で SessionStart の export をやめると、Bash の env にあるこの値は hook の env と同じ起動時の値だけになり、CLI と hook の解決結果が一致する
  - `--wf-dir` は `<root>/.tmp/sessions/` の厳密な子孫であることを realpath で検証する（現行）。解決値と異なる dir を指すときは stderr に警告を出し、成功出力の決定元も `source=override` にする（model が stderr を読み落としても気づけるように）
  - 参照: `home/dot_claude/hooks/lib/workflow-resolve.ts:84-143`
  - 参照: `home/dot_claude/hooks/cli/workflow.ts:164-192`、`:740-754`
- **K4: SessionStart は `CLAUDE_SESSION_ID` と `DOCUMENT_WORKFLOW_DIR` を export しない（出力としての env を廃止）** — `CLAUDE_ENV_FILE` 由来の値が `/clear` 後に古いまま残り（#197 のコメント 3 で実値を確認）、`$DOCUMENT_WORKFLOW_DIR/research.md` のように model が書き込み先に使う手順（rules/workflow.md:28）で同じ取り違えが起きる。export を残したまま CLI だけ読まなくしても、文書に従う model が古い dir に書く経路が残る
  - 利用箇所（`git grep` で網羅）を同じ変更で置き換える: `home/dot_claude/rules/workflow.md:5,28`、`home/dot_claude/CLAUDE.md:9`、`.skills/document-workflow-reference/SKILL.md:53,65,103-116,138`、`.skills/task-handoff/SKILL.md:90-107`、`.skills/session-memo/SKILL.md:31-35`、`.skills/test-design/SKILL.md:26`、本リポジトリの `CLAUDE.md:12`
  - 置き換え先: wfDir は新設の `workflow-cli dir`（解決済みの wfDir の絶対パスと決定元 `derived` / `env` を 1 行ずつ表示）、セッション ID は `$CLAUDE_CODE_SESSION_ID`
  - hook プロセスで読む箇所は変更しない。hook の env には `CLAUDE_ENV_FILE` が届かない（ADR-0013 Context）ので、export をやめても値は変わらない（起動時 pin だけが見える状態のまま）: `home/dot_claude/lib/unified-audio-config.ts:57`（`CLAUDE_SESSION_ID`）、`H/implementations/document-workflow-guard.ts:696,722`（scratch root としての `DOCUMENT_WORKFLOW_DIR`）、`H/implementations/session.ts:135`（userPin の検証と警告）、`H/lib/workflow-resolve.ts:118`（入力 pin）。`H/lib/workflow-paths.ts:27,166` の `getWorkflowDir` / `getWorkflowDirRelative` は production の呼び出し元が無い（followups 課題 F で削除を追跡中）ので触れない
  - 置き換えの漏れは K4 の目的（古い dir への書き込みをなくす）を黙って崩すので、手作業の列挙に頼らず検査テストで固定する。対象は `home/dot_claude/rules/*.md`、`home/dot_claude/CLAUDE.md`、`CLAUDE.md`、`.skills/**/*.md`、`home/dot_claude/hooks/**/*.ts`（テストを除く）。`$DOCUMENT_WORKFLOW_DIR` / `$CLAUDE_SESSION_ID` / `env.CLAUDE_SESSION_ID` の参照を禁止し、上の hook プロセス側の 4 箇所だけを許可リストに置く
  - 参照: `home/dot_claude/hooks/implementations/session.ts:145`、`:177-182`
- **K5: CLI の書き込み系は wfDir の外を拒否し、絶対パスを表示する** — `stamp` / `triage` も `round` と同じく素のファイル名だけを受け付ける。成功時は書き込んだファイルの絶対パスと wfDir の決定元を表示する（#197 修正案 1・3）
  - 出力の形: 既存の人間向けの行の後に、`wfDir=<絶対パス>`、`source=derived|env|override`、`wrote=<絶対パス>` を 1 行ずつ出す。`workflow-cli dir` は `wfDir=` と `source=` の 2 行だけを出す。失敗時（終了コード非 0）は stdout に何も出さず stderr に理由を出す。この形をテストで固定する
  - 参照: `home/dot_claude/hooks/cli/workflow.ts:356-360`（`round` の素のファイル名検査）
  - 参照: `home/dot_claude/hooks/cli/workflow.ts:466-469`、`:694`、`:737`（名前だけの成功出力）
- **K6: gate の判定を `workflow-gate.ts` に一本化する** — guard の `hasApprovedPlan` / `checkTarget` / `isContentApproved` / `parseFilesSection` / `findPlanNumberedFiles` と `diagnoseGate` を、Architecture 節の `evaluateDocument` / `evaluateTarget` に移設し、guard 側の同名私有関数は残さない。まず挙動を変えない移設として行い、guard と gate の既存テストが移設前後で同じ結果になることを確かめてから K2・K8 を足す。`workflow-cli status <path>` は渡されたパスに対する `evaluateTarget` の結果を表示する（二層なら所有する plan-N.md と `## Files` の照合を含む）。根拠は #209-2 と、K8 の条件を 1 か所に足すため
  - 参照: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:373-531`
  - 参照: `home/dot_claude/hooks/lib/workflow-gate.ts:69-147`
- **K7: 承認は UserPromptSubmit の発話で記録する** — 新設の `approval-recorder` hook を `.settings.hooks.json.tmpl` の UserPromptSubmit に登録する
  - 反応する発話: 前後の空白を除いた全体が、`承認` / `approve`（大文字小文字を問わない）に、任意で文書名（`spec.md` / `plan.md` / `plan-<数字>.md`、空白区切りで複数可）と末尾の句点・感嘆符を足しただけの形。それ以外は何もしない
  - 対象: 文書名があればそれ。無ければ、`evaluateDocument` で承認以外の条件をすべて満たし（Review pass、marker pass、marker hash = 現在の hash、plan-N なら parent-spec-hash 一致）、かつ「承認行が `approved` で、log の最新 hash も現在の hash と一致する」状態ではない文書がちょうど 1 つのときにそれ（log だけ書けて承認行の書き換えに失敗した文書も候補に入る）。0 件・複数件のときは記録せず、`additionalContext` で理由と、文書名を付けた発話の形を伝える。二層モードで plan-N が複数承認待ちなら、文書名の指定が必須になる
  - 記録の手順: (1) `approvals.log` に 1 行を `appendFileSync` で追記する（gate はこれを正本にする）、(2) 文書の `Approval Status:` 行を `approved` に書き換える、(3) `additionalContext` で「plan.md を hash=<先頭 12 桁> で承認として記録し、承認行を書き換えた。編集する前に読み直す。取り消すには承認行を pending に戻す」と伝える。追記の関数（`JSON.stringify` した 1 行を 1 回の `appendFileSync` で書く）と読み手は `workflow-approval.ts` に置き、hook は呼ぶだけにする。(2) が失敗しても同じ発話をもう一度すれば (1)(2) が冪等に完了する
  - 承認行の値は文書 hash の計算から除外されている（document-hash.ts の正規化）ので、(2) で hash は変わらない。帳簿だけの変更（Reviewer Outputs 節、auto-review / intent-triage marker、チェックボックス）も hash 計算から除外されるので、承認後のこれらの追記では再承認が要らない（#221 論点 3）。`Review Status` 行は hash に含まれるので、承認後に `stamp` すると承認は無効になる（意図どおり）
  - `/execute-plan` は承認の操作として扱わない。承認は発話だけで行い、`/execute-plan` は承認後に実装を始める操作とする。rules/workflow.md の CRITICAL 節と Executive Summary の Next Action の文言を「会話で `承認`（必要なら文書名）と書く」に改める
  - hook が文書を書き換えるので、model が直前に読んだ内容と食い違い、次の Edit が「読み込み後に変更された」で失敗しうる。この場合は読み直せばよいことを ADR に書く
  - 参照: `home/dot_claude/hooks/lib/document-hash.ts:63-72`（承認行の値と帳簿を除外する正規化）
  - 参照: `home/dot_claude/.settings.hooks.json.tmpl:269-291`（既存の UserPromptSubmit 設定）
  - 改訂（2026-10-03）: ADR-0023 の改訂節を参照。出どころの判定の前提（`source` で予約のプロンプトを区別できる）が 2.1.287 で成り立たないことが分かった
- **K8: `approvals.log` の形式と gate の条件** — 1 行 1 JSON（JSON Lines）で `{"v":1,"doc":"plan.md","hash":"<sha256>","session":"<session_id>","at":"<ISO>"}`。JSON にするのは文書名・session_id の区切り文字の扱いを `JSON.stringify` に任せるため。読み手は、同じ `doc` の行のうち**最後の行**だけを使う（承認 → 改訂 → 元の版に戻す、で古い承認が復活しない）。`session` は監査用で照合に使わない（task-handoff が旧 wfDir を複製した場合も、文書が同じ版なら承認が引き継がれる。意図した挙動として ADR に書く）。不正な行と、`v` が 1 以外の行は読み飛ばし、読み飛ばした行があれば診断に `ignored-lines=<N>` を出す
  - gate は既存の 5 条件（3 status 行、verdict pass、marker hash 一致）に「その文書の最新の承認 hash = 現在の文書 hash」を加える。承認行の `approved` は表示であると同時に取り消しの手段で、承認行だけを手で `approved` にしても `approvals.log` に一致が無ければ通らない。取り消した（`pending` に戻した）後で人間が承認行を手で `approved` に戻すと、log の最新 hash が現在と一致していれば再発話なしで通る。人間の操作なので意図した挙動とし、ADR に書く（model には K9 によりできない）
  - 不一致のときは「承認が必要になった」時点で診断する（`Recoverable State Must Announce Itself`）。診断は決まった形の行で出す: `approval: recorded=<hash 先頭 12 桁 | none> current=<先頭 12 桁>` と `next: 会話で「承認 <文書名>」と書く`。承認行を自動で `pending` に戻すことはしない（表示の書き換えを hook が勝手に行うと、model の Edit との競合が増えるため。gate の診断で足りる）
  - 参照: `home/dot_claude/hooks/lib/workflow-gate.ts:69-141`（条件の列挙）
- **K9: model による承認の書き込みを guard で止める** — wfDir の文書への Edit / Write で、旧内容が無い（新規作成）か旧値が `approved` 以外で、新しい `Approval Status:` の値が `approved` のものを deny する。値が変わらない全文書き換えと、`approved` から `pending` への変更（取り消し）は通す。`approvals.log` への Edit / Write は realpath で比べて deny する。位置づけは多層防御: gate の安全性は K8 だけで成り立つ。この deny は、#221 で問題になった「人間が見ていない状態で承認が成立して見える」ことを表示の側でも起こさないために置く。model が承認行を `approved` にできると、gate は止めても文書は承認済みと読め、人間と model の双方を誤誘導する
  - 参照: `home/dot_claude/hooks/cli/workflow.ts:206-211`（CLI 側の同種の保護 `wouldTouchApprovalStatus`）
  - 改訂（2026-10-03）: ADR-0023 の改訂節を参照。guard は承認の形のプロンプトを `CronCreate` / `ScheduleWakeup` で予約することも止める
- **K10: file-access-guard は解決済みの wfDir への書き込みを許可する** — K1 で wfDir が session 開始時の root（例: 本体 checkout）に固定されると、worktree の中で作業しているときの repo root（`git rev-parse --show-toplevel` = worktree）の外になる（worktree は `<root>/.git/worktree/<branch>` にあり、`<root>/.tmp/sessions` はその外）。`resolveWorkflowDir` で解決した wfDir だけを許可に加える。同じ経路の拒否は #209 で観測済み（worktree 内での作業時に、repo root の外にある scratchpad への Write が「File is outside repository root」で拒否された）
  - 参照: `home/dot_claude/hooks/implementations/file-access-guard.ts:101-113`（repo root の決め方）
  - 参照: `home/dot_claude/hooks/implementations/file-access-guard.ts:590`（拒否の理由文）
- **K11: `git-worktree-create` は `git rev-parse --path-format=absolute --git-common-dir` を基準にする** — どの worktree から実行しても `<main>/.git/worktree/<branch>` に作る。`git-worktree-cleanup` は `git worktree list` の先頭を基準にしており同じ不具合はない（research §3）ので変更しない
  - 参照: `home/dot_local/bin/executable_git-worktree-create:62-63`
- **K12: 文書と ADR** — `docs/decisions/0022-workflow-identity.md` に本 spec の判断を記録し、ADR-0013 の Open observation items 1（worktree 経路の cwd 不一致）を解消したと相互参照する。`.skills/document-workflow-reference/SKILL.md` に worktree で Document Workflow を使う手順（wfDir は開始時の root にある、`workflow-cli dir` で確認する）を書く
  - 参照: `docs/decisions/0013-workflow-dir-session-derivation.md`（Open observation items 節）

## 実装の分割（plan-N の予定）

依存の順に 5 つに分ける。各 plan は独立に承認する。

1. plan-1: K11（#216）。他と独立
2. plan-2: K1・K10（場所の基準）
3. plan-3: K6（挙動を変えない gate の一本化）→ K2
4. plan-4: K3・K4・K5（CLI とセッション、文書の置き換え）
5. plan-5: K7・K8・K9・K12（承認と文書）

## 対象外（#209 で挙がったが本変更で扱わないもの）

- scratchpad / `mktemp -d` が file-access-guard に拒否される件は対応済み（#209 のコメント 1、commit 9f6d8c9 のブランチ）
- 同コメントが残課題として挙げた 5 点（literal `/tmp` 判定の共通化、repoRoot の前方一致の境界、Bash のパス抽出、`Edit(/tmp/**)` による締め付けの無効化、macOS 以外の `$TMPDIR`）は workflow の同一性と独立なので扱わない。#209 を閉じるときに別 Issue へ移す

## Risks

- **R1**: 本変更の前に承認された進行中の workflow は、`approvals.log` が無いので gate が止める → 診断が「会話で承認と書く」を示すので、1 発話で復旧できる。互換のための例外は設けない
- **R2**: `CLAUDE_CODE_SESSION_ID` は env-vars ページに未掲載で、CHANGELOG にだけ記載がある。値が無いときは `--wf-dir` を要求して失敗する。値が `/clear` 後も古いまま残る場合は #197 と同じ取り違えが起き、これが V1 の失敗条件である → V1 で実測する
- **R3**: 発話の判定が厳しいので、「承認します、ただし…」は承認にならない → model は承認行を書けない（K9）ので、gate の診断に従って承認の形を利用者に伝える
- **R4**: model が Bash で `approvals.log` に追記する経路は止めない（Bash の書き込み先の判定には既知の穴がある: docs/plans/workflow-guard-followups.md 課題 A/B）→ 本 gate は不注意な逸脱を止める仕組みで、意図的な迂回への耐性は主張しない（ADR-0013 Consequences 4 と同じ脅威モデル）
  - 改訂（2026-10-03）: ADR-0023 の改訂節を参照。予約のツールによる経路は R4 の外に置かず、guard が止める。R4 に残るのは Bash の迂回など、調べていない入口である
- **R5**: サブディレクトリで `claude` を起動すると、そこが root になる → 現行の `process.cwd()` 基準と同じで悪化しない（ADR-0013 Consequences 2）
- **R6**: 配備前に起動したセッションの Bash env には、旧 SessionStart が export した `DOCUMENT_WORKFLOW_DIR` が残り、K3 の解決で起動時 pin と同じ扱いを受ける。同じセッションには `CLAUDE_PROJECT_DIR` も無いので、CLI は K1 により失敗する（安全側） → 配備後は Claude Code を起動し直す。ADR に書く
- **R7**: 文書名なしの「承認」は、ユーザーが別の話題への返事として書いた場合にも、承認待ちが 1 件なら記録される → 記録時に `additionalContext` で対象と hash と取り消し方を必ず伝える。発話全体が承認の形に限られるので、文中の「承認」には反応しない

## Open Questions

- **V1（承認前に必要）**: `/clear` の前後で、Bash の `$CLAUDE_CODE_SESSION_ID` が hook の `session_id` に追従するか。確認手順: 任意の Claude Code セッションで `! echo $CLAUDE_CODE_SESSION_ID` → `/clear` → `! echo $CLAUDE_CODE_SESSION_ID`、2 つの値と `~/.claude/logs/hook-timing.jsonl` の直近の `session_id` を比べる。`/resume` の後にも同じ確認をする
  - 追従しない場合: plan-4 には着手せず、spec を再レビューに戻す。影響範囲は K3（CLI の session 源）、K4 の置き換え先（`$CLAUDE_CODE_SESSION_ID` と `workflow-cli dir`）、K5 の決定元表示、R2。代替は候補 A（PreToolUse の `updatedInput` による注入）で、`ask` と組にするため CLI を呼ぶたびに権限確認が出る代償がある。plan-1〜plan-3 は V1 の結果に依存しない

## ISO 25010 次元選択

- **機能適合性（正確性）**: CLI・guard・status が同じ wfDir と同じ判定を返すこと、承認が版に結びつくこと
- **セキュリティ（真正性）**: 承認の記録が人間の発話でしか作られないこと、model の承認行の書き込みが止まること、export する値が shell に解釈されないこと
- **互換性（共存性）**: 同じプロジェクトの並行セッションが互いの wfDir を書き換えないこと
- **性能効率性**: K2 の toplevel 探索は git を spawn しない。guard の実行時間を増やさないこと
- **対象外**: 使用性（利用者の操作は「承認」の発話だけで、手順は増えない）、移植性（macOS と既存の CI 環境以外を想定しない）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: K3 の「env pin は従来どおり」は、`CLAUDE_ENV_FILE` 由来の古い `DOCUMENT_WORKFLOW_DIR` が `CLAUDE_CODE_SESSION_ID` の導出値に勝つので #197 が閉じない。K4/R6 の利用箇所の見積もりが過小（`rules/workflow.md:5,28` 等）。`/clear` 後の `CLAUDE_CODE_SESSION_ID` は未検証

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: K5 の reviewer-runs.log の session_id 絞り込みは 4 Issue に根拠がない。K6 の根拠に #197 を挙げるのは誤り（K8 の同期と #209-2 が根拠）。#209 の worktree 手順の文書化と対象外の明示が欠けている

### decision-quality-reviewer

- verdict: needs-work
- 主指摘: 中核前提（`/clear` 後の `CLAUDE_CODE_SESSION_ID`）が未実測。#221 には「stamp が承認を pending に戻す」無効化案があり、Alternative 節で比較されていない。K7 が `/execute-plan` と Executive Summary の承認依頼文と整合しない

### greenfield-perspective-reviewer

- verdict: needs-work
- 主指摘: K2 の toplevel 探索が同一リポジトリの worktree かを確かめず、別リポジトリの同名相対パスに一致しうる。K1 の `CLAUDE_PROJECT_DIR` を `CLAUDE_ENV_FILE` で配送するのは K4 が否定した機構と同じで、無いときに黙って cwd に落ちる

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: `getProjectRoot` は移設元の `inputCwd` フォールバックを保つこと。gate は「文書単体の評価」と「対象の評価」の 2 層で export し、戻り値型（allow / no-plan-owner / deny-other + 条件別結果）を明記すること。toplevel 探索は project-root と別モジュールに置くこと

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: `CLAUDE_PROJECT_DIR` の export に `isSafeForDoubleQuotedExport` 相当の検査が無く、既存の 3 export も無検査（session.ts:145-155）。文書名なしの承認は意図と対象が結びつかない。K9 は新規作成の Write を覆うか不明

### data-contract-evolution-evaluator

- verdict: needs-work
- 主指摘: `approvals.log` の形式（バージョン、エスケープ、最新行勝ち、session_id の役割）が未定義。`DOCUMENT_WORKFLOW_DIR` の「出力 env は廃止、入力 pin は維持」を明記すること。`unified-audio-config.ts:57` も `CLAUDE_SESSION_ID` を読む

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: needs-work
- 主指摘: V1 失敗時の分岐が K3 だけで、K4 の置き換え先・`workflow-cli dir`・K5・R2 も同じ前提に依存する。R2 は「値が古いまま残る」場合を扱っていない。K7 の対象選択が (1) 成功 (2) 失敗後の再実行を含むか不明。R6 に `CLAUDE_PROJECT_DIR` 欠落を追記

### scope-justification-reviewer

- verdict: pass
- 主指摘: 軽微 3 点: K9 を多層防御と位置づけ直す、K10 に実観測の引用、K4 の文書検査テストの根拠を 1 行

### decision-quality-reviewer

- verdict: pass
- 主指摘: 軽微: V1 に `/resume` を足す、V1 失敗時は再レビューと書く、K7 の additionalContext に「承認行が書き換わった、読み直す」を含める

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 軽微: V1 失敗時の影響範囲は K3〜K5 と plan-4 全体、承認行を残す根拠を採用理由に 1 文、K2(b) の `.git/worktrees/` と `.git/worktree/` の区別をテストで固定

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: K1 の適用先に plan-review-automation が漏れている（`CLAUDE_TEST_CWD` を読む実装は 11）。session.ts:129-132 の「process.cwd() を使う」判断を覆す理由と :246 の不一致診断の扱い。approvals.log の追記関数を workflow-approval.ts に置く

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: 既存の 3 export も同じ単一引用符関数を通す。K2 のネスト `.git` ディレクトリと相対 `gitdir:` の負例テスト。`--wf-dir` 上書き時は成功出力の決定元にも `override` を出す。export 値の shell 非解釈テスト

### data-contract-evolution-evaluator

- verdict: needs-work
- 主指摘: K4 に hook プロセス側の `DOCUMENT_WORKFLOW_DIR` 読み取り（guard :696,:722、workflow-paths.ts）が影響を受けない理由を書く。文書検査の対象を `hooks/**/*.ts` と `rules/*.md` に広げる。CLI 出力を `key=value` 行で固定する。未知の `v` の扱い

<!-- auto-review: verdict=needs-work; hash=873f5ed2f9dc91595bb67e2cfb0463561466ca86e646992a0dd6fc103144b737; design-hash=571a8b3a7f23d0b8b77458b05560fe8b1ca3e8ca00693ba387a215de6760c921; round=1; at=2026-10-02T04:52:43.387Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: needs-work
- 主指摘: K1 の「Bash の env に既に値があれば書かない」は hook から判定できない（hook の env には常に `CLAUDE_PROJECT_DIR` がある）ので、実装すると export が一度も書かれない。常に書くこと。軽微: compaction-testament の `getWorkingDirectory` の扱い、承認行を手で `approved` に戻す挙動の ADR 注記

### scope-justification-reviewer

- verdict: pass
- 主指摘: Round 2 の軽微 3 点は反映済み。Round 2 で足した範囲（既存 export の引用、検査テスト、key=value 出力、plan-review-automation）はいずれも根拠あり

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸（同一性の集約と、決められないときの失敗）は Round 1 から一貫。Executive Summary の Open Questions に V1 を明示すること

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: Round 2 の軽微 3 点は反映済み。新たな野心ギャップなし

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: 軽微: 「`CLAUDE_TEST_CWD` を読む 11 ファイル」と「`resolveWorkflowDir` を呼ぶ 9 hook」は別集合である旨を注記

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: 軽微: export 値の shell 非解釈テスト（改行を含むパスの扱いも）は plan-2 のテスト節に入れる

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘: 軽微: `v` を上げる際は読み手を先に配備する順序、`ignored-lines` は不一致診断に必ず含める、ADR の記載項目を plan-5 のチェックリストに載せる

<!-- auto-review: verdict=needs-work; hash=3b55e9d7a521b53736b1ad34f32f3b4fbb46429823e823b68b5d71aeea973cb7; design-hash=a0194b80f712f294e4b8ce2f2cf9058279c49902bcf5e3d828add1e1bff26ba9; round=2; at=2026-10-02T04:56:05.448Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 4)

### logic-validator

- verdict: pass
- 主指摘: Round 3 の 3 点は解消（K1 は毎回 export、11 ファイルと 9 hook の区別は実コードと一致、`getWorkingDirectory` を残す理由が成立、手動の再承認は ADR に記載）。軽微: 残す `getWorkingDirectory` は root 決定ではない用途と注記（反映済み）

### scope-justification-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### decision-quality-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=f7beec5b2444be190c03aa743a1d2b1d1c93a635bf73b60812cd2fb670f7dc69; design-hash=e4f8f5260de8d201272bd3794d088fc5e374f8b683de3a613316329573bb8ae0; round=3; at=2026-10-02T04:58:48.127Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

<!-- auto-review: verdict=pass; hash=4cee4ab13ef4a878444a81b6987973e04ea76a9c5639331cbd13104a470adb56; design-hash=6d5513904887b6b8488cd8975af1499858299c9ec5507164f457e0c8cf86ec8e; round=4; at=2026-10-02T04:59:56.653Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=21; excluded=4; at=2026-10-02T05:00:28.077Z -->
