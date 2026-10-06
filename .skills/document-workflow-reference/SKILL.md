---
name: document-workflow-reference
description: Document Workflow の機構リファレンス。operator guide (`~/.claude/rules/workflow.md`) から分離した、hash・承認・gate・review round・workflow-cli の仕組みを扱う。deny の原因が分からない・hash が動いた・モード判定や mechanical-lane の可否に迷う・ラウンド予算を超えて延長する・誤って workflow に入って抜けたいとき、または `/document-workflow-reference` と指示されたときに読む。
---

# Document Workflow — Mechanism Reference

operator guide（`~/.claude/rules/workflow.md`）は「何をどの順でやるか」を扱う。本 skill は「機構がどう動くか」を扱う。

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

## 委任

人間が spec の承認時に委任を選ぶと、条件を満たす plan-N.md は、自分の承認なしで gate を通る。
plan-N.md の承認行は `pending` のまま残り、model は委任のために何も書かない。

**通る条件**（すべて満たすこと）:

- spec.md が gate の条件を満たし、`approvals.log` の spec.md の最終行に `delegate` があり、spec の `## Scope` が有効である。spec の hash が動くと、委任も無効になる。
- plan-N.md が、承認以外の条件（Plan Status、Review Status、marker の verdict と hash、`parent-spec-hash`）を満たす。
- plan-N.md の `## Files` が 1 件以上あり、全件が spec の `## Scope` に収まる。
- plan-N.md の `## Files` に、保護対象のパスが無い。

**`## Scope` の書き方**: `## Files` と同じく、コードブロックに 1 行 1 パスで書く。末尾が `/` の行は dir、それ以外はファイルを表す。`#` で始まる行はコメントである。空白を含む行があるコードブロックは、ブロックごと無視される。次の制限に合わない行が 1 つでもあると、Scope 全体が無効になる。

- 行は 16 行まで、1 行は 120 文字まで。
- 使える文字は、ASCII の英数字と `._/@+-` だけ。
- `/` で区切った要素は、空の要素、`.`、`..` であってはならない（`/` で始まる行、`./src/`、`a//b/` は無効）。

symlink を経由する行は無効にはならないが、どの対象にも当たらない。照合は大文字と小文字を区別する。

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

guard の deny は診断を返す: どの条件（Plan/Review/Approval/marker verdict/hash）が不成立か、実際に見つかった status 行（ハイフン欠落や行末注記もそのまま表示）、期待する厳密形、次の 1 手。`workflow-cli status` で同じ診断を出せる。

**よくある固着**: `Review Status: pass` をハイフン無しで書くと判定 regex（`^- Review Status:\s*pass\s*$`）に一致せず deny される。`workflow-cli stamp` を使えば厳密形で書かれる。

## Bash 経路と tripwire

- 文書を Bash（`python3 - <<'PY'` 等のインタプリタ heredoc）で書き換えても、`workflow-bash-sync`（PostToolUse Bash）が wfDir 内文書の内容 hash 差分を検知してレビュー推奨を出す。subagent 由来の Bash（`agent_id` あり）は対象外。
- 承認前のインタプリタ inline-script 書き込み（`python|node|bun|deno` の `-c`/`-e`/heredoc に書込指標があり、書込先が scratch root 外 or 証明不能）は deny される。scratch root は `/tmp` / `$CLAUDE_JOB_DIR` / `.tmp/` / 起動時に pin した `DOCUMENT_WORKFLOW_DIR`。読み取りのみの解析スクリプトは許可される。
- gate 閉（承認前）に repo 内ファイルが書き換わると、tripwire が次の Bash 後に検知して `off-plan-writes.log` に記録し告知する。`git` 不在・200ms 超過では `.tripwire-disabled` を作り、一度だけ告知して skip する。委任だけで実装フェーズに入った場合も動く（上記「委任」）。

## 誤って入った場合の脱出

同じセッションのまま承認を経ずに抜ける経路は、wfDir の research.md と plan.md の**両方**を消すことだけ（一方が残ると armed のまま。`/clear` は会話文脈を失う代わりに新しい wfDir になる）。削除コマンドを `wfDir=` のリテラルパスで提示してユーザーに依頼し、guard が通す場合でも自分では消さない。`DOCUMENT_WORKFLOW_WARN_ONLY=1` は脱出ではなく guard 全体の無効化なので使わない。手順と機構メモは [references/escape.md](references/escape.md)。

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

hook は wfDir を `session_id` と cwd から導出する。`/clear` 後は成果物を新 wfDir へ `cp -a` し（宛先は `workflow-cli dir` の値をリテラルで貼り、シェル変数は使わない）、再起動なら `DOCUMENT_WORKFLOW_DIR` で pin する。コマンドは [references/session-handoff.md](references/session-handoff.md)。

## worktree で Document Workflow を使う

wfDir は Claude Code を起動した dir（`CLAUDE_PROJECT_DIR`）の `.tmp/sessions/<id 先頭8桁>` にあり、worktree に `cd` しても動かない。`## Files` は repo 相対で書けば、worktree の中のファイルにもその worktree の toplevel 基準で一致する。worktree の中で起動したセッションの wfDir はその worktree の中にある。

## S3 デプロイ移行手順（hash normalizer 変更時）

hash 正規化を変えると承認済みの進行中成果物が deny される。現行設計では正規化を変えない。変える場合は移行手順を終えるまで実装を再開しない。手順は [references/s3-migration.md](references/s3-migration.md)。

## workflow-cli サブコマンド

`workflow-cli` は marker / Review Status / Reviewer Outputs 骨格 / intent-triage marker を書く。

- `workflow-cli status [<path>] [--wf-dir <dir>]`: 引数なしは主文書（plan.md / spec.md）の gate 診断と tripwire 状態。二層モードでは plan-N.md ごとに `plan: plan-N.md ✓`、委任で通っていれば `plan: plan-N.md ✓ (delegated)`、または最初に満たしていない条件を添えた `plan: plan-N.md ✗ <条件>` の行も出す（`parent-spec-hash` の不一致を含む）。委任の条件から外れた plan は `✗ Approval Status (delegation: <理由>)` になる。`delegation: active` / `delegation: none` の行で、委任が有効かどうかも出す。`<path>` を渡すと、そのファイルへの Write / Edit に guard が下す判定（近道で対象外、許可している文書名、off-plan、止まるなら診断）を表示する。`<path>` は CLI を実行した dir 基準。Bash のように対象が複数あるときの集合の扱いは表示しない。承認の記録がある文書ごとに `approval via: <doc> via=<utterance|ask|unknown>` の行も出す。
- `workflow-cli round <doc> [--full] [--extend|--self-extend|--reframer-extend --reason "<text>"]`: `## Reviewer Outputs (Round N)` 骨格を marker 直前に挿入し、`.round-baseline` に round 番号と時刻を記録する。Round 2 以降は下記「差分再レビュー」の集合だけを空欄で並べ、carried reviewer は `- verdict: pass (carried from Round N-1)` で埋める。`--full` は必須 reviewer 全員の空欄骨格にする。`<doc>` は wfDir 直下のファイル名（パス区切りを含まない `.md`）に限る。下記「ラウンド予算」を超える round は拒否する。
- `workflow-cli stamp <doc> --verdict <pass|needs-work|blocker> --reviewers a+b`: Round N セクションと reviewer 実行証跡（`reviewer-runs.log`）を確認し、揃っていれば厳密形の Review Status と marker を書く。marker には `round=N` を書く（marker は hash 計算前に除去されるので hash は動かない）。証跡が無ければ非 0。
- `workflow-cli triage <doc> --adopted N --excluded M`: intent-triage marker を書く。成功時は次の一手として `ask-approval` を出す。
- `workflow-cli ask-approval [--wf-dir <dir>]`: 承認待ち（Plan complete・Review pass・hash 一致・未承認）の文書を先頭 3 件まで選び、`{"questions":[...]}` を標準出力に出す。そのまま AskUserQuestion に渡す。記録の返答の確認方法と、残りの件数は標準エラーに出る。承認待ちが 0 件なら非 0 で終わる。候補に spec.md があり、委任できる Scope の行があるときは、質問が 2 つになる（上記「委任」）。委任で通っている plan-N.md は候補に出ない。

いずれも Approval 行に触れる変更は拒否する。wfDir は `--wf-dir`（`isStrictlyUnderProjectSubdir` で検証し、`.tmp/sessions` の外なら既定 dir に切り替えず非 0）か、`CLAUDE_PROJECT_DIR` と `CLAUDE_CODE_SESSION_ID` からの導出（起動時 pin があればそれ）。`--wf-dir` が session の dir と違えば警告する。成功出力は `wfDir=` / `source=` / `wrote=` で終わる。`workflow-cli dir` は wfDir と決定元だけを出す。

## 差分再レビュー（Round 2 以降）

`planRoundReviewers`（`~/.claude/hooks/lib/workflow-review-core.ts`）が前 round セクションの `### <slug>` / `- verdict:` を読み、次 round の reviewer を決める。推奨テキスト・`round` の骨格・`stamp` の要求集合はすべてこの結果を使うので食い違わない。

- **再実行（rerun）**: `logic-validator`（回帰の見張り、常に）+ verdict が `pass` で始まらない reviewer + 前 round に現れない必須 reviewer。前 round で needs-work だった内容選定 reviewer も推奨と骨格には入るが、stamp が起動証跡を要求するのは必須 reviewer の分だけ（差分 round が full round より厳しくならないようにするため）。
- **引き継ぎ（carried）**: verdict が `pass` で始まる残りの reviewer。骨格に carried 行として書かれ、次の round でも pass として連鎖する。
- **全員に戻る（full）条件**: 前 round セクションが無い / 空欄の verdict がある / `blocker` がある / `round --full`。曖昧なときは集合を小さくしない側に倒す。

stamp は Round N の要求集合を Round N-1 の verdict から再計算する。`--full` で全員を回した場合は上位集合になるので、そのまま通る。全員 pass 後に軽微指摘を反映して stamp しても、stamp は反映後の内容で hash を計算するので guard の hash 一致は成立する。

## ラウンド予算

周のラウンド数 = 現在の `## Reviewer Outputs (Round N)` 数 − 最後の `verdict=pass` marker の `round=` 値（pass marker が無い、または `round=` の無い旧 marker しか無ければ 0。差が負なら 0）。承認後の再レビュー（parent-spec-hash のずれによる plan-N.md の再承認など）は新しい周として予算を持つ。stamp を挟まない `round` の連打は周のラウンド数を増やすだけ。

周のラウンド数が 3 以上で素の `round` は拒否され、6 以上は `review-reframer` の判断、9 以上は人間の指示でだけ延長できる。拒否時の案内が次の手を示す。延長の条件、reframer の起動と記録、裏付け検査、log 形式、受容した限界、再評価トリガーは [references/round-budget.md](references/round-budget.md) にある。Round 3 を超えて延長するとき、reframer を呼ぶときに読む。

## prose だけの変更での追加レビュアー

`## Files`（`~/.claude/hooks/lib/workflow-files.ts` の `parseFilesPaths`、guard と同じパーサ）のパスが 1 件以上あり、全件の拡張子（末尾の `.tmpl` は外して判定）が `.md` / `.mdx` / `.markdown` / `.txt` / `.rst` / `.adoc` なら、full round の推奨にキーワード選定の追加レビュアーを付けず、推奨文に skip の理由を 1 行出す。必須 reviewer は変わらない。Files が無い・空ならキーワード選定に戻る。spec.md は Files を持たないので常にキーワード選定になる。コードを触るのに Files に書き漏れがあると prose と判定されるので、推奨文は Files の補正を促す。

## reviewer 実行台帳（reviewer-runs.log）

`reviewer-run-recorder`（PostToolUse Agent）が reviewer subagent の起動を `<sessionId>\t<subagent_type>\t<ISO>` で記録する（200 行 FIFO）。`stamp` はこの台帳で、現 round の要求集合（Round 1 と full round は対象層の必須 reviewer、以降は差分再レビューの rerun のうち必須 reviewer）が現 round の baseline 以降に起動されたかを検証する。これで round + stamp だけで reviewer 未起動のまま pass を書くことを防ぐ。台帳は session 単位で文書単位ではない（同 session で spec と plan-N を同 round で見る場合は両層の必須 reviewer が揃えば通る、過剰許容側の fail-open）。
