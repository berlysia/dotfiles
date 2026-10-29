---
name: document-workflow-reference
description: Document Workflow の機構リファレンス。operator guide (`~/.claude/rules/workflow.md`) から分離した、hash・承認・gate・review round・workflow-cli の仕組みを扱う。deny の原因が分からない・hash が動いた・モード判定や mechanical-lane の可否に迷う・ラウンド予算を超えて延長する・誤って workflow に入って抜けたいとき、または `/document-workflow-reference` と指示されたときに読む。
---

# Document Workflow — Mechanism Reference

operator guide（`~/.claude/rules/workflow.md`）は「何をどの順でやるか」を扱う。本 skill は「機構がどう動くか」を扱う。

- ほかの進め方と比較する場合は、人間の確認が実行前の条件なのか、実行後の修正なのかを区別する。
- 規則を文章で伝えることと hook で実行条件として検査することを分けて説明する。同じ指示の反復を機構に変える考え方は、承認の条件にも適用できる。

## 三状態承認と hash 3 種

各成果物は 3 つの状態を満たすと実装可能になる:

- **Plan Status**: `draft` → `complete`（モデルが書く）
- **Review Status**: `pass` / `needs-work` / `blocker`（`workflow-cli stamp` が厳密形で書く。手で転記しない）
- **Approval Status**: `pending` → `approved`（**人間のみ**。承認の質問で文書を選ぶか、会話で `approve` と書くと hook が記録して書き換える。下記「承認の記録」）

hash は 3 種あり、いずれも `workflow-cli` が計算して marker に書く（モデルは転記しない）:

- **auto-review hash**: 成果物全体の正規化 hash。marker の `hash=` と実ファイルの照合に使う。正規化は marker / intent-triage marker / Reviewer Outputs セクション / Approval Status 値 / チェックボックス状態を除外するので、これらの編集では hash は動かない。**Review Status の値は除外しない**ので needs-work → pass で hash が動く（stamp は Review Status を書いた後の内容で hash を計算するので整合する）。
- **design-hash**: Key Decisions / Files / Scope / Tasks セクションだけの hash。prescribed-fix carry-forward 判定に使う。
- **parent-spec-hash**: plan-N.md が指す spec.md の hash。K7 連鎖検証に使う。

## 承認の記録

承認経路を変えるときは、利用者の確定した回答から文書 hash への記録を追う。model の入力や自己申告は同意の根拠にならない。質問の生成と再生成は、関数だけでなく引数・root の導出・読み込んだ本文までそろえ、質問全体の一致を検査する。識別表示も生成物に含め、題は hash 対象の本文から取る。表示の正規化順序（空白へ置換 → 不可視文字の除去 → NFC → 空白の畳み込み）と文字数上限を固定し、委任の除外も表示へ反映する。要約の各項目は層ごとの出典を定め、元の依頼は会話の原文を使う。確認トークンや digest を使う操作では、表示した値を実行引数に渡して機構で照合する。ただし、確認トークン自体は同意の証明ではない。

- **AskUserQuestion の経路**: `workflow-cli ask-approval` が質問の JSON を出す（承認待ちの先頭 3 件。残りは記録の後にもう一度呼ぶと出る。注意は標準エラー）。model はその出力をそのまま AskUserQuestion に渡す。`approval-answer-recorder`（PostToolUse）は `tool_response` だけを読み、記録時点の文書の状態から作り直した質問と深い等価で一致したときだけ記録する。`tool_input` は model が書けるので判定に使わない
- 記録しない場合: 承認らしい質問でない（一般の質問は黙って通す）/ subagent の中の呼び出し / workflow dir を解決できない / 質問の形が違う / 候補でなくなった文書がある（版が変わった、既に承認済み）/ 利用者が離席していた / 自由入力 / 「承認しない」の選択 / 指摘（notes）が付いた。いずれも recorder が理由を返す。「承認しない」は過去の承認を取り消さない
- 照合は全か無か（1 つでも合わなければ何も記録しない）。記録は文書ごとで、一部が失敗したら失敗した文書だけ `ask-approval` を再実行すると質問に出る。利用者が `approve <文書名>` と打つ回復も使える
- ledger の行には記録した経路 `via`（`utterance` / `ask`）が入る。gate は読まず、`workflow-cli status` が `approval via:` で表示する。spec.md の行には `delegate` が付くことがある（下記「委任」）。gate はこれを読む
- guard は承認らしい質問の `answers` / `annotations` を model が埋めた AskUserQuestion を deny する
- 人間が会話で `承認`（複数が承認待ちなら `承認 plan-2.md`）と書くと、`approval-recorder`（UserPromptSubmit）が `<wfDir>/approvals.log` に `{"v":1,"doc","hash","session","at"}` を 1 行追記し、承認行を approved に書き換える。発話の全体がこの形で、`source` が `user` か無く、サブエージェントの外のときだけ記録する
- gate の条件は、3 status 行・marker verdict・hash 一致に加えて「log の同じ `doc` の最後の行の hash = 現在の文書 hash」。`session` は照合に使わないので、wfDir を複製しても同じ版の承認は引き継がれる
- 診断には `approval: recorded=<12 桁 | none> current=<12 桁>` が出る。読み飛ばした行があれば `; ignored-lines=<N>`、log が読めなければ `; ledger-unreadable`（gate は閉じたまま）
- 名前付きの承認（`承認 spec.md plan-1.md`）は全か無か: 1 つでも承認以外の条件を満たさなければ何も記録しない。名前なしは、承認待ちがちょうど 1 件のときだけ記録する。2 件以上なら記録せず、model に `ask-approval` で聞き直させる
- 承認後に hash が動く改訂をすると再承認が要る（Reviewer Outputs・marker・チェックボックスは hash に含まれない。承認後の stamp は Review Status 行を書くので再承認を要する）。取り消しは承認行を pending に戻す
- model の Write / Edit / MultiEdit で承認行を approved にする、または `approvals.log` か `delegation-uses.log` に書くことは guard が deny する（Bash は対象外）
- 承認の形のプロンプト（`承認` / `approve` だけなど）を `CronCreate` / `ScheduleWakeup`（`/loop` を含む）で予約することも guard が deny する。予約したプロンプトは UserPromptSubmit で利用者の入力と区別できないため

## K7 連鎖検証（二層）

`document-workflow-guard` は実装系書き込み時に read-snapshot で検証する:

1. spec.md の三状態 + marker verdict=pass + hash 一致
2. 対象ファイルが属する plan-N.md（Files セクションに列挙）の三状態 + hash 一致
3. その plan-N.md の `parent-spec-hash` = 現 spec.md hash

`parent-spec-hash` が欠落した plan-N.md は不一致と同じく deny する。
spec の hash が変わると、配下の全 plan は以前の承認だけでは通らない。現 spec に対するレビューと再承認が要るため、spec には方針と境界を置き、実行の細部は plan に置く。

## 委任

人間が spec の承認時に委任を選ぶと、条件を満たす plan-N.md は、自分の承認なしで gate を通る。
plan-N.md の承認行は `pending` のまま残り、model は委任のために何も書かない。
委任の条件を変えるときは、承認済みという状態を参照する箇所を全件列挙し、gate・guard・tripwire・記録経路・status の許可と診断を突き合わせる。状態の意味を広げると、同じ値に依存する別の検査まで緩むためである。範囲を判定する機構自身は固定の保護対象とし、委任では変更しない。

**通る条件**（すべて満たすこと）:

- spec.md が gate の条件を満たし、`approvals.log` の spec.md の最終行に `delegate` があり、spec の `## Scope` が有効である。spec の hash が動くと、委任も無効になる。
- plan-N.md が、承認以外の条件（Plan Status、Review Status、marker の verdict と hash、`parent-spec-hash`）を満たす。
- plan-N.md の `## Files` が 1 件以上あり、全件が spec の `## Scope` に収まる。
- plan-N.md の `## Files` に、保護対象のパスが無い。

**`## Scope` の書き方**: `## Files` と同じく、コードブロックに 1 行 1 パスで書く。末尾が `/` の行は dir、それ以外はファイルを表す。`#` で始まる行はコメントである。空白を含む行があるコードブロックは、ブロックごと無視される。次の制限に合わない行が 1 つでもあると、Scope 全体が無効になる。

- 行は 16 行まで、1 行は 120 文字まで。
- 使える文字は、ASCII の英数字と `._/@+-` だけ。
- `/` で区切った要素は、空の要素、`.`、`..` であってはならない（`/` で始まる行、`./src/`、`a//b/` は無効）。

symlink を経由する行は無効にはならないが、どの対象にも該当しない。照合は大文字と小文字を区別する。

**保護対象**（Scope に書いても委任されない）:

- `docs/decisions`、`.skills`、`.github/workflows`、`.git`、`.tmp/sessions` の下（先頭からの要素が一致するもの）
- `.claude` または `dot_claude` という名前の dir の下
- `CLAUDE.md`、`AGENTS.md`、`CONTEXT.md`（末尾の `.tmpl` を外して比べる）

保護対象の判定は大文字と小文字を区別しない。checkout の外へ解決されるパスも委任されない。

**選び方**: `workflow-cli ask-approval` は、質問に出す 3 件の中に spec.md があり、委任できる Scope の行が 1 つ以上あるとき、2 問目（「委任しない」「委任する」）を出す。「委任する」の説明文には Scope の全行が出て、委任されない行には「委任の対象外」と付く。model は 2 問とも出力のまま AskUserQuestion に渡す。記録されるのは、1 問目で spec.md を選び、2 問目で「委任する」を選んだときだけである。発話（`承認 spec.md`）は委任を記録しない。

**委任だけで実装フェーズに入った場合**（人間が承認した plan-N.md が 1 つも無い）:

- どの plan にも無いファイルへの書き込みは、Scope の内側で保護対象でないときだけ警告で通る。それ以外は deny される。
- インタプリタの inline-script の書き込みは、承認前と同じく検査される。
- tripwire は動き続け、Scope の内側で保護対象でない変更だけを報告から外す。

**知らせ方**: guard は、委任で通した最初の書き込みで、plan-N.md の名前、hash の先頭 12 桁、取り消し方を利用者に知らせる。単位は plan-N.md の版と spec.md の版の組である。委任だけの実装フェーズで通した、どの plan にも無いファイルへの書き込みも、ファイルごとに 1 回知らせる。記録は `<wfDir>/delegation-uses.log` に残る。このファイルへの Write / Edit / MultiEdit は deny される。

**取り消し**: spec.md の承認行を `pending` に戻す。spec が未承認になり、委任も無効になる。その後の承認の質問で「委任しない」を選べば、plan-N.md は 1 つずつの承認に戻る。

**同じファイルを複数の plan-N.md が挙げた場合**: 対象を挙げる最初の plan-N.md で結果が決まる。最初が委任で通る plan のときだけ、後ろに人間が承認した plan があればそちらが採られる。

## deny の診断

guard の deny は診断を返す: どの条件（Plan/Review/Approval/marker verdict/hash）が不成立か、実際に見つかった status 行（ハイフン欠落や行末注記もそのまま表示）、期待する厳密形、次にやること。`workflow-cli status` で同じ診断を出せる。

**よくある固着**: `Review Status: pass` をハイフン無しで書くと判定 regex（`^- Review Status:\s*pass\s*$`）に一致せず deny される。`workflow-cli stamp` を使えば厳密形で書かれる。

## Bash 経路と tripwire

- 文書を Bash（`python3 - <<'PY'` 等のインタプリタ heredoc）で書き換えても、`workflow-bash-sync`（PostToolUse Bash）が wfDir 内文書の内容 hash 差分を検知してレビュー推奨を出す。subagent 由来の Bash（`agent_id` あり）は対象外。
- 承認前のインタプリタ inline-script 書き込み（`python|node|bun|deno` の `-c`/`-e`/heredoc に書込指標があり、書込先が scratch root 外 or 証明不能）は deny される。scratch root は `/tmp` / `$CLAUDE_JOB_DIR` / `.tmp/` / 起動時に pin した `DOCUMENT_WORKFLOW_DIR`。読み取りのみの解析スクリプトは許可される。
- gate 閉（承認前）に repo 内ファイルが書き換わると、tripwire が次の Bash 後に検知して `off-plan-writes.log` に記録し告知する。`git` 不在・200ms 超過では `.tripwire-disabled` を作り、一度だけ告知して skip する。委任だけで実装フェーズに入った場合も動く（上記「委任」）。

## 誤って入った場合の脱出

同じセッションのまま承認を経ずに抜ける経路は、wfDir 直下の research.md と plan.md の**両方**を外すこと（一方が残ると armed のまま。`/clear` は会話文脈を失う代わりに新しい wfDir になる）。`workflow-cli reset` が直下を `archive/<日時>/` へ退避する。モデルは dry-run の出力（承認状態・対象・7 日の注記）を AskUserQuestion で見せ、承諾後に出力どおりの `workflow-cli reset --confirm <トークン>` を実行する。守りの主は退避による可逆性で、トークンは確認の質問と一覧を結びつけるだけであり、同意の証明ではない。`followups/` にファイルがあると拒否される。`DOCUMENT_WORKFLOW_WARN_ONLY=1` は脱出ではなく guard 全体の無効化なので使わない。手順と機構メモは [references/escape.md](references/escape.md)。

## prescribed-fix carry-forward（再レビュー省略）

needs-work 指摘の反映後、次の 3 条件の AND 成立時のみ再レビューを省略して直前 verdict を carry-forward する:

- (a) 指摘が文言精度クラス（No Placeholders 禁則違反の修正等）
- (b) reviewer が verbatim 置換を指定している
- (c) `{Key Decisions, Files/Scope, Tasks}` の design-hash が直近 `verdict=needs-work` marker の design-hash から不変

**責務分離**: (a)(b) は reviewer/人間が運用で成立させる条件で、hook は (c) だけを機械検証する（`canCarryForwardVerdict`）。1 条件でも欠ければ全再レビュー。design-hash の無い marker は (c) 不成立扱い。section-scoped design-hash 機構が未デプロイなら no-skip stance（再レビューは走らせるが省略はしない）に縮退する。「diff を目視」での (c) 判定は禁止。

## mechanical-lane（4 条件 AND）

以下 **4 条件すべて（AND）** が成立する変更のみ mechanical-lane として plan.md-only 単層に routing する。1 条件でも非該当なら二層 row に fallback（no-fallback 例外なし）。

- (i) スコープ内の全設計判断が「ユーザーがセッション内で明示確定済の既存 ADR の特定条項の改訂」で、net-new な設計空間がゼロ
- (ii) 残差が決定論的変換（rename / move / 文字列置換）で、新規 control flow / data model / API shape を導入しない
- (iii) 既存テスト + typecheck が当該変換を被覆する
- (iv) 新規 ADR 自体を当該変更の設計記録とする

mechanical-lane を選んだら 4 条件それぞれの判定根拠を plan.md に明記する（曖昧語のみの根拠は不可）。

## ISO 25010 特性選択ガイド

- 状態を変更する CLI を計画に使う前に、書き込み経路を通して読み、上限超過時の削除と重複時の更新を確認する。
- 元に戻す手順が CLI による再生成に依存する場合は、元の状態を再現できるか確かめる。再現できなければ、元に戻す必要のある操作自体を避ける案を検討する。

計画では入出力の契約、不変条件、境界入力への期待結果を定める。設計を左右する未確認事項は計画を書く前に実測し、コマンド・スキーマ・fixture は実物に通して終了コードと出力先、既存の lint との整合まで確かめる。前例を使う場合も、その前提が今回成り立つかを調べる。検査と記録の移管をタスクに含め、委譲先に未解決の設計判断を残さない。実装で生じた計画との差と plan に無い判断は報告させ、具体化・制約の強化・新しい決定に分けて採否を判断し、設計が変わるものは承認へ戻す。

| 変更の種類            | 優先的に検討する品質特性             |
| --------------------- | ------------------------------------ |
| 新機能追加            | 機能適合性、使用性、信頼性           |
| バグ修正              | 機能適合性（正確性）、信頼性         |
| パフォーマンス改善    | 性能効率性                           |
| リファクタリング      | 保守性、機能適合性（リグレッション） |
| インフラ/デプロイ変更 | 移植性、互換性、信頼性               |
| セキュリティ対応      | セキュリティ、信頼性                 |
| API/データモデル変更  | 互換性、機能適合性、セキュリティ     |

## workflow dir の引き継ぎ

継続利用する文書は 7 日で消えるセッション領域から分ける。`.tmp/docs/` は GC 対象外だが clone 後の復元は保証されないため、正本と再作成できる参照を区別する。引き継ぎには確認済みの事実、決定、未決事項、読む順と最初の作業を残し、推測を事実と混ぜない。

hook は wfDir を `session_id` と cwd から導出する。`/clear` 後は成果物を新 wfDir へ `cp -a` し（宛先は `workflow-cli dir` の値をリテラルで貼り、シェル変数は使わない）、再起動なら `DOCUMENT_WORKFLOW_DIR` で pin する。コマンドは [references/session-handoff.md](references/session-handoff.md)。

## worktree で Document Workflow を使う

wfDir は Claude Code を起動した dir（`CLAUDE_PROJECT_DIR`）の `.tmp/sessions/<id 先頭8桁>` にあり、worktree に `cd` しても動かない。`## Files` は repo 相対で書けば、worktree の中のファイルにもその worktree の toplevel 基準で一致する。worktree の中で起動したセッションの wfDir はその worktree の中にある。

## S3 デプロイ移行手順（hash normalizer 変更時）

hash 正規化を変えると承認済みの進行中成果物が deny される。現行設計では正規化を変えない。変える場合は移行手順を終えるまで実装を再開しない。手順は [references/s3-migration.md](references/s3-migration.md)。

## workflow-cli サブコマンド

`workflow-cli` は marker / Review Status / Reviewer Outputs 骨格 / intent-triage marker を書く。

- `workflow-cli status [<path>] [--wf-dir <dir>]`: 引数なしは主文書（plan.md / spec.md）の gate 診断と tripwire 状態。二層モードでは plan-N.md ごとに `plan: plan-N.md ✓`、委任で通っていれば `plan: plan-N.md ✓ (delegated)`、または最初に満たしていない条件を添えた `plan: plan-N.md ✗ <条件>` の行も出す（`parent-spec-hash` の不一致を含む）。委任の条件から外れた plan は `✗ Approval Status (delegation: <理由>)` になる。`delegation: active` / `delegation: none` の行で、委任が有効かどうかも出す。`<path>` を渡すと、そのファイルへの Write / Edit に guard が下す判定（近道で対象外、許可している文書名、off-plan、止まるなら診断）を表示する。`<path>` は CLI を実行した dir 基準。Bash のように対象が複数あるときの集合の扱いは表示しない。承認の記録がある文書ごとに `approval via: <doc> via=<utterance|ask|unknown>` の行も出す。
- `workflow-cli round <doc> [--full] [--extend|--self-extend --cause <landing|kd-changed|blocker|not-narrowing>|--reframer-extend --reason "<text>"]`: `## Reviewer Outputs (Round N)` 骨格を marker 直前に挿入し、`.round-baseline` に round 番号と時刻を、設計の節（Key Decisions と Alternative Approaches）を持つ文書では `.design-baseline` にその節の hash を記録する。Round 2 以降は下記「差分再レビュー」の集合だけを空欄で並べ、carried reviewer は `- verdict: pass (carried from Round N-1)` で埋める。`--full` は必須 reviewer 全員の空欄骨格にする。`<doc>` は wfDir 直下のファイル名（パス区切りを含まない `.md`）に限る。下記「ラウンド予算」を超える round は拒否する。
- `workflow-cli stamp <doc> --verdict <pass|needs-work|blocker> --reviewers a+b`: Round N セクションと reviewer 実行証跡（`reviewer-runs.log`）を確認し、揃っていれば厳密形の Review Status と marker を書く。marker には `round=N` を書く（marker は hash 計算前に除去されるので hash は動かない）。証跡が無ければ非 0。
- `workflow-cli triage <doc> --adopted N --excluded M`: intent-triage marker を書く。成功時は次にやることとして `ask-approval` を出す。
- `workflow-cli ask-approval [--wf-dir <dir>]`: 承認待ち（Plan complete・Review pass・hash 一致・未承認）の文書を先頭 3 件まで選び、`{"questions":[...]}` を標準出力に出す。そのまま AskUserQuestion に渡す。記録の返答の確認方法と、残りの件数は標準エラーに出る。承認待ちが 0 件なら非 0 で終わる。候補に spec.md があり、委任できる Scope の行があるときは、質問が 2 つになる（上記「委任」）。委任で通っている plan-N.md は候補に出ない。

いずれも Approval 行に触れる変更は拒否する。wfDir は `--wf-dir`（`isStrictlyUnderProjectSubdir` で検証し、`.tmp/sessions` の外なら既定 dir に切り替えず非 0）か、`CLAUDE_PROJECT_DIR` と `CLAUDE_CODE_SESSION_ID` からの導出（起動時 pin があればそれ）。`--wf-dir` が session の dir と違えば警告する。成功出力は `wfDir=` / `source=` / `wrote=` で終わる。`workflow-cli dir` は wfDir と決定元だけを出す。

## 差分再レビュー（Round 2 以降）

- レビュー依頼には、利用者が決めた採否と反映先を黙って変更していないかの確認を含める。
- 指摘には重要度を付け、複数のレビュアーが挙げた同じ問題をまとめてから、修正の順序を決める。

指摘の採否は元の依頼と決定範囲で判断し、依頼を縮める提案も範囲外へ広げる提案もそのまま採らない。plan のレビューは spec の決定を前提に実物との整合を確かめる。設計を変えた場合は `round --full` で全員に戻し、差分の周では修正の確認と回帰に範囲を絞る。

`planRoundReviewers`（`~/.claude/hooks/lib/workflow-review-core.ts`）が前 round セクションの `### <slug>` / `- verdict:` を読み、次 round の reviewer を決める。推奨テキスト・`round` の骨格・`stamp` の要求集合はすべてこの結果を使うので食い違わない。

- **再実行（rerun）**: `logic-validator`（回帰の見張り、常に）+ verdict が `pass` で始まらない reviewer + 前 round に現れない必須 reviewer。前 round で needs-work だった内容選定 reviewer も推奨と骨格には入るが、stamp が起動証跡を要求するのは必須 reviewer の分だけ（差分 round が full round より厳しくならないようにするため）。
- **引き継ぎ（carried）**: verdict が `pass` で始まる残りの reviewer。骨格に carried 行として書かれ、次の round でも pass として連鎖する。
- **全員に戻る（full）条件**: 前 round セクションが無い / 空欄の verdict がある / `blocker` がある / `round --full`。曖昧なときは集合を小さくしない側に倒す。

stamp は Round N の要求集合を Round N-1 の verdict から再計算する。`--full` で全員を回した場合は上位集合になるので、そのまま通る。全員 pass 後に軽微指摘を反映して stamp しても、stamp は反映後の内容で hash を計算するので guard の hash 一致は成立する。

## ラウンド予算

収束は非 pass の人数だけで判断しない。差分の周では人数が減りやすいため、残る指摘が設計の問題から局所的な修正へ狭まったか、同じ種類の欠陥が続いていないかを延長理由に書く。自己延長の条件を満たさない設計変更、依頼の範囲やゴールの変更、現状での承認、取り下げは利用者の判断へ戻す。利用者が指定した停止条件を「あと少し」で延ばさない。

周のラウンド数 = 現在の `## Reviewer Outputs (Round N)` 数 − 最後の `verdict=pass` marker の `round=` 値（pass marker が無い、または `round=` の無い旧 marker しか無ければ 0。差が負なら 0）。承認後の再レビュー（parent-spec-hash のずれによる plan-N.md の再承認など）は新しい周として予算を持つ。stamp を挟まない `round` の連打は周のラウンド数を増やすだけ。

周のラウンド数が 3 以上で素の `round` は拒否される。3〜5 は人間に聞かず `--self-extend --cause <値>` で延長でき（cause のうち `blocker` と `kd-changed` は CLI が確かめる）、6 以上は `review-reframer` の判断、9 以上は人間の指示でだけ延長できる。承認の質問を出すときと `status` で、今の周の延長の回数が承認者別・cause 別に出る。拒否時の案内が次の手を示す。延長の条件、reframer の起動と記録、裏付け検査、log 形式、受容した限界、再評価トリガーは [references/round-budget.md](references/round-budget.md) にある。Round 3 を超えて延長するとき、reframer を呼ぶときに読む。

## 記録の移し方

移す前に、原本の見出し一覧と移管先の本文を突き合わせる。完了計画を削除する前は、パスだけでなく隣のファイル名・節名・間接参照も検索し、決定や却下理由を読むために要る内容が失われないか確かめる。現行値を載せる文書はコードの定数と照合し、過去の記録には測定時点を明記する。

作業の終わりに、決まった節を恒久の文書へ移し、spec・research・plan は残さない。移す作業は計画の最後のタスクにする。移して commit した後、次のフローを同じセッションで始めるときは `workflow-cli reset` で直下を退避する（`followups/` が残っていると拒否される）。節と行き先の表、最後のタスクの書き方、残件を書く時点、`docs/plans/` に置くもの、作業ツリーに無い記録の指し方は [references/record-migration.md](references/record-migration.md) にある。計画の最後のタスクを書くとき、作業を終えるとき、応答に残件が出たときに読む。

## prose だけの変更での追加レビュアー

`## Files`（`~/.claude/hooks/lib/workflow-files.ts` の `parseFilesPaths`、guard と同じパーサ）のパスが 1 件以上あり、全件の拡張子（末尾の `.tmpl` は外して判定）が `.md` / `.mdx` / `.markdown` / `.txt` / `.rst` / `.adoc` なら、full round の推奨にキーワード選定の追加レビュアーを付けず、推奨文に skip の理由を 1 行出す。必須 reviewer は変わらない。Files が無い・空ならキーワード選定に戻る。spec.md は Files を持たないので常にキーワード選定になる。コードを触るのに Files に書き漏れがあると prose と判定されるので、推奨文は Files の補正を促す。

## reviewer 実行台帳（reviewer-runs.log）

`reviewer-run-recorder`（PostToolUse Agent）が reviewer subagent の起動を `<sessionId>\t<subagent_type>\t<ISO>` で記録する（`O_APPEND` で 1 行ずつ追記し、並列起動でも行を落とさない。上限は設けない）。`stamp` はこの台帳で、現 round の要求集合（Round 1 と full round は対象層の必須 reviewer、以降は差分再レビューの rerun のうち必須 reviewer）が現 round の baseline 以降に起動されたかを検証する。これで round + stamp だけで reviewer 未起動のまま pass を書くことを防ぐ。台帳は session 単位で文書単位ではない（同 session で spec と plan-N を同 round で見る場合は両層の必須 reviewer が揃えば通る、過剰許容側の fail-open）。

## reviewer を Codex で実行する

帳簿に載る reviewer は、`executor: codex` の依頼で Codex に実行させられる。帳簿は subagent_type で記録するので、stamp はふだんどおり受け付ける。

- 依頼本文を Write で scratchpad のファイルに書く。依頼は `executor: codex` / `brief: <パス>` / `root: <パス>` / `model: <モデル>` / `effort: <effort>` の 5 行にし、Agent の `model: "haiku"` で起動する。haiku は定義の 1 行に従って `~/.claude/scripts/reviewer-codex-run.ts` を実行し、その出力を返すだけ。
- `model:` と `effort:` は `delegation route --kind review` の推奨行（Terra か Luna max）の括弧内にある起動コマンドから、`-m` と `model_reasoning_effort=` の値だけを書く。括弧内のコマンドはそのまま起動しない。値は引用符で囲まない（囲むと記録が `unknown` になる）。`model:` は `^gpt-[0-9a-z.-]{1,32}$`、`effort:` は `low|medium|high|xhigh|max` に一致しなければならず、省略もできない。
- 古い 3 行の依頼は定義の検査で失敗するので、その reviewer を `executor: codex` 無しで実行し直す。
- 成功とするのは、返答が `reviewed-by: codex` と `reviewer: <起動した名前>` で始まり、最後の行が verdict のときだけ。それ以外は失敗とし、その reviewer を `executor: codex` 無しで実行し直す。
- Reviewer Outputs の各 reviewer に `- executor: codex <model>/<effort> (via haiku)` か `- executor: claude (sonnet)` の行を書く。実行し直したら `- note: codex failed (<理由>)` も書いてから stamp する。
- 見出しは reviewer 名だけにする。hook が見出しを reviewer 名として読むため。
- 採用率の記録は、reviewer の結果を確かめた後にメインループが `delegation record` で付ける。reviewer の背景の Bash `codex exec` は、親のセッションと同じ sessionId で pending に open の行を作る。`[delegation]` の行は出ず、id も返答に載らないので、次の手順で行を選ぶ。
  - `~/.local/share/delegation-ledger/pending/*.json` から、次の 6 条件をすべて満たす行を選ぶ。sessionId が自分のセッションと等しい / `closedAt` が無い / harness が `codex-cli` / invocation の先頭が `reviewer-codex-run` / model と effort が依頼の値と等しい / `openedAt` が今回の reviewer を起動した時刻以降。reviewer の数より多ければ `openedAt` の新しい順に reviewer の数だけ取る。
  - reviewer 1 名につき 1 行ずつ `delegation record <id> --kind review --size <S|M|L> --verdict <…>` を打つ。同じ round の reviewer には同じ `--size` を書く（size は route の集計の単位で、行ごとに変えると集計が割れる）。
  - `bad-arguments` で終わった起動の行は委譲先の結果ではないので、record せず `delegation lapse <id>` で閉じる。
  - 合う行が足りなければ、足りない分を `delegation record --manual --harness codex-cli --model <m> --effort <e> --kind review --size <S|M|L> --verdict <…>` で記録する。
  - record も lapse もしなかった行は 7 日で lapse になり、その委譲先の lapse 比を押し上げて、route の規則 1 から黙って外れうる。閉じ忘れないこと。
