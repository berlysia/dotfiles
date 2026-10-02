# ADR-0023: Document Workflow の同一性（セッション・版・場所）を確定させる

## Status

accepted (2026-10-02)

## Context

Document Workflow の各部品（hook・`workflow-cli`・gate）が、「どのセッションの workflow か」「人間がどの版を承認したか」「どのディレクトリを基準にするか」を別々の情報源から決めていて、次の 4 件の障害が出ていた。

- **#197**: `/clear` の後の `workflow-cli` が、別セッションの承認済み plan を黙って書き換えた。CLI は env（`CLAUDE_SESSION_ID` / `DOCUMENT_WORKFLOW_DIR`）しか見られず、hook は入力の `session_id` を見る。両 env が同じ古いセッションを指していたので、env 同士の比較では検出できなかった。
- **#221**: 承認の後に plan を改訂しても、レビューを通し直せば再承認なしで実装に進めた。`Approval Status: approved` の行は model が書ける文書の 1 行で、人間の承認と model の書き込みを区別できなかった。
- **#209**: worktree に入る・`cd` するたびに、guard・CLI・`status` が別の workflow dir を見た。`## Files` の相対パスの基準も `status` と guard で違った。
- **#216**: worktree の中では `git-worktree-create` が失敗した。

V1 の実測（ユーザーが別ターミナルで実施）で、`/clear` の前後に `CLAUDE_CODE_SESSION_ID` は `3cfa34d0-…` から `2bb6382e-…` に追従した。hook の `session_id` も同じ値に追従する（CHANGELOG が一致を明記している）。`/resume` では ID が維持される。この実測が、CLI が `CLAUDE_CODE_SESSION_ID` を使う前提になった。同じ試行では `CLAUDE_ENV_FILE` 由来の `CLAUDE_SESSION_ID` も追従したので、#197 で古い値が残った経路は特定できていない。利用者側の配送を同一性に使わないという判断（K4）は、経路が特定できないまま維持した。

設計の全文とレビューの記録は、この変更のセッションの spec と plan（`.tmp/sessions/7d715a2f/`）にある。`.tmp/sessions/` は 7 日で GC されるので、判断と却下した代替案はこの ADR に書き切る。

## Decision

支配軸は正しさ（3 つの同一性を 1 つの情報源・1 つの関数に寄せる）で、次に安全性（承認を model の書き込みから切り離す）である。

- **K1（root は `getProjectRoot()` 1 つ）**: 優先順は `CLAUDE_TEST_CWD`（テスト専用）、`CLAUDE_PROJECT_DIR`、入力の cwd、`process.cwd()`。root を決める 9 個の hook が使い、ツール呼び出し時点の cwd を表す値（相対パスの解決）は別のまま残す。session.ts が `CLAUDE_PROJECT_DIR` を `CLAUDE_ENV_FILE` に export し、Bash でも同じ値が見える。
- **K2（`## Files` の基準）**: 相対エントリは、対象ファイルが属する同一リポジトリの worktree の toplevel からの相対で照合する。toplevel は root と一致するか、`.git` ファイルの `gitdir:` が `<root>/.git/worktrees/` の下を指すときだけ採用する。git は spawn しない。
- **K3（CLI の wfDir）**: `resolveWorkflowDir({ cwd: getProjectRoot(), sessionId: CLAUDE_CODE_SESSION_ID })` で決め、hook と同じ関数・同じ入力にする。`CLAUDE_CODE_SESSION_ID` が無いとき（人間のターミナル）は `--wf-dir` を必須にする。`--wf-dir` が解決値と違えば警告し、決定元を `source=override` にする。
- **K4（出力としての env を廃止）**: SessionStart は `CLAUDE_SESSION_ID` と `DOCUMENT_WORKFLOW_DIR` を export しない。wfDir は `workflow-cli dir`、セッション ID は `$CLAUDE_CODE_SESSION_ID` で得る。置き換えの漏れは `workflow-env-references` の検査テストで固定した。起動時 pin（`DOCUMENT_WORKFLOW_DIR=… claude`）は入力として残す。
- **K5（CLI の書き込み系）**: `stamp` / `triage` も素のファイル名だけを受け付ける。成功時は `wfDir=` / `source=` / `wrote=` を 1 行ずつ出す。
- **K6（gate の一本化）**: guard の判定を `workflow-gate.ts` の `evaluateDocument` / `evaluateTarget` に移し、`workflow-cli status <path>` が同じ結果を表示する。まず挙動を変えない移設として行った。
- **K7（承認は発話で記録）**: UserPromptSubmit の `approval-recorder` が、全体が `承認` / `approve` に任意の文書名と末尾の句点・感嘆符を足しただけの発話に反応する。承認待ちの文書がちょうど 1 件のときは名前なしで、それ以外は文書名を付けたときだけ記録する。記録は `approvals.log` への追記、承認行の書き換え、読み直しの確認の順で、同じ発話の繰り返しは冪等に完了する。`/execute-plan` は承認の操作から外した。
- **K8（`approvals.log` と gate の条件）**: 1 行 1 JSON（`{"v":1,"doc","hash","session","at"}`）で、読み手は同じ `doc` の最後の行だけを使う。gate は既存の 5 条件に「最新の承認 hash = 現在の文書 hash」を足す。`session` は監査用で照合しない。
- **K9（model による承認の書き込みを止める）**: guard が、wfDir の `.md` への Write / Edit / MultiEdit で承認済みの承認行を増やすもの、`.tmp/sessions` 配下の `approvals.log` への書き込みを deny する。位置づけは多層防御で、gate の安全性は K8 だけで成り立つ。
- **K10（file-access-guard）**: 解決済みの wfDir への書き込みを許可する。worktree の中で作業しても wfDir は repo root の外にあるため。
- **K11（`git-worktree-create`）**: `git rev-parse --path-format=absolute --git-common-dir` を基準にし、どの worktree からでも `<main>/.git/worktree/<branch>` に作る。
- **K12（文書）**: この ADR、ADR-0013 の Open observation items 1 の解消の追記、rules/workflow.md の承認の記述と Executive Summary の雛形、reference skill の承認と worktree の節。

### spec からの差

実装で次の点を spec から具体化・変更した。

- **名前を付けた承認は全か無か（K7 の具体化）**: spec は「文書名があればそれ」とだけ定めていた。名前を付けた文書がすべて承認以外の条件を満たすときだけ全部を記録し、1 つでも満たさなければ何も書かない。部分的な承認を作らないため。
- **文書名は大文字小文字を区別し、`approve` だけ区別しない（K7）**: macOS の大文字小文字を区別しないファイルシステムで `PLAN.MD` を読めてしまい、gate が照合しない名前で log に書くのを防ぐため。
- **出どころの判定（K7）**: UserPromptSubmit の入力の `source` が `user` か無いとき、かつ `agent_id` が無いときだけ記録する。それ以外は「記録していない」と返す。
- **返答の経路（K7）**: `additionalContext` に加えて `systemMessage` でも出す。利用者に直接見えるのは後者。
- **K9 は値でなく数で比べる**: 旧内容が承認済みの行を引用している（コードブロック、Reviewer Outputs の抜粋）とき、値の比較では本物の承認行を approved にする編集が素通りする。承認済みの承認行の数が旧内容より増える書き込みを deny する。承認行は先頭のハイフン欠落を許す寛容な形で数える。パスは realpath と大文字小文字を無視して比べる。判定の例外は fail-closed で deny にする。
- **K9 は全セッションの log を守る**: 自分のセッションに加えて `.tmp/sessions` の下のすべての `approvals.log` を対象にする。他のセッションの log を偽造して task-handoff で持ち込む経路も閉じる。
- **読めない log は gate を閉じたまま（K8）**: 同名のディレクトリ・権限・symlink のループで log が読めないとき、読み手は例外を投げず `readError` を返し、診断が `ledger-unreadable` と出す。例外を投げると guard の catch が fail-open で通すため。
- **`workflow-approval.ts` は葉のモジュール**: spec の Architecture 節にある `document-hash ← workflow-approval` の矢印は実際には不要だった。hash は gate が計算し、`workflow-approval.ts` は node の組込みだけに依存する。
- **K4 の検査テストの許可リストを狭めた**: Consequences 9 を参照。

### 却下した代替案

- **差分最小案（spec の Alternative Approaches 節）**: CLI の不一致警告の強化、`--wf-dir` の必須化、改訂時に承認行を `pending` に戻す無効化案、guard の `## Files` 解決だけを `CLAUDE_PROJECT_DIR` 基準にする案、`--git-common-dir` への変更だけの #216 対応。警告の強化は、両 env が同じ古いセッションを指す障害を env 同士の比較では検出できない。`--wf-dir` の必須化は、その dir を model が知る手段が古くなりうる env しかない。無効化案は #221 の経路は塞ぐが、承認行を approved にする操作が model の書き込みのまま残り、人間の承認と区別できない。
- **承認の経路の候補**:
  - 承認行を model が書く現行のままで、hash だけを記録する案: 人間が見ていない状態で model が承認を成立させられる点が変わらない。
  - `/execute-plan` を承認として残す案: 承認と実装の開始が 1 つの操作になり、承認した版を特定できない。承認は発話で、`/execute-plan` は承認の後に実装を始める操作に分けた。
  - 承認行を人間が手で書き換える案: 版に結びつかず（#221 の経路が残る）、人間の操作が増える。

## Consequences

1. **配備後は Claude Code を起動し直す**（spec R6）: 配備前のセッションの Bash env には旧 SessionStart の `DOCUMENT_WORKFLOW_DIR` が残り、`CLAUDE_PROJECT_DIR` は無いので CLI は失敗する。rules/workflow.md の古い記述も context に残るので、起動し直すまで model の書き込み先を信用しない。
2. **進行中の workflow の再承認**（spec R1）: 配備前の承認は log に無いので gate が止める。診断の指示どおり会話で「承認 <文書名>」と書けば戻る。互換の例外は設けない。
3. **承認の後に hook が文書を書き換える**: model の次の Edit が「読み込み後に変更された」で失敗しうる。読み直せばよい。
4. **task-handoff の複製でも承認が引き継がれる**: log の `session` は照合に使わない。文書が同じ版なら承認は有効。
5. **人間による手動の再承認**: 取り消した後で人間が承認行を手で approved に戻すと、log の最新 hash が一致していれば再発話なしで通る。model には K9 でできない。
6. **log の `v` を上げるときは読み手を先に配備する**: 読み手は `v !== 1` の行を読み飛ばして `ignored-lines` を出す。書き手だけを先に上げると、すべての承認が読み飛ばされる。
7. **`ignored-lines` と `ledger-unreadable` を診断に必ず出す**: 読み飛ばした行や読めない log を黙って捨てない理由。読めない log は gate を閉じたままにする（例外にすると guard が fail-open で通すため）。
8. **`CLAUDE_PROJECT_DIR` は export し続ける**: Bash の env に残る値だが、`/clear` をまたいでも同じプロジェクトを指すので #197 の取り違えは起きない。`CLAUDE_TEST_CWD` が本番に漏れると優先される点は followups 課題 E で追跡中。
9. **K4 の検査テストの許可リストを spec から狭めた**: spec は 4 か所を挙げたが、禁止形を含むのは guard の docstring 2 か所だけだった（session.ts と workflow-resolve.ts は `process.env.…` で禁止形に当たらず、unified-audio-config.ts は走査の対象外）。
10. **spec K1 の「11 ファイル」と実際に置き換えた 9 ファイルの差**: plan-review-automation と file-access-guard はツール cwd の用途しか持たなかった（file-access-guard は K10 で `getProjectRoot()` を新たに使う）。
11. **Bash による log への追記は止めない**（spec R4）: 不注意な逸脱を止める仕組みで、意図的な迂回への耐性は主張しない。
12. **出どころの判定は `source` に頼る**: 公式ドキュメントの UserPromptSubmit の入力には載っていないが、cc-hooks-ts 2.1.281 の型にある `source` が `user` か無いときだけ記録する。値が無い古い Claude Code では予約したプロンプトを区別できない。model が「承認」だけのプロンプトを予約するのは意図的な迂回で R4 の外。サブエージェントの中の発火（`agent_id` あり）も記録しない。配備後の実測（2026-10-02、Claude Code 2.1.287、配備後に起動したセッション 1 つ）:
    - `CronCreate` で予約した「承認」（承認待ち 0 件）は、`source=…` の分岐に入らず「承認を待っている文書が無い」と返った（実測、1 件。発火が予約から来たことは、ジョブが消えていたことと、その時間帯の recorder の発火がその 1 件だけだったことで確かめた）。この経路の `source` は `user` か値なしで届いている（返答の文面と分岐のコードからの推論）。承認待ちがあれば記録されるというのはコードからの推論で、実測していない。`/loop` と `ScheduleWakeup` も後で測った（followups 課題 J「実測の補完」の表）。2.1.287 では、利用者が打ったプロンプトも予約が発火させたプロンプトも `source` は値なしで届き、`source` では区別できない。
    - Remote Control 経由でデスクトップアプリから打った「承認」も、同じ返答だった（hook の発火と返答は実測、どこから打ったかは利用者の申告）。
    - 承認待ちが 1 件（その作業自身の plan.md）の状態で、利用者がターミナルから `approve` と打つと、`approvals.log` が無い状態から 1 行になり、その `hash` は直前に `workflow-cli status` で控えた hash と一致した。承認行は `approved` に書き換わり、gate の 6 条件がすべてそろった（実測）。`[approval-recorder] …` の `systemMessage` が利用者の画面に出た（利用者の申告）。
    - 上の経路で `source` が `user` だったか値なしだったかは、この時点では hook-timer が `source` を記録していなかったので実測できていない。後で hook-timer に記録させて測った結果は followups 課題 J「実測の補完」にある（利用者が打った「承認」も値なし）。
    - 改訂（2026-10-02 の測定を受けた 2026-10-03 の決定）: 下の「改訂（2026-10-03）」節を参照。この項目の前提のうち「値が無いのは古い Claude Code」は成り立たない。
13. **文書名なしの「承認」は、承認待ちが 1 件なら別の話題への返事でも記録される**（spec R7）: 記録したら対象・hash・取り消し方を `additionalContext` と `systemMessage` で必ず伝える。

## 改訂（2026-10-03）: 予約したプロンプトの承認（課題 J）

Consequences 12 の前提を訂正し、予約したプロンプトの扱いを決め直す。Consequences 12 の本文は残し、ここに追記する。測定の詳細は `docs/plans/workflow-guard-followups.md` 課題 J の表（M0〜M4）にある。

### 前提の訂正

Consequences 12 は「値が無いのは古い Claude Code」とし、予約したプロンプトを区別できない場合を R4 の外に置いた。Claude Code 2.1.287 の実測では、利用者が打ったプロンプト（M0）も、`CronCreate`・`/loop`・`ScheduleWakeup` の発火（M1〜M4）も、UserPromptSubmit の入力の `source` は値なしで届いた。値が無いのは古いからではなく、この版の通常の状態である。`source` では利用者の入力と予約の発火を区別できない。

### 決定

`document-workflow-guard` が、`CronCreate` と `ScheduleWakeup` の PreToolUse で、`prompt` が承認の形のものを deny する。記録の仕組み（K7）と gate（K8）は変えない。

- KD1: deny は guard に置く。K9 の延長で、承認の発話を model が作ることを止める位置づけである。予約 2 ツールの経路に限った防御で、この経路では recorder が発火時に区別できないので、ほかに層は無い。新しい hook は作らず、guard の `GUARDED_TOOLS` と settings の matcher の同期検査をそのまま使う
- KD2: wfDir や workflow の状態に関係なく deny する。承認待ちの文書の有無は、予約の時点と発火の時点で変わりうる。判定は文面だけで行い、wfDir の解決の前に置く
- KD3: `parseApprovalUtterance` を `lib/workflow-approval.ts` に移し、recorder と guard が同じ関数を使う。guard が implementation を import しないため
- KD7: 判定は recorder より緩める。`parseApprovalUtterance` に加えて、NFKC 正規化と `\p{Cf}`（ZWSP・BOM など）の除去をした文面でも判定し、どちらかが承認の形なら deny する。発火時に Claude Code が文面を変えても拾うためで、緩めた分の誤 deny は許容する
- KD8: 予約の分岐は fail-closed にする。guard 全体の catch は fail-open なので、分岐は自分の try を持ち、判定中の例外は deny にする。`tool_input` が object でない、または `prompt` が文字列でないときは、予約される文面が無いので allow

根拠（実測）: `prompt: "承認"` の `CronCreate` は、auto-approve の Layer 2a（静的ルール）が allow し、Layer 2b（LLM evaluator）も allow した。後者の理由は「automating personal plan approvals」だった。permission の層は、承認の形のプロンプトの予約を止めるどころか、正当な作業として通している。PreToolUse に `prompt` が載ることは、auto-approve の PreToolUse の記録（`decisions.jsonl`）で確かめた。予約の文面と発火したプロンプトの文面は M1〜M3 で一致した。

却下した案:

- 課題 J の (b)（記録を transcript が書き出された後へ移す）: 公式ドキュメントは transcript の書き出しが遅れうると書き、書き出しの時点を保証しない。`turnOrigin` / `promptSource` は文書にも CHANGELOG にも無い。承認の 1 経路を、文書が否定するタイミングと文書化されていない形式に依拠させることになる
- 課題 J の (c)（AskUserQuestion の回答で受け取る）: 利用者の操作が変わり（任意の時点で「承認」と打てなくなる）、rules/workflow.md・Executive Summary の Next Action・reference skill・`/execute-plan` の案内が連動して変わる。Remote Control 経由の表示と回答の到達は実測で確かめたので、却下の理由ではない。PostToolUse の `tool_response.answers` は未実測のまま残る

### Consequences

- 利用者自身が打つ `/loop 5m 承認` も deny される。承認は 1 回の発話で済み、繰り返す用途は無い。deny の理由に、会話で打つよう書く
- 調べていない入口は閉じたと主張しない。`RemoteTrigger`、Monitor の通知、Bash から `claude` を起動する経路である。`RemoteTrigger` がクラウドの別セッションで実行され、本セッションの recorder に届かないというのは推論で、実測していない。Bash 経由は R4 と同列である
- 発火時の変換が KD7 の正規化の範囲を超えると、予約の時点では拾えない。実測（M1〜M3）では予約と発火の文面に差は無かった
- 再訪の条件: PreToolUse で文面を見られない入口が見つかったとき、または未調査の入口で承認の形のプロンプトが UserPromptSubmit に届くと分かったとき。そのときは (c) を、PostToolUse の `answers` を実測してから再検討する
- 計装の扱い（KD4）: recorder の返答に付けていた `probe:` 行（`lib/prompt-origin-probe.ts`）は外した。答えようとした問い（recorder の実行時点で transcript の行が読めるか）に「読めない」と答えが出て、(b) を採らないので再測定の予定も無いため。hook-timer の `source` / `prompt_id` の射影は残す。課題 J の再訪のきっかけ（Claude Code を更新して測定をやり直す）で、`source` に値が入り始めたかを見る手段がこれだけだから。プロンプト本文は残さず、文字列を 64 文字で切る
- recorder の `source` の判定は残す（KD5）。2.1.287 では区別に使えないが、`user` 以外の値が来たときに記録しない挙動は害が無く、版が上がって値が届けば効く

## 改訂（2026-10-03）: AskUserQuestion による承認の経路

前の節で却下した課題 J の (c)（承認を AskUserQuestion の回答で受け取る）を、発話の経路を残したまま足す形で採る。前の節の本文は残し、ここに追記する。

### 却下理由の解消

前の節は (c) を 2 つの理由で却下した。

- 「利用者が任意の時点で `承認` と打てなくなる」: 発話の経路を残して AskUserQuestion の経路を足すので、成り立たない。質問をキャンセルして議論し、済んだら `approve` と打てる。
- 「PostToolUse の `tool_response.answers` が未実測」: 次のとおり実測した（2026-10-03、本セッション、AskUserQuestion の PreToolUse / PostToolUse の入力を書き出す一時 hook を利用者が置いて測った。各 1 試行）。

| 試行 | 操作                                                      | PreToolUse の `tool_input.answers` | PostToolUse の `tool_response.answers` | PostToolUse |
| ---- | --------------------------------------------------------- | ---------------------------------- | -------------------------------------- | ----------- |
| T2   | model が `answers` に `A` を先に入れ、利用者が `B` を選ぶ | `A`（model の値）                  | `B`（利用者の回答）                    | 発火        |
| T3   | multiSelect で 2 つ選ぶ                                   | なし                               | `"spec.md, plan-1.md"`                 | 発火        |
| T4   | Esc でキャンセル                                          | なし                               | —                                      | 発火しない  |

T2 では PostToolUse の `tool_input.answers` も `B` だった。`tool_response.questions` には表示した質問（`question` / `header` / `options` の `label`・`description` / `multiSelect`）がそのまま載り、入力に無いキーは足されなかった。

きっかけは利用者の指摘で、承認待ちが 2 件以上のときに `承認 spec.md plan-3.md` という完全一致の文字列を打つ必要があり、「手で打てない完全一致は使えないのと同じ」だった。

### 決定

- 記録は新しい PostToolUse hook `approval-answer-recorder` が `tool_response` だけを読んで行う。`tool_input` は承認の根拠にも veto にも使わない（T2 で、PostToolUse の `tool_input.answers` に利用者の回答が入っていたため、veto にすると正規の承認が記録されなくなる）。
- 質問は `workflow-cli ask-approval` が生成する（固定文・`header`・文書名の `label`・`hash=<12 桁>` の `description`・`承認しない`）。recorder は記録時点の状態から質問を作り直し、`tool_response.questions` と深い等価で一致したときだけ記録する。質問の文面を model が自由に書けると表示を偽れるため、生成物との完全一致を求める。完全一致は model も手で写せないので、生成を CLI に任せる。
- 1 回の呼び出しに質問は 1 つ、文書は 3 件まで。`answers` は質問文がキーの map なので、同じ質問文を並べられない。
- 記録しない条件（すべて記録しない側に倒す）: 応答に `questions` / `answers` / `annotations` 以外のキーがある（`afkTimeoutMs`・`response` を含む）/ サブエージェントの中 / 文書名が `^(spec|plan|plan-[1-9][0-9]*)\.md$` でない・重複・候補に無い / 作り直した質問と一致しない / 回答が正規の `label` と一致しない / `承認しない` と文書の併選 / `annotations` に `notes` がある。返答は種類ごとに分け、`承認しない` は失敗でなく辞退として返す。
- 照合は全か無か、記録は文書ごと。途中で失敗した文書は `ask-approval` を呼び直すと質問に戻る。
- `approvals.log` の行に `via`（`utterance` / `ask`）を足し、`workflow-cli status` が表示する。gate は経路を区別しないので、監査のために残す。読み手は知らないキーを無視するので `v` は 1 のまま。
- guard は承認らしい質問に `answers` / `annotations` があれば PreToolUse で deny する（多層防御。判定の例外時も、`answers` / `annotations` があれば deny）。`AskUserQuestion` を `GUARDED_TOOLS` に足し、guard のローカルの集合は lib に一本化した。spec は `GUARDED_TOOLS_FOR_TESTING` を残すとしていたが、一本化の後は一致の検査が常に通るので削除し、代わりにテンプレートの matcher が `GUARDED_TOOLS` を覆うことをテストする。
- 文書名なしの `approve` で承認待ちが 2 件以上なら、記録せずに model に `ask-approval` で聞き直させる。全部を承認する案は、議論の結果一部だけ直すことが普通にあるので採らない。
- SessionStart の監査が PostToolUse の recorder の登録も報告する。`workflow-cli triage` の成功時に次の一手として `ask-approval` を出す。
- rules/workflow.md は容量の上限を上げず、5.3 段落を縮めて両経路の記述と「判断を求める点が複数あるときは AskUserQuestion でまとめて聞く」を入れた。

### 信頼の根の移動

承認の根拠が「利用者が打った文字列」から「model が出した UI への利用者のクリック」に変わる。生成物との完全一致で、利用者が見る文面は CLI が決めたものだけになる。ただし、質問に載せる文書の集合と順序は model が選べ、保証されるのは「利用者の選択を経由した」ことだけである。複数の文書を 1 クリックで承認できることは、オーダーの「一気に承認する」の裏返しとして受け入れた。記録の後に文書と hash を `systemMessage` で利用者に見せる。`承認しない` は記録に残らず、過去の版への承認も取り消さない（取り消しは承認行を pending に戻す、のまま）。

### Consequences

- 起動済みのセッションに hook の変更が入らないのは従来どおりである（前の節までの hook の変更と同じ）。この変更に固有なのは、`workflow-cli` は呼ぶたびに読まれて `chezmoi apply` の直後から新しい挙動になるが、hook の登録は起動時にしか読まれない、というずれである。起動済みのセッションで `ask-approval` を使うと、回答しても記録されない。`ask-approval` の標準エラーの注意と、`approve` の発話で回復できる。
- 実測は各 1 試行である。配備後に新しいセッションで同じ確認を行う（下の「配備後の確認」）。
- 非対話の実行（`claude -p`、SDK、CI）で host が回答を返す経路の `tool_response` は未実測で、閉じたとは主張しない。知らないキーがあれば記録しないので、残るのは host が対話と同じ形で回答を返す場合である。CI の自律レーンは設計面に触れない（autonomous-lane C3）ので承認を行う場面は無いが、これは規約による。
- UI を通らずに model の `answers` が結果になる経路（PermissionRequest の hook が `answers` を返すなど）は未実測である。guard の deny で多層に止め、permission の層に AskUserQuestion の入力を書き換えるものが無いことは確認した。
- サブエージェントの中の AskUserQuestion に `agent_id` が載るかは未実測で、載らなければサブエージェントの出した承認の質問への回答も記録される。利用者が CLI の生成した文面を見て選んだことは保証されるので、受け入れた。
- 承認の依頼の発火点（rule と triage の出力）は助言で、強制しない。model が質問を出さなくても発話の経路で承認できる。Stop hook で強制する案は誤発火が多く採らない。
- 実装の教訓: hook を足すタスクと settings に配線するタスクを分けたため、その間のコミット（4 つ）で `hook-target-drift.test.ts`（hook の実装と settings の対応の検査）が落ちていた。計画の時点では grep で該当するテストを探したが、個々の hook の名前を含まない検査は見つからなかった。途中のコミットでテストが通るかは、段階ごとに実際に走らせて確かめる方が確実である。
- 再訪の条件: Claude Code の更新で `tool_response` の形が変わったとき（記録しない側に倒れるので、配備後の確認と同じ手順で測り直す）。

### 配備後の確認（2026-10-03、Claude Code 2.1.288）

`chezmoi apply` の後に、使い捨ての repo で起動した新しいセッションで確かめた。承認の記録は `approvals.log` の行数で判定した。fixture（承認待ちの spec.md と plan-1.md）は test-helpers の関数で作った。

| 確認                                                                   | 結果               | 根拠                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SessionStart の監査と `/hooks` の表示                                  | 不合格（表示のみ） | 監査の関数を直接呼ぶと guard と recorder の両方が covers を返し、recorder は下の確認で実際に記録した。画面には監査の行が出ず、`/hooks` にも PostToolUse の `AskUserQuestion` が出なかった。原因は未確認 |
| `ask-approval` の質問で 2 件、続けて 1 件を選ぶ                        | 合格               | 0→2→3 行、すべて `via:"ask"`。`workflow-cli status` に `via=ask`                                                                                                                                        |
| model が `answers` を入れた承認の質問                                  | 合格               | guard が deny。行数は変わらない                                                                                                                                                                         |
| CLI を通さずに言い換えた質問 / description の hash を 1 文字変えた質問 | 合格               | 「形と違う」の返答。行数は変わらない                                                                                                                                                                    |
| 一般の質問に `answers`                                                 | 合格               | deny されない                                                                                                                                                                                           |
| Esc でキャンセル                                                       | 合格               | 行数は変わらず、文書は候補に残る                                                                                                                                                                        |
| 承認待ち 2 件で素の `approve`                                          | 合格               | 記録されず、model が `ask-approval` の質問を出し、選んだ 2 件が記録された（3→5 行）                                                                                                                     |

戻さないことにした。承認の経路は不変条件まで実機で通り、不合格は表示の 1 点だけだからである。未解決の 2 件は別の作業にする。

- SessionStart の監査の行が画面に出ない（`systemMessage` の 2 行目以降が表示されていない可能性があるが、確かめていない）。
- 配備後の確認の手順の欠陥: fixture を作る 1 行は `workflow-cli dir` で wfDir を求めるが、`CLAUDE_PROJECT_DIR` はセッションの中でしか設定されないので、利用者のシェルでは wfDir が得られず中断する。確認では wfDir を直接指定して作った。

この改訂の設計の全文（実測の生の記録、却下した代替案、各ラウンドのレビュー指摘、タスクごとのテスト設計）: `docs/plans/approval-ask/`

## References

- 設計の全文: `docs/plans/workflow-identity/`（research / spec / plan-1〜5。レビューの記録を含む）
- `docs/decisions/0013-workflow-dir-session-derivation.md`（Open observation items 1 を本 ADR で解消）
- Issue #197 / #221 / #209 / #216
- 実装: ブランチ `fix/workflow-identity`（PR で master に取り込む）
