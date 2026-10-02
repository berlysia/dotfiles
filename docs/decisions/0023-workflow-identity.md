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
13. **文書名なしの「承認」は、承認待ちが 1 件なら別の話題への返事でも記録される**（spec R7）: 記録したら対象・hash・取り消し方を `additionalContext` と `systemMessage` で必ず伝える。

## References

- 設計の全文: `docs/plans/workflow-identity/`（research / spec / plan-1〜5。レビューの記録を含む）
- `docs/decisions/0013-workflow-dir-session-derivation.md`（Open observation items 1 を本 ADR で解消）
- Issue #197 / #221 / #209 / #216
- 実装: ブランチ `fix/workflow-identity`（PR で master に取り込む）
