# ADR-0023: Document Workflow の同一性（セッション・版・場所）を確定させる

## Status

accepted (2026-10-02)。予約したプロンプトの承認、AskUserQuestion による承認の経路、plan-N の承認の委任（ADR-0028）、承認の質問の作業の識別と文書の題を Amendments で足した。

## Context

Document Workflow の各部品（hook・`workflow-cli`・gate）が、「どのセッションの workflow か」「人間がどの版を承認したか」「どのディレクトリを基準にするか」を別々の情報源から決めていて、次の 4 件の障害が出ていた。

- **#197**: `/clear` の後の `workflow-cli` が、別セッションの承認済み plan を黙って書き換えた。CLI は env（`CLAUDE_SESSION_ID` / `DOCUMENT_WORKFLOW_DIR`）しか見られず、hook は入力の `session_id` を見る。両 env が同じ古いセッションを指していたので、env 同士の比較では検出できなかった。
- **#221**: 承認の後に plan を改訂しても、レビューを通し直せば再承認なしで実装に進めた。`Approval Status: approved` の行は model が書ける文書の 1 行で、人間の承認と model の書き込みを区別できなかった。
- **#209**: worktree に入る・`cd` するたびに、guard・CLI・`status` が別の workflow dir を見た。`## Files` の相対パスの基準も `status` と guard で違った。
- **#216**: worktree の中では `git-worktree-create` が失敗した。

別ターミナルでの実測で、`/clear` の前後に `CLAUDE_CODE_SESSION_ID` は新しいセッションの値に追従し、hook の `session_id` も同じ値に追従した（CHANGELOG も一致を明記している）。`/resume` では ID が維持される。この実測が、CLI が `CLAUDE_CODE_SESSION_ID` を使う前提になった。同じ試行では `CLAUDE_ENV_FILE` 由来の `CLAUDE_SESSION_ID` も追従したので、#197 で古い値が残った経路は特定できていない。利用者側の配送を同一性に使わないという判断（K4）は、経路が特定できないまま維持した。

## Decision

支配軸は正しさ（3 つの同一性を 1 つの情報源・1 つの関数に寄せる）で、次に安全性（承認を model の書き込みから切り離す）である。

- **K1（root は `getProjectRoot()` 1 つ）**: 優先順は `CLAUDE_TEST_CWD`（テスト専用）、`CLAUDE_PROJECT_DIR`、入力の cwd、`process.cwd()`。root を決める 9 個の hook が使い、ツール呼び出し時点の cwd を表す値（相対パスの解決）は別のまま残す。session.ts が `CLAUDE_PROJECT_DIR` を `CLAUDE_ENV_FILE` に export し、Bash でも同じ値が見える。
- **K2（`## Files` の基準）**: 相対エントリは、対象ファイルが属する同一リポジトリの worktree の toplevel からの相対で照合する。toplevel は root と一致するか、`.git` ファイルの `gitdir:` が `<root>/.git/worktrees/` の下を指すときだけ採用する。git は spawn しない。
- **K3（CLI の wfDir）**: `resolveWorkflowDir({ cwd: getProjectRoot(), sessionId: CLAUDE_CODE_SESSION_ID })` で決め、hook と同じ関数・同じ入力にする。`CLAUDE_CODE_SESSION_ID` が無いとき（人間のターミナル）は `--wf-dir` を必須にする。`--wf-dir` が解決値と違えば警告し、決定元を `source=override` にする。
- **K4（出力としての env を廃止）**: SessionStart は `CLAUDE_SESSION_ID` と `DOCUMENT_WORKFLOW_DIR` を export しない。wfDir は `workflow-cli dir`、セッション ID は `$CLAUDE_CODE_SESSION_ID` で得る。置き換えの漏れは `workflow-env-references` の検査テストで固定した。起動時 pin（`DOCUMENT_WORKFLOW_DIR=… claude`）は入力として残す。
- **K5（CLI の書き込み系）**: `stamp` / `triage` も素のファイル名だけを受け付ける。成功時は `wfDir=` / `source=` / `wrote=` を 1 行ずつ出す。
- **K6（gate の一本化）**: guard の判定を `workflow-gate.ts` の `evaluateDocument` / `evaluateTarget` に移し、`workflow-cli status <path>` が同じ結果を表示する。まず挙動を変えない移設として行った。
- **K7（承認は発話で記録）**: UserPromptSubmit の `approval-recorder` が、全体が `承認` / `approve` に任意の文書名と末尾の句点・感嘆符を足しただけの発話に反応する。承認待ちの文書がちょうど 1 件のときは名前なしで、それ以外は文書名を付けたときだけ記録する。記録は `approvals.log` への追記、承認行の書き換え、読み直しの確認の順で、同じ発話の繰り返しは冪等に完了する。`/execute-plan` は承認の操作から外した。
  - 名前を付けた承認は全か無か: 名前を付けた文書がすべて承認の条件を満たすときだけ全部を記録し、1 つでも満たさなければ何も書かない。部分的な承認を作らないため。
  - 文書名は大文字小文字を区別し、`approve` だけ区別しない: macOS の大文字小文字を区別しないファイルシステムで `PLAN.MD` を読めてしまい、gate が照合しない名前で log に書くのを防ぐため。
  - 出どころ: UserPromptSubmit の入力の `source` が `user` か無く、かつ `agent_id` が無いときだけ記録する。それ以外は「記録していない」と返す。返答は `additionalContext` に加えて `systemMessage` でも出す（利用者に直接見えるのは後者）。
- **K8（`approvals.log` と gate の条件）**: 1 行 1 JSON（`{"v":1,"doc","hash","session","at"}`）で、読み手は同じ `doc` の最後の行だけを使う。gate は既存の 5 条件に「最新の承認 hash = 現在の文書 hash」を足す。`session` は監査用で照合しない。log が読めないとき（同名のディレクトリ・権限・symlink のループ）は、読み手が例外を投げず `readError` を返し、診断が `ledger-unreadable` と出して gate を閉じたままにする。例外を投げると guard の catch が fail-open で通すため。
- **K9（model による承認の書き込みを止める）**: guard が、wfDir の `.md` への Write / Edit / MultiEdit で承認済みの承認行を増やすもの、`.tmp/sessions` 配下の `approvals.log` への書き込みを deny する。位置づけは多層防御で、gate の安全性は K8 だけで成り立つ。承認行は値でなく数で比べる（旧内容が承認済みの行を引用しているとき、値の比較では本物の承認行を approved にする編集が素通りする）。数えるときは先頭のハイフン欠落を許す寛容な形で数え、パスは realpath と大文字小文字を無視して比べ、判定の例外は fail-closed で deny にする。自分のセッションに加えて `.tmp/sessions` の下のすべての `approvals.log` を対象にし、他のセッションの log を偽造して task-handoff で持ち込む経路も閉じる。
- **K10（file-access-guard）**: 解決済みの wfDir への書き込みを許可する。worktree の中で作業しても wfDir は repo root の外にあるため。
- **K11（`git-worktree-create`）**: `git rev-parse --path-format=absolute --git-common-dir` を基準にし、どの worktree からでも `<main>/.git/worktree/<branch>` に作る。
- **K12（文書）**: この ADR、ADR-0013 の Open observation items 1 の解消の追記、rules/workflow.md の承認の記述と Executive Summary の雛形、reference skill の承認と worktree の節。

## 却下した代替案

- **差分最小案**: CLI の不一致警告の強化、`--wf-dir` の必須化、改訂時に承認行を `pending` に戻す無効化案、guard の `## Files` 解決だけを `CLAUDE_PROJECT_DIR` 基準にする案、`--git-common-dir` への変更だけの #216 対応。警告の強化は、両 env が同じ古いセッションを指す障害を env 同士の比較では検出できない。`--wf-dir` の必須化は、その dir を model が知る手段が古くなりうる env しかない。無効化案は #221 の経路は塞ぐが、承認行を approved にする操作が model の書き込みのまま残り、人間の承認と区別できない。
- **承認行を model が書く現行のままで、hash だけを記録する案**: 人間が見ていない状態で model が承認を成立させられる点が変わらない。
- **`/execute-plan` を承認として残す案**: 承認と実装の開始が 1 つの操作になり、承認した版を特定できない。承認は発話で、`/execute-plan` は承認の後に実装を始める操作に分けた。
- **承認行を人間が手で書き換える案**: 版に結びつかず（#221 の経路が残る）、人間の操作が増える。

## Consequences

1. **配備後は Claude Code を起動し直す**: 配備前のセッションの Bash env には旧 SessionStart の `DOCUMENT_WORKFLOW_DIR` が残り、`CLAUDE_PROJECT_DIR` は無いので CLI は失敗する。rules/workflow.md の古い記述も context に残るので、起動し直すまで model の書き込み先を信用しない。
2. **進行中の workflow の再承認**: 配備前の承認は log に無いので gate が止める。診断の指示どおり会話で「承認 <文書名>」と書けば戻る。互換の例外は設けない。
3. **承認の後に hook が文書を書き換える**: model の次の Edit が「読み込み後に変更された」で失敗しうる。読み直せばよい。
4. **task-handoff の複製でも承認が引き継がれる**: log の `session` は照合に使わない。文書が同じ版なら承認は有効。
5. **人間による手動の再承認**: 取り消した後で人間が承認行を手で approved に戻すと、log の最新 hash が一致していれば再発話なしで通る。model には K9 でできない。
6. **log の `v` を上げるときは読み手を先に配備する**: 読み手は `v !== 1` の行を読み飛ばして `ignored-lines` を出す。書き手だけを先に上げると、すべての承認が読み飛ばされる。
7. **`ignored-lines` と `ledger-unreadable` を診断に必ず出す**: 読み飛ばした行や読めない log を黙って捨てない理由。読めない log は gate を閉じたままにする（例外にすると guard が fail-open で通すため）。
8. **`CLAUDE_PROJECT_DIR` は export し続ける**: Bash の env に残る値だが、`/clear` をまたいでも同じプロジェクトを指すので #197 の取り違えは起きない。`CLAUDE_TEST_CWD` が本番に漏れると優先される点は followups 課題 E で追跡中。
9. **K4 の検査テストの許可リスト**: 禁止形を含むのは guard の docstring 2 か所だけで、許可リストはその範囲に限る。
10. **K1 が置き換えるのは 9 個の hook**: plan-review-automation と file-access-guard はツール cwd の用途しか持たない（file-access-guard は K10 で `getProjectRoot()` を新たに使う）。
11. **Bash による log への追記は止めない**: 不注意な逸脱を止める仕組みで、意図的な迂回への耐性は主張しない。
12. **出どころの判定は `source` に頼る**: 公式ドキュメントの UserPromptSubmit の入力には載っていないが、cc-hooks-ts 2.1.281 の型にある `source` が `user` か無いときだけ記録する。サブエージェントの中の発火（`agent_id` あり）も記録しない。model が「承認」だけのプロンプトを予約するのは意図的な迂回で、当初は耐性の外に置いた。当初の前提「値が無いのは古い Claude Code」は実測で成り立たなかったため、予約の経路は Amendments の「改訂（2026-10-03）: 予約したプロンプトの承認（課題 J）」で扱う。測定（Claude Code 2.1.287）では、利用者が打った「承認」も、Remote Control 経由の「承認」も、予約の発火も、`source` は値なしで届き、`source` では区別できない。承認待ちが 1 件の状態で利用者がターミナルから `approve` と打つと、`approvals.log` に 1 行が付き、その `hash` は `workflow-cli status` の hash と一致し、gate の 6 条件がそろった。
13. **文書名なしの「承認」は、承認待ちが 1 件なら別の話題への返事でも記録される**: 記録したら対象・hash・取り消し方を `additionalContext` と `systemMessage` で必ず伝える。

## Amendments

### 改訂（2026-10-03）: 予約したプロンプトの承認（課題 J）

Consequences 12 の前提を訂正し、予約したプロンプトの扱いを決め直す。Consequences 12 の本文は残す。測定の詳細は `docs/plans/workflow-guard-followups.md` 課題 J の表（M0〜M4）にある。

- **前提の訂正**: Claude Code 2.1.287 の実測では、利用者が打ったプロンプト（M0）も、`CronCreate`・`/loop`・`ScheduleWakeup` の発火（M1〜M4）も、UserPromptSubmit の入力の `source` は値なしで届いた。値が無いのは古いからではなく、この版の通常の状態である。
- **決定**: `document-workflow-guard` が、`CronCreate` と `ScheduleWakeup` の PreToolUse で、`prompt` が承認の形のものを deny する。記録の仕組み（K7）と gate（K8）は変えない。
  - KD1: deny は guard に置く。K9 の延長で、承認の発話を model が作ることを止める位置づけである。予約 2 ツールの経路に限った防御で、この経路では recorder が発火時に区別できないので、ほかに層は無い。
  - KD2: wfDir や workflow の状態に関係なく deny する。承認待ちの文書の有無は、予約の時点と発火の時点で変わりうる。判定は文面だけで行い、wfDir の解決の前に置く。
  - KD3: `parseApprovalUtterance` を `lib/workflow-approval.ts` に移し、recorder と guard が同じ関数を使う。guard が implementation を import しないため。
  - KD7: 判定は recorder より緩める。`parseApprovalUtterance` に加えて、NFKC 正規化と `\p{Cf}`（ZWSP・BOM など）の除去をした文面でも判定し、どちらかが承認の形なら deny する。緩めた分の誤 deny は許容する。
  - KD8: 予約の分岐は fail-closed にする。guard 全体の catch は fail-open なので、分岐は自分の try を持ち、判定中の例外は deny にする。`tool_input` が object でない、または `prompt` が文字列でないときは、予約される文面が無いので allow。
- **根拠**: `prompt: "承認"` の `CronCreate` は、auto-approve の Layer 2a（静的ルール）が allow し、Layer 2b（LLM evaluator）も allow した。permission の層は、承認の形のプロンプトの予約を止めるどころか、正当な作業として通している。予約の文面と発火したプロンプトの文面は一致した。
- **却下した案**: 課題 J の (b)（記録を transcript が書き出された後へ移す）は、公式ドキュメントが transcript の書き出しの遅れを許し、`turnOrigin` / `promptSource` が文書にも CHANGELOG にも無いので、承認の 1 経路を保証の無いタイミングと形式に依拠させることになる。課題 J の (c)（AskUserQuestion の回答で受け取る）は、この時点では利用者の操作が変わるうえ連動する文書が多いので却下し、次の改訂で採った。
- **Consequences**:
  - 利用者自身が打つ `/loop 5m 承認` も deny される。承認は 1 回の発話で済み、繰り返す用途は無い。deny の理由に、会話で打つよう書く。
  - 調べていない入口は閉じたと主張しない。`RemoteTrigger`（クラウドの別セッションで実行され本セッションの recorder に届かない、というのは推論で未実測）、Monitor の通知、Bash から `claude` を起動する経路（R4 と同列）である。
  - 発火時の変換が KD7 の正規化の範囲を超えると、予約の時点では拾えない。実測では予約と発火の文面に差は無かった。
  - 再訪の条件: PreToolUse で文面を見られない入口が見つかったとき、または未調査の入口で承認の形のプロンプトが UserPromptSubmit に届くと分かったとき。
  - KD4: recorder の返答に付けていた `probe:` 行は外した。答えようとした問い（recorder の実行時点で transcript の行が読めるか）に「読めない」と答えが出て、(b) を採らないので再測定の予定も無いため。hook-timer の `source` / `prompt_id` の射影は、Claude Code の更新で `source` に値が入り始めたかを見る手段がこれだけなので残す（プロンプト本文は残さず、文字列を 64 文字で切る）。
  - KD5: recorder の `source` の判定は残す。2.1.287 では区別に使えないが、`user` 以外の値が来たときに記録しない挙動は害が無く、版が上がって値が届けば効く。

### 改訂（2026-10-03）: AskUserQuestion による承認の経路

前の改訂で却下した (c)（承認を AskUserQuestion の回答で受け取る）を、発話の経路を残したまま足す形で採る。

- **却下理由の解消**: 「任意の時点で `承認` と打てなくなる」は、発話の経路を残すので成り立たない（質問をキャンセルして議論し、済んだら `approve` と打てる）。「PostToolUse の `tool_response.answers` が未実測」は実測した（各 1 試行）。model が入力の `answers` に値を先に入れても、PostToolUse の `tool_response.answers` は利用者が選んだ値になる。複数選択は文字列で届く。Esc でキャンセルすると PostToolUse は発火しない。`tool_response.questions` には表示した質問がそのまま載る。きっかけは、承認待ちが 2 件以上のときに `承認 spec.md plan-3.md` という完全一致の文字列を打つ必要があり、「手で打てない完全一致は使えないのと同じ」という利用者の指摘だった。
- **決定**:
  - 記録は新しい PostToolUse hook `approval-answer-recorder` が `tool_response` だけを読んで行う。`tool_input` は承認の根拠にも veto にも使わない（PostToolUse の `tool_input.answers` にも利用者の回答が入るため、veto にすると正規の承認が記録されなくなる）。
  - 質問は `workflow-cli ask-approval` が生成する（固定文・`header`・文書名の `label`・`hash=<12 桁>` の `description`・`承認しない`）。recorder は記録時点の状態から質問を作り直し、`tool_response.questions` と深い等価で一致したときだけ記録する。質問の文面を model が自由に書けると表示を偽れるため、生成物との完全一致を求める。
  - 1 回の呼び出しに質問は 1 つ、文書は 3 件まで。照合は全か無か、記録は文書ごと。途中で失敗した文書は `ask-approval` を呼び直すと質問に戻る。
  - 記録しない条件（すべて記録しない側に倒す）: 応答に `questions` / `answers` / `annotations` 以外のキーがある / サブエージェントの中 / 文書名が `^(spec|plan|plan-[1-9][0-9]*)\.md$` でない・重複・候補に無い / 作り直した質問と一致しない / 回答が正規の `label` と一致しない / `承認しない` と文書の併選 / `annotations` に `notes` がある。`承認しない` は失敗でなく辞退として返す。
  - `approvals.log` の行に `via`（`utterance` / `ask`）を足し、`workflow-cli status` が表示する。gate は経路を区別しない。読み手は知らないキーを無視するので `v` は 1 のまま。
  - guard は承認らしい質問に `answers` / `annotations` があれば PreToolUse で deny する（多層防御。判定の例外時も deny）。`AskUserQuestion` を `GUARDED_TOOLS` に足し、テンプレートの matcher が `GUARDED_TOOLS` を覆うことをテストする。
  - 文書名なしの `approve` で承認待ちが 2 件以上なら、記録せずに model に `ask-approval` で聞き直させる。全部を承認する案は、議論の結果一部だけ直すことが普通にあるので採らない。
  - rules/workflow.md は容量の上限を上げず、5.3 段落を縮めて両経路の記述と「判断を求める点が複数あるときは AskUserQuestion でまとめて聞く」を入れた。
- **信頼の根の移動**: 承認の根拠が「利用者が打った文字列」から「model が出した UI への利用者のクリック」に変わる。生成物との完全一致で、利用者が見る文面は CLI が決めたものだけになる。ただし、質問に載せる文書の集合と順序は model が選べ、保証されるのは「利用者の選択を経由した」ことだけである。複数の文書を 1 クリックで承認できることは、オーダーの「一気に承認する」の裏返しとして受け入れた。`承認しない` は記録に残らず、過去の版への承認も取り消さない。
- **Consequences**:
  - `workflow-cli` は呼ぶたびに読まれて `chezmoi apply` の直後から新しい挙動になるが、hook の登録は起動時にしか読まれない。起動済みのセッションで `ask-approval` を使うと、回答しても記録されない。`ask-approval` の標準エラーの注意と、`approve` の発話で回復できる。
  - 非対話の実行（`claude -p`、SDK、CI）で host が回答を返す経路の `tool_response` は未実測で、閉じたとは主張しない。知らないキーがあれば記録しないので、残るのは host が対話と同じ形で回答を返す場合である。CI の自律レーンは設計面に触れない（autonomous-lane C3）ので承認を行う場面は無いが、これは規約による。
  - UI を通らずに model の `answers` が結果になる経路（PermissionRequest の hook が `answers` を返すなど）は未実測である。guard の deny で多層に止め、permission の層に AskUserQuestion の入力を書き換えるものが無いことは確認した。
  - サブエージェントの中の AskUserQuestion に `agent_id` が載るかは未実測で、載らなければサブエージェントの出した承認の質問への回答も記録される。利用者が CLI の生成した文面を見て選んだことは保証されるので、受け入れた。
  - 承認の依頼の発火点（rule と triage の出力）は助言で、強制しない。model が質問を出さなくても発話の経路で承認できる。Stop hook で強制する案は誤発火が多く採らない。
  - 再訪の条件: Claude Code の更新で `tool_response` の形が変わったとき（記録しない側に倒れるので、配備後の確認と同じ手順で測り直す）。
- **配備後の確認（2026-10-03、Claude Code 2.1.288）**: 承認の経路は不変条件まで実機で通った（`ask-approval` の質問での承認、model が `answers` を入れた質問の deny、CLI を通さずに言い換えた質問・hash を変えた質問の拒否、Esc のキャンセル、承認待ち 2 件での素の `approve` の聞き直し）。不合格は表示の 1 点で、SessionStart の監査の行が画面に出なかった（原因は未確認）。承認の経路は戻さないことにし、表示の件は `docs/plans/workflow-guard-followups.md` に移した。
- **追記（2026-10-04）: `answers` の値は配列でも届く**: 配備後の 2 日で、承認の質問 12 回のうち 6 回は、値が選択ごとの配列（`["spec.md"]`）で届き、recorder は文字列だけを受けていたので記録しなかった。配列と文字列は同じ版で混在し、切り替わる条件は分かっていない。recorder は文字列と「文字列だけの、要素 1 個以上の配列」の両方を受ける。配列は要素を 1 つの選択として扱い、連結してから分け直さない（Other に打った `spec.md, plan-1.md` を 2 件の承認にしないため）。どちらでもない値は、質問の不一致（`malformed`）と分けて `answerShape` として返し、`approve <文書名>` を案内する。質問の照合と記録しない条件のほかの項目は変えていない。

### 改訂（2026-10-06）: plan-N の承認の委任（ADR-0028）

ADR-0028 で、承認の質問に 2 問目を足した。利用者が spec.md を選び、2 問目で「委任する」を選ぶと、`approvals.log` の spec.md の行に `delegate: "plans-in-scope"` が付く。この ADR の決定は変えていない。

- 承認を記録するのは、利用者の発話と、利用者が答えた質問だけである。委任を記録するのは、質問の経路だけである。
- 記録側は、2 問とも現状から作り直し、応答と完全に一致したときだけ記録する。
- guard は、2 問目だけを出した質問でも、model が `answers` を埋めていれば deny する。
- `delegation-uses.log`（委任で通した書き込みの記録）へのツールでの書き込みは、`approvals.log` と同じ箇所で deny する。Bash は対象外のままである。

### 改訂（2026-10-23）: 承認の質問に作業の識別と文書の題を載せる

承認の質問の選択肢が文書名と hash だけだったので、並列の session ではどの作業の承認かを質問から見分けられなかった。質問文に作業の識別を、選択肢の `description` に文書の題を載せる。照合の原則（recorder が質問を作り直し、生成物と完全一致したときだけ記録する）は変えず、表示に足す情報も生成物の一部にする。

- **決定**:
  - 選択肢の `label` は文書名のままにする。答えの判定と文書名の取り出しは `label` を読むので、題がそこへ入り込まない。
  - 質問文は `Document Workflow の承認（<作業ツリー名> / <workflow id>）: …` とする。識別は wfDir のパスだけから作る。CLI と recorder は同じ `getProjectRoot` と `resolveWorkflowDir` を通るので、同じ値になる。wfDir が既定の形（project root の下の sessions ディレクトリの直下）でないときは、作業ツリー名を省く。両方とも空なら、変更前の固定文になる。接頭辞は変えないので、guard・preflight・recorder の「承認らしい質問」の判定は変わらない。答えは、作り直した質問文をキーにして引く。委任の質問は固定文のままにする。
  - 選択肢の `description` は `hash=<12 桁>` を先頭に固定し、その後に `「<題>」` を足す。題は文書の H1 である。hash と同じ読み込みで正規化した本文から、コードフェンスの外で、最初の `## ` より前にあるものを取る。題が変われば hash も変わる。
  - 文書やパスから取った文字列は、表示用の射影を通す。順序は次のとおり。①空白と制御文字を半角空白にそろえる。②backtick・制御文字・bidi・不可視文字を除く。③題からは `「」` を、作業ツリー名と id からは `（）` を除く。④NFC。⑤空白を畳む。⑥切り詰める（題は 60 code point、作業ツリー名と id は 256）。⑦NFC。出力は NFC の不動点になるので、クライアントが文字列を正規化して返しても照合は変わらない。作業ツリー名は末尾が区別の決め手になるので、先頭だけを残す短い上限は掛けない。
  - `ask-approval` の stderr の注記は変えない。題も識別も補間しない（ADR-0035 K11）。
- **却下した案**: 題だけを `description` に足す案は、似た題の作業どうしを区別できないので採らなかった。ブランチ名は、recorder の hook で git を起動することになり、質問から回答までの間に checkout すると照合が落ちるので載せない。このリポジトリでは作業ツリーのディレクトリ名がブランチ名と一致するが、一致しないリポジトリではブランチは出ない。`label` に題を入れる案は、`承認しない` を題に書いて選択肢を装えるので採らなかった。題を stderr に出す案は、利用者が見ないので採らなかった。
- **受け入れた差**: 題と作業ツリー名は model が書ける。内容で承認へ誘うことや、全角の `ｈａｓｈ＝` を囲みの中に書くことは防げない。結合文字の連続も除かない。何を承認するかを保証するのは本文の hash で、題と識別は見分けるための補助である。stdout の題は model も読むが、model の役割は質問を加工せずに渡すことだけで、加工すれば recorder が記録しない。委任の質問の `description` が spec の Scope の行を射影せずに補間しているのは、この改訂より前からの面で、変えていない。
- **未検証**: 任意の日本語の題を含む文字列が `tool_response.questions` にそのまま戻るか（正規化・trim・長さの上限）。CLI の `CLAUDE_CODE_SESSION_ID` と hook 入力の `session_id` が一致するか。外れると recorder は質問の不一致として記録せず、`approve <文書名>` で記録できる。配備後の確認は `docs/plans/workflow-guard-followups.md` の課題 N にある。

## References

- 設計の全文: `git show 52dc6fd447:docs/plans/workflow-identity/`（research / spec / plan-1〜5。レビューの記録を含む）
- AskUserQuestion による承認の設計の全文（実測の生の記録、却下した代替案、各ラウンドのレビュー指摘）: `git show 52dc6fd447:docs/plans/approval-ask/`
- `docs/decisions/0013-workflow-dir-session-derivation.md`（Open observation items 1 を本 ADR で解消）
- Issue #197 / #221 / #209 / #216
