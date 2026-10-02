---
name: document-workflow-reference
description: Document Workflow の機構リファレンス。operator guide (`~/.claude/rules/workflow.md`) から分離した詳細を引く。hash 3 種の意味、三状態承認、workflow dir の引き継ぎ、S3 移行手順、prescribed-fix carry-forward の責務分離、mechanical-lane の 4 条件、ISO 25010 特性選択ガイド、workflow-cli のサブコマンド仕様を扱う。deny の原因が分からない・hash が動いた・モード判定に迷う・mechanical-lane の可否を判断するとき、誤って workflow に入ってしまい抜けたいとき、または `/document-workflow-reference` と指示されたときに読む。
---

# Document Workflow — Mechanism Reference

operator guide（`~/.claude/rules/workflow.md`）は「何をどの順でやるか」を扱う。本 skill は「なぜそうなるか・機構がどう動くか」を扱う。deny の原因調査、hash の挙動、モード判定の境界、移行手順が必要なときに読む。

## 三状態承認と hash 3 種

各成果物は 3 つの状態を満たすと実装可能になる:

- **Plan Status**: `draft` → `complete`（モデルが書く）
- **Review Status**: `pass` / `needs-work` / `blocker`（`workflow-cli stamp` が厳密形で書く。手で転記しない）
- **Approval Status**: `pending` → `approved`（**人間のみ**。会話で `承認` と書くと hook が記録して書き換える。下記「承認の記録」）

hash は 3 種あり、いずれも `workflow-cli` が計算して marker に書く（モデルは転記しない）:

- **auto-review hash**: 成果物全体の正規化 hash。marker の `hash=` と実ファイルの照合に使う。正規化は marker / intent-triage marker / Reviewer Outputs セクション / Approval Status 値 / チェックボックス状態を除外するので、これらの編集では hash は動かない。**ただし Review Status の値は正規化対象外**なので、needs-work → pass の遷移では hash が動く（`workflow-cli stamp` は Review Status を書いた後の内容で hash を計算するため整合する）。
- **design-hash**: Key Decisions / Files / Scope / Tasks セクションのみの hash。prescribed-fix carry-forward 判定に使う。
- **parent-spec-hash**: plan-N.md が指す spec.md の hash。K7 連鎖検証に使う。

## 承認の記録

- 人間が会話で `承認`（複数が承認待ちなら `承認 plan-2.md`）と書くと、`approval-recorder`（UserPromptSubmit）が `<wfDir>/approvals.log` に `{"v":1,"doc","hash","session","at"}` を 1 行追記し、承認行を approved に書き換える。発話の全体がこの形のときだけ反応し、`source` が `user` か無く、サブエージェントの外のときだけ記録する
- gate の条件は、上の 3 status 行・marker verdict・hash 一致に加えて「log の同じ `doc` の最後の行の hash = 現在の文書 hash」。`session` は照合に使わないので、wfDir を複製しても同じ版の承認は引き継がれる
- 診断には `approval: recorded=<12 桁 | none> current=<12 桁>` が出る。読み飛ばした行があれば `; ignored-lines=<N>`、log が読めなければ `; ledger-unreadable`（gate は閉じたまま）。次の 1 手は「会話で『承認 <文書名>』と書く」
- 名前を付けた承認（`承認 spec.md plan-1.md`）は全か無か: 1 つでも承認以外の条件を満たさなければ何も記録しない。名前なしは、承認待ちがちょうど 1 件のときだけ記録する
- 承認の後に文書の hash が動く改訂をすると再承認が要る（Reviewer Outputs・marker・チェックボックスは hash に含まれない。`stamp` は Review Status 行を書くので承認後の stamp は再承認を要する）。取り消しは承認行を pending に戻す
- model の Write / Edit / MultiEdit で承認行を approved にする、または `approvals.log` に書くことは guard が deny する（Bash は対象外）

## K7 連鎖検証（二層）

`document-workflow-guard` は実装系書き込み時に read-snapshot で検証する:

1. spec.md の三状態 + marker verdict=pass + hash 一致
2. 対象ファイルが属する plan-N.md（Files セクションに列挙）の三状態 + hash 一致
3. その plan-N.md の `parent-spec-hash` = 現 spec.md hash

`parent-spec-hash` フィールドが欠落した plan-N.md は不一致と同等の conservative deny。spec.md を編集して hash が動くと全 plan-N.md の parent-spec-hash が不一致になり自動でブロックされる。

## deny の診断

guard の deny は固定文ではなく診断を返す: どの条件（Plan/Review/Approval/marker verdict/hash）が不成立か、実際に見つかった status 行（ハイフン欠落や行末注記もそのまま表示）、期待する厳密形、次の 1 手。`workflow-cli status` で同じ診断を出せる。

**よくある固着**: `Review Status: pass` をハイフン無しで書くと判定 regex（`^- Review Status:\s*pass\s*$`）に一致せず deny される。診断がその行を「見つかった行」として示す。`workflow-cli stamp` を使えば厳密形で書かれる。

## Bash 経路と tripwire

- 文書を Bash（`python3 - <<'PY'` 等のインタプリタ heredoc）で書き換えても、`workflow-bash-sync`（PostToolUse Bash）が wfDir 内文書の内容 hash 差分を検知してレビュー推奨を出す。subagent 由来の Bash（`agent_id` あり）は対象外。
- 承認前のインタプリタ inline-script 書き込み（`python|node|bun|deno` の `-c`/`-e`/heredoc に書込指標があり、書込先が scratch root 外 or 証明不能）は保守的に deny される。scratch root は `/tmp` / `$CLAUDE_JOB_DIR` / `.tmp/` / 起動時に pin した `DOCUMENT_WORKFLOW_DIR`。読み取りのみの解析スクリプトは許可される。
- gate 閉（承認前）に repo 内ファイルが書き換わると tripwire が次の Bash 後に検知し `off-plan-writes.log` に記録して告知する。`git` 不在・200ms 超過では `.tripwire-disabled` を作り一度だけ告知して skip する。

## 誤って入った場合の脱出

guard は wfDir に `research.md` または `plan.md` が存在した時点で enforce を始める。`spec.md` 単独では始まらない。`workflow-state.json` の `mode` も条件だが、現在どの hook も書かない。Task Intake Routing で「直接実行」相当のタスクに research/plan を書いてしまった場合、承認を経ずに抜ける経路は **wfDir の文書を消すこと** だけである。承認が人間のみであるのと対称に、消す操作もユーザーに委ねる。

手順:

1. モデルは routing を誤ったと 1 行で述べる。どの条件で直接実行相当と判断したかを含める。**まだ実装しない**。
2. `workflow-cli dir` の `wfDir=` 行で wfDir を得て、リテラルパスに展開した削除コマンドをユーザーに提示し、実行を依頼する。プロンプトで `! rm -f ...` と打てば同セッション内で実行できる。

   ```bash
   rm -f .tmp/sessions/<id8>/research.md .tmp/sessions/<id8>/plan.md .tmp/sessions/<id8>/spec.md .tmp/sessions/<id8>/plan-*.md
   ```

3. 実行後、次のツール呼び出しから guard と `workflow-bash-sync` は inactive になる。SessionStart summary の `workflow gate:` 行は再表示されないので、`workflow-cli status` で `plan.md` が missing 扱いになることを確認してから直接実行に戻る。
4. plan に書いた内容のうち残す価値があるものは会話で要約して引き継ぐ。文書は消えている。

機構メモ:

- `research.md` と `plan.md` の**両方**を消す。どちらか一方が残ると armed のまま。
- モデル自身が Bash で `rm` しても通る。wfDir 配下の `.md` は文書書き込みとして allow されるためである。ただし `rm "$WF/plan.md"` のようにシェル変数を使った形は **deny** される。guard はコマンド文字列の環境変数を展開せず、リテラル `$WF/...` を cwd 相対で解決するため wfDir 配下と判定できない。`rm -r <wfDir>` も対象が `.md` でないので deny される。通るとしてもユーザーに委ねるのは、routing 誤りの自己判定を guard の外で単独実行しないためである。CLAUDE.md の「steering を一方的に無効化しない」に従う。
- `.tripwire-baseline` / `plan-review.cache.json` / `reviewer-runs.log` 等は残っても無害で、7 日で GC される。ただし同セッションで後から本当に workflow に入り直すと、古い `.tripwire-baseline` との差分が「gate 閉時の off-plan 書換」として 1 回報告される。気になるなら `.tripwire-baseline` も同時に消す。
- `/clear` も脱出になる。新 session id で新 wfDir が導出され inactive になる。会話文脈を失う代わりにコマンドは不要。
- `DOCUMENT_WORKFLOW_WARN_ONLY=1` は脱出ではなく guard 全体の無効化であり、起動時 env でしか効かない。routing 誤りの対処に使わない。ADR-0013 参照。

## prescribed-fix carry-forward（再レビュー省略）

needs-work 指摘の反映後、以下 3 条件の AND 成立時のみ再レビューを省略して直前 verdict を carry-forward する:

- (a) 指摘が文言精度クラス（No Placeholders 禁則違反の修正等）
- (b) reviewer が verbatim 置換を指定している
- (c) `{Key Decisions, Files/Scope, Tasks}` の design-hash が直近 `verdict=needs-work` marker の design-hash から不変

**責務分離**: (a)(b) は reviewer/人間が運用文脈で成立させる条件で hook は機械判定しない。hook が機械検証するのは (c) のみ（`canCarryForwardVerdict`）。1 条件でも欠ければ全再レビュー。design-hash フィールド欠落の marker は (c) 不成立扱い。section-scoped design-hash 機構が未デプロイの場合は no-skip stance（再レビューは走らせるが省略はしない）に縮退する。「diff を目視」での (c) 判定は禁止。

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

hook は wfDir を hook 入力の `session_id` + cwd から導出するので、環境変数が無くても enforce は効く。次セッションへ引き継ぐとき:

- **`/clear` して同じプロセスで続ける**: `/clear` は新しい session id を発行し `.tmp/sessions/<新 id 先頭8桁>` になる。前セッションの成果物を新 dir へ `cp -a` でコピーする。auto-review hash は文書内容のみから算出されるのでパスが変わっても承認状態は保たれる。`workflow-cli dir` の `wfDir=` の値をリテラルで貼ってからコピーする（シェル変数を使わないので、空の変数でルートに展開する事故が起きない）。複製すると `approvals.log` も移り、同じ版の文書の承認は引き継がれる:

  ```bash
  workflow-cli dir   # wfDir=<新しい dir> を確かめる
  cp -a .tmp/sessions/<旧 id 先頭8桁>/. <wfDir の値>/
  ```

- **`claude` を起動し直す**: `DOCUMENT_WORKFLOW_DIR=.tmp/sessions/<旧 id 先頭8桁> claude "..."` と起動時 env で pin する。containment を満たさない pin は `env-rejected` として捨てられ導出値が使われる。

## worktree で Document Workflow を使う

wfDir は Claude Code を起動した dir（`CLAUDE_PROJECT_DIR`）の `.tmp/sessions/<id 先頭8桁>` にあり、worktree に `cd` しても動かない。`workflow-cli dir` で確認する。`## Files` は repo 相対で書けば、worktree の中のファイルにもその worktree の toplevel 基準で一致する。worktree の中で起動したセッションの wfDir はその worktree の中にある。

## S3 デプロイ移行手順（hash normalizer 変更時）

hash 正規化を変更した場合、旧 normalizer で承認済の進行中成果物は marker hash が変わり conservative deny される。新規セッションで以下を実装再開前に完了する:

1. `bun run test` で hash parity（`document-hash.test.ts` の legacy↔new 境界 + `document-workflow-guard.test.ts` の統合経路）が両方緑であることを確認する。
2. 進行中成果物の `<!-- auto-review: ... -->` の hash を新 normalizer で再算出して書き換える。
3. `plan-review.cache.json`（plan と同ディレクトリに co-locate）を削除して誤 skip を防ぐ。
4. 1→2→3 完了前に実装を再開しない。

**注**: 現行設計では正規化を変更しない方針（deny 診断は寛容マッチを表示専用に分離し、判定 regex と正規化は不変）なので、この手順は将来 normalizer を変える場合の備えである。

## workflow-cli サブコマンド

`workflow-cli` は marker / Review Status / Reviewer Outputs 骨格 / intent-triage marker を書く。モデルは hash を転記しない。

- `workflow-cli status [<path>] [--wf-dir <dir>]`: 引数なしは主文書（plan.md / spec.md）の gate 診断と tripwire 状態。`<path>` を渡すと、そのファイルへの Write / Edit に guard が下す判定（近道で対象外、許可している文書名、off-plan、止まるなら診断）を表示する。`<path>` は CLI を実行した dir 基準。Bash の書き込みのように対象が複数あるときの集合の扱いは表示しない。
- `workflow-cli round <doc> [--full] [--extend|--self-extend|--reframer-extend --reason "<text>"]`: `## Reviewer Outputs (Round N)` 骨格を marker 直前に挿入し、`.round-baseline` に round 番号と時刻を記録する。Round 2 以降は下記「差分再レビュー」の集合だけを空欄で並べ、carried reviewer は `- verdict: pass (carried from Round N-1)` で埋める。`--full` は常に必須 reviewer 全員の空欄骨格にする。`<doc>` は wfDir 直下のファイル名（`plan.md` など、パス区切りを含まない `.md`）に限る。下記「ラウンド予算」を超える round は拒否する。
- `workflow-cli stamp <doc> --verdict <pass|needs-work|blocker> --reviewers a+b`: Round N セクションと reviewer 実行証跡（`reviewer-runs.log`）を確認し、揃っていれば厳密形の Review Status と marker を書く。marker には stamp 時点の round 数を `round=N` として書く（marker は hash 計算前に除去されるので hash は動かない）。証跡が無ければ非 0。
- `workflow-cli triage <doc> --adopted N --excluded M`: intent-triage marker を書く。

いずれも Approval 行に触れる変更は拒否する（承認は人間のみ）。wfDir は `--wf-dir`（`isStrictlyUnderProjectSubdir` で検証し、`.tmp/sessions` の外なら既定 dir に切り替えず非 0）または `CLAUDE_PROJECT_DIR` と `CLAUDE_CODE_SESSION_ID` からの導出（起動時 pin があればそれ）。`--wf-dir` が session の dir と違えば警告する。成功出力は `wfDir=` / `source=` / `wrote=` で終わる。`workflow-cli dir` は wfDir と決定元だけを出す。

## 差分再レビュー（Round 2 以降、ADR-0015 K6）

`planRoundReviewers`（`lib/workflow-review-core.ts`）が前 round セクションの `### <slug>` / `- verdict:` を読み、次 round の reviewer を決める。推奨テキスト・`round` の骨格・`stamp` の要求集合はすべてこの関数の結果を使うので食い違わない。

- **再実行（rerun）**: `logic-validator`（回帰の見張り、常に）+ verdict が `pass` で始まらない reviewer + 前 round に現れない必須 reviewer。前 round で needs-work だった内容選定 reviewer（例: security-vulnerability-analyzer）も推奨と骨格には入るが、stamp が起動証跡を要求するのは必須 reviewer の分だけ（Round 1 と同じ扱いで、差分 round が full round より厳しくならないようにするため）。
- **引き継ぎ（carried）**: verdict が `pass` で始まる残りの reviewer。骨格に carried 行として書かれるので、次の round でも pass として連鎖する。
- **全員に戻る（full）条件**: 前 round セクションが無い / 空欄の verdict がある / `blocker` がある / `round --full`。曖昧なときは集合を小さくしない側に倒す。
- **運用規律（機械判定なし）**: Key Decisions・白紙案を変える修正は `--full`。全員 pass で残りが軽微指摘だけなら、反映してから `stamp --verdict pass` する（stamp は反映後の内容で hash を計算するので、guard の hash 一致はそのまま成立する）。

stamp は Round N の要求集合を Round N-1 の verdict から再計算する。`--full` で全員を回した場合は要求集合の上位集合になるので、そのまま通る。

## ラウンド予算（ADR-0015 Amendment 2026-09-28 / 2026-10-01）

文言だけの予算は 3/9 文書で破られていたので、予算を `round` の拒否として機構化した（2026-09-28）。そのうえで、着地見込みがあるときはモデルの判断で、Round 6 で詰まったら `review-reframer` の判断で延長できるようにした（2026-10-01）。延長のたびに、誰の判断かを log に残す。

- **周の数え方**: 周のラウンド数 = 現在の `## Reviewer Outputs (Round N)` 数 − 最後の `verdict=pass` marker の `round=` 値（pass marker が無い、または `round=` の無い旧 marker しか無ければ 0。差が負なら 0）。承認後の再レビュー（parent-spec-hash のずれによる plan-N.md の再承認など）は pass 後の新しい周として予算を持つ。stamp を挟まない `round` の連打は周のラウンド数を増やすだけ
- **段階と許可**（`getRoundBudgetPhase` / `isExtensionAllowed`、`lib/workflow-review-core.ts`。CLI の拒否と推奨テキストの通知は同じ関数を使う）:

  | 周のラウンド数 | phase           | 素の `round` | `--self-extend` | `--reframer-extend`            | `--extend`（人間） |
  | -------------- | --------------- | ------------ | --------------- | ------------------------------ | ------------------ |
  | 0〜2           | open            | 可           | 可（記録なし）  | 可（記録なし・裏付け検査なし） | 可（記録なし）     |
  | 3〜5           | self-extendable | 拒否         | 可（`self`）    | 拒否                           | 可（`human`）      |
  | 6〜8           | reframer-review | 拒否         | 拒否            | 裏付けがあれば可（`reframer`） | 可（`human`）      |
  | 9 以上         | human-only      | 拒否         | 拒否            | 拒否                           | 可（`human`）      |

  上限の 6 と 9 は予算 3 の刻みに揃えた設計値で、収束分析に基づく値ではない。人間の `--extend` に上限は無い

- **引数検査の順序**（先に当たったものを返す）: 文書名が wfDir 直下の `.md` でない → 延長フラグが 2 つ以上 → `--self-extend` / `--reframer-extend` と `--full` の併用（Key Decisions を変える修正はモデル / reframer の判断の範囲外。人間の `--extend` は `--full` と併用できる）→ reason がサニタイズ後に空 → phase → （reframer-review での `--reframer-extend` のみ）記録ファイル → 起動記録
- **自己延長（`--self-extend`）の条件**（機械判定しない）: 直近 round の reviewer verdict に `blocker` が無い / 残る指摘が Key Decisions・白紙案を変えずに直せる / 残る指摘が前 round より狭まっている（非 pass 数は目安。同数でも中身が局所化していればよい、同じ指摘の再発は不可）。reason は `non-pass N→M; remaining: <残る指摘の要約>`。満たさなければ Round 6 を待たずに Executive Summary で人間に仰ぐ
- **reframer**（`home/dot_claude/agents/review-reframer.md`）: Round 6 の結果が stamp 済みで pass でなければ、Agent tool で `subagent_type: review-reframer` を周内で 1 回だけ起動する（`model` 引数は書かない。モデルはエージェント定義の frontmatter で決まる）。起動できなければ他のエージェントやモデルで代替せず、人間に仰ぐ。入力は文書のパスと全 round の非 pass 指摘の要約。出力は、収束しない原因の仮説と、(a) 現枠組みで続行 / (b) 問題の変形（文書固有の変形案を 1 つ以上、推奨時は新 Key Decisions の骨子）/ (c) 既知の未解決を明記して承認に回す / (d) 取り下げ、それぞれの利点・欠点と推奨 1 つ
- **記録ファイル** `<wfDir>/reframer-review.<doc>`: 推奨にかかわらず、末尾に次の節を足す（無ければ Write で作成、あれば Edit で追記。各フィールド 1 行、本文に `## ` 行を書かない、`- agent:` / `- recommendation:` は節内で 1 回だけ）。N は相談時点の最新 stamp 済み round。文書外にあるので文書の hash は変わらない

  ```
  ## Reframer Review (Round N)
  - agent: review-reframer
  - recommendation: <(a)|(b)|(c)|(d)>
  - rejected: <推奨以外の 3 択を退けた理由>
  - hypothesis: <収束しない原因の仮説>
  - plan: <(a) なら Round 9 までの修正方針 / (b) なら変形案と新 Key Decisions の骨子>
  ```

- **`--reframer-extend` の裏付け検査**: 記録ファイルの最後の節について、N が周の入り口（最後の pass marker の `round=` + 6）と等しい / `agent` が `review-reframer` と完全一致 / `recommendation` が `(a)` と完全一致。加えて、`.round-baseline` の Round N の時刻以降に `reviewer-runs.log` に `review-reframer` の起動記録がある（`reviewer-run-recorder` が記録する）。reason は `reframer: (a) <着地見込みの要約>; rejected: <(b)〜(d) を退けた理由の要約>`
- **推奨が (b)(c)(d) のとき**: Executive Summary の Open Questions に載せて人間の判断を待つ（(b) の採否は人間が決める設計である旨を 1 行添える）。Round 9 でも着地しなければ、記録ファイルの要約と Round 7〜9 の経過を載せて人間に仰ぐ。reframer は再起動しない
- **Executive Summary への記載**: 延長した周は Review Status に承認者別の延長回数（例: `pass / Round 8（self-extended 3, reframer-extended 2）`）。reframer を使った周は記録ファイルのパスと要約（人間が reframer の判断に気づける唯一の経路なので必須）。Round 7 以降に進んだことは Risks に書く
- **log**: 予算を超えた延長は `<wfDir>/round-extensions.log` に `<ISO8601>\t<doc>\t<round>\t<human|self|reframer>\t<reason>` で 1 行残る。reason は制御文字・行区切りを空白にし、前後の空白を除き、500 文字で切り詰める。この形式より前の 4 列の行は承認者列が無く、`human` として読む
- **受容した限界**（重要度順）: (1) `--reframer-extend` で人間抜きに Round 7〜9 を進める根拠は記録ファイルと台帳の起動記録で、記録ファイルはメインループが書く。推奨の書き換え、空に近い入力での起動、別文書向けの起動、既存の節の書き直し、台帳ファイルの偽造は検知できない。(2) `human` 行は人間の承認を証明しない（`--extend` はモデルも打てる）。(3) 着地見込みの判定は機械検証しない。(4) reason 形式の確認は目視。(5) Round 7〜9 は「上位モデルのサブエージェントが判断するならさらに延長してよい」というユーザー指示を、続行の判断に限って reframer に委ねると解釈したもの。(6) reframer に上位モデルを当てる効果は未検証。加えて、周の起点になる `stamp --verdict pass` は verdict 行と突き合わせない自己申告
- **観測と再評価トリガー**: 周は到達した最大 phase で 1 つに分類し、`round-extensions.log` の承認者列・auto-review marker・記録ファイルで結果を見る。次のいずれかで見直す: self-extendable 止まりの周が Round 6 までに pass せず reframer-review に入った例が 2 件 / reframer-review 以上の周が Round 9 までに pass しなかった例が 2 件 / reason 形式（`non-pass N→M`、`reframer: (a)`）を外れた例が 1 件 / reframer を起動できず人間に回った例が 2 件（エージェント定義のモデル指定を見直す）/ 記録ファイルと reframer の出力が食い違った例が 1 件（`--reframer-extend` を廃止する）/ 正当な記録があるのに `--reframer-extend` が拒否された例が 2 件（検査を減らす）/ log に人間の指示に対応しない `human` 行が 1 件 / 非 pass が残るのに pass marker が付いた例が 1 件

## prose だけの変更での追加レビュアー

`## Files`（`lib/workflow-files.ts` の `parseFilesPaths`、guard と同じパーサ）のパスが 1 件以上あり、全件の拡張子（末尾の `.tmpl` は外して判定）が `.md` / `.mdx` / `.markdown` / `.txt` / `.rst` / `.adoc` なら、full round の推奨にキーワード選定の追加レビュアーを付けず、推奨文に skip の理由を 1 行出す。必須 reviewer は変わらない。Files が無い・空なら従来のキーワード選定に戻る。spec.md は Files を持たないので常にキーワード選定になる。コードを触るのに Files に書き漏れがあると prose と判定されるので、推奨文は Files の補正を促す。

## reviewer 実行台帳（reviewer-runs.log）

`reviewer-run-recorder`（PostToolUse Agent）が reviewer subagent の起動を `<sessionId>\t<subagent_type>\t<ISO>` で記録する（200 行 FIFO）。`stamp` はこの台帳で「現 round の要求集合（Round 1 と full round は対象層の必須 reviewer、以降は差分再レビューの rerun のうち必須 reviewer）が現 round の baseline 以降に起動されたか」を検証する。これにより round + stamp だけで reviewer 未起動のまま pass を書くことを防ぐ。台帳は session 単位で文書単位ではない（同 session で spec と plan-N を同 round で見る場合は両層の必須 reviewer が揃えば通る、過剰許容側の fail-open）。

## 起動軸（pull / push）と autonomous lane

`~/.claude/rules/autonomous-lane.md` の charter（C1 型ホワイトリスト / C2 可逆性 / C3 設計面非接触）を参照。push レーンは CI/cron 専用で出力は必ず PR。設計判断（ADR / API / データモデル / routing 表の変更）を push に乗せることは恒久的に禁止。
