# ADR-0013: workflow ディレクトリを session_id から導出し、env を検査付き override へ降格する

## Status

accepted (2026-09-04)

## Context

`document-workflow-guard` は Document Workflow の成果物ディレクトリ (以下 wfDir) を `DOCUMENT_WORKFLOW_DIR` 環境変数から得ていた。この値を供給しているのは SessionStart hook (`home/dot_claude/hooks/implementations/session.ts`) で、供給先は `CLAUDE_ENV_FILE` である。

**`CLAUDE_ENV_FILE` は Bash ツールの実行環境にしか届かない。** PreToolUse hook は起動済みの Claude Code プロセスから env を継承するだけなので、`claude` を `DOCUMENT_WORKFLOW_DIR=... claude ...` の形で pin 起動していないセッションでは、hook プロセスに値が届かない。

**値が届かなかったときの挙動は無言 skip だった。** stderr へ `DOCUMENT_WORKFLOW_DIR is not set, skipping guard` を出して stdout は 0 バイト。Claude Code は hook の stderr をユーザーにもモデルにも見せないため、この状態は「gate が armed で、違反が 1 件も無い」状態と出力上まったく区別できなかった。

**実測では 2026-07-28 以降のどのセッションでも guard は一度も deny していない。** その間 `plan-review-automation` は動作し続けており auto-review マーカーだけは更新されるため、外形上は Document Workflow が機能しているように見えていた。承認前の実装着手を止めるという gate の目的は、その期間ずっと果たされていなかった。

ADR-0001 が `session.ts` による `DOCUMENT_WORKFLOW_DIR` の自動設定を、ADR-0003 が enforce モードを定めた。両者は「env が hook に届く」を暗黙の前提に置いている。本 ADR はその前提の訂正である。

## Analysis

hook は PreToolUse ごとに新しいプロセスとして spawn され、その入力には `session_id` と cwd が常に含まれる。ゼロから設計するなら、**毎回必ず手元にある入力から導出する**のが自然であり、外部から供給される env を必須依存に置く理由がない。env は値を供給すると同時に「配送の失敗」という故障モードを持ち込むが、`session_id` は hook が呼ばれた事実そのものに付随するので、配送されない状態が存在しない。

この起点から、解決責務を `resolveWorkflowDir({ cwd, sessionId })` の 1 関数に集約し、env を「override の 1 段目」へ降格する形へ到達する。

## Decision

### 1. 信頼モデルの移動

guard の前提を「`DOCUMENT_WORKFLOW_DIR` が配送されていること」から「**hook 入力に `session_id` があること**」へ移す。既定の導出式は `<cwd>/.tmp/sessions/<session_id の先頭 8 文字>` で、その SSoT は `home/dot_claude/hooks/lib/workflow-paths.ts` に置く。

### 2. env は検査付きの override へ降格する。失敗の結末は段ごとに異なる

`home/dot_claude/hooks/lib/workflow-resolve.ts` の解決順序と、各段で落ちたときの結末は次のとおり。**この区別を潰して要約しないこと。**

- **(a) `session_id` の形式検証に落ちる** → `unresolvable` (`reason: "invalid-session-id"`)
- **(b) 導出先 `<cwd>/.tmp/sessions/<先頭 8 文字>` の containment 検査に落ちる** → `unresolvable` (`reason: "containment-unverifiable"`)。**この段では env を読まない** (`workflow-resolve.ts:104-111`)。sessions root が張り替えられている場合、導出値も同じ張替え先に落ちるため、「env を捨てて導出値へ戻す」という `env-rejected` の定義そのものが成立しないからである
- **(c) (b) を通った上で `DOCUMENT_WORKFLOW_DIR` があり、realpath containment (`:124`) と字句 prefix 検査 (`:135`) の両方を満たす** → `env` として採用。いずれかを欠けば `env-rejected` として導出値へ落ちる

containment 述語 `isStrictlyUnderProjectSubdir` (`home/dot_claude/hooks/lib/workflow-fs.ts:68-87`) が課しているのは「realpath 後に真下」だけではない。**base (`<cwd>/.tmp/sessions`) 自身が自分に解決すること** (`base !== lexicalBase` なら false)、および **未作成の子孫は許容するがダングリング symlink・`ELOOP`・`EACCES` は許容しないこと** (`resolveWithMissingTail` が null を返す) も条件である。後者は「そこには何も無い」と「検証が走らなかった」を区別する意図で、後者を not-contained に倒す。env 側の入力には `expandTilde` が先に適用される。

字句 prefix 検査 (`:135`) を realpath containment と別に置いているのは、containment を realpath で決める一方で `dir` は字句パスのまま消費側へ渡すためである。プロジェクトの別名 (`~/proj/...` と `/mnt/data/proj`) を通した pin は containment を通るが、下流の `startsWith(dir + "/")` がすべて外れる。画面には具体的な dir が出ているのに、その下の何にも一致しないという状態を作らないための検査である。

### 3. 解決結果は 1 つの値として返す

`{ source: "env" | "derived" | "env-rejected", dir, relative }` と `{ source: "unresolvable", dir: null, relative: null, reason }` の 2 メンバの直和で返す。表示と判定が別々に解決経路を再計算しないようにするためで、`relative` は常に解決済み絶対パスから導出し、生の env 文字列からは作らない。

### 4. SessionStart で必ず可視化する

`CLAUDE_ENV_FILE` の有無に関わらず毎回出るのは、起動メッセージ・**配線** (`~/.claude/settings.json` の matcher が全 guarded tool を覆っているか)・**解決の結末**・**warn-only の状態**である。**「無言 = 正常」を成立させないことが本 ADR の中心**であり、解決経路の修正と同格の決定として扱う。

ただし 2 つは条件付きなので、そこを丸めない。

- **cwd 行は不一致時のみ出る** (`session.ts:241-245`)。常時表示ではなく、`context.input.cwd` と `process.cwd()` が食い違う構成 (worktree / subagent) を検出する診断が目的である
- **`workflow gate: armed / inactive` は `unresolvable` でない分岐にしかない** (`session.ts:220-222`)。`unresolvable` のときは代わりに「どの検査に落ちたか」と「`DOCUMENT_WORKFLOW_DIR` を export しない」旨が出る。armed の語が最も欲しい場面で armed の語が出ないという非対称がある

### 5. `autonomous-lane.md` の Phase 2 blocklist への追加は不要

適用範囲は `off-plan-writes.log` と `lessons-learned.md` の 2 つに限る。根拠は次の 2 点で、「`home/dot_claude/rules/autonomous-lane.md:56` に既に列挙されているから」ではない。

- 両ファイルは `<wfDir>` = `.tmp/sessions/` 配下であり、`.gitignore:24` の `.tmp/` により **PR の diff に原理的に現れない**。`:56` が想定するゲートは `git diff --name-only` なので、両ファイルはその射程外である
- 本変更の containment により wfDir は `<cwd>/.tmp/sessions/` の真下に強制されるため、**env pin で追跡下ディレクトリへ永続ファイルを落とす経路が閉じた**

`:56` に両ファイル名が列挙されている事実自体は成立している。ただしそれは Phase 2 hardening の**記録**であって現時点の保護ではないため、単独では「追加不要」の根拠にならない。

**`:56` はもう 1 つ `plan-review.cache.json` を列挙しているが、そちらには上の根拠が効かない。** `home/dot_claude/hooks/implementations/plan-review-automation.ts:291-294` はキャッシュ位置を「編集対象の dirname」で決めており containment 検査を持たないため、wfDir 配下に留まる保証がない。この件は `docs/plans/workflow-guard-followups.md` の課題 I として追跡し、blocklist の再検討はそちらで扱う。後続で**追跡下に**新規の永続ファイルを導入する場合は、`:56` への追加が必要になる。

## Rejected alternatives

- **差分最小案**: `session.ts` が env file 以外の経路でも dir を配り直す、あるいは配送経路を増やす。→ 却下。障害の本体は「配送が失敗したことを誰も観測できない」ことであり、経路を増やしても**失敗時に無言 skip する構造は残る**。むしろ、どの経路で届いたかによって挙動が分岐する面が広がる
- **fail-closed 化**: 解決できないときにツール呼び出しをブロックする。→ 却下。guard がクラッシュし続けた場合にセッションが完全に停止し、脱出路が `DOCUMENT_WORKFLOW_WARN_ONLY=1` の**起動時 env だけ**になる。それは本 ADR が壊れていると認定した配送経路そのものである

**可観測性 (guard が長期間走っていないことの検出) は本 ADR の出荷から外した。** 追記型 sink の候補 4 案がいずれも実測で否定され、独自の設計パスを要すると判断したためである。否定の経緯・設計の起点・未解決の課題は `docs/plans/workflow-guard-followups.md` の課題 H に一元化した。ここに要約だけを置くのは、証拠を 2 つの永続文書へ同じ粒度で書くと片方だけが腐るからである。

## Consequences

1. pin 起動の有無に関わらず enforce が効く。deny 文は `(unknown)` ではなく実際の dir を示す。
2. **既知の縮退**: containment の基準は hook が見る作業ディレクトリであってリポジトリルートではない。サブディレクトリから `claude` を起動して**リポジトリルート基準の絶対パスで pin した**場合、その env は `env-rejected` になり、導出先は作業ディレクトリ配下の不在 dir となって guard は armed にならない。この構成に限り、本変更は enforce を**強めるのではなく消す**。起動時サマリで可視化されるが、表示は SessionStart の 1 回きりである。
3. **`.tmp/sessions` を symlink に置き換えると恒久的な kill-switch になる。** `ln` は guard の write-like allowlist (`document-workflow-guard.ts` の `analyzeSingleCommand` が認めるのは `tee` / `touch` / `mkdir` / `rm` / `rmdir` / `truncate` / `cp` / `mv` / `install` / `sed -i` / `perl -i` とリダイレクトのみ) に無いため無条件に通り、以後**全セッションで恒久的に** `unresolvable` (`containment-unverifiable`) になる。

   **成立条件を併記する。** POSIX の `ln` は LINKNAME が既存ディレクトリならその**中に**リンクを作るため、`.tmp/sessions` が実ディレクトリとして存在する通常状態で `ln -s docs .tmp/sessions` を打っても `.tmp/sessions/docs` ができるだけで kill-switch にはならない。成立するのは「`.tmp` が在り `.tmp/sessions` が不在」の窓か、先行する `rm` (こちらは write-like で guard 対象) を経た場合である。前提を書かずに手順だけ残すと、後続が「再現しない = 直っている」と誤読する。

4. **env による gate 解除は縮小したが、消えてはいない。** containment が塞ぐのは `<cwd>/.tmp/sessions/` の**外**を指す pin だけである。`.tmp/sessions/decoy` (空ディレクトリ) を指す pin は `source: "env"` として**採用され**、`isWorkflowActive` が偽になって guard は無言で通す。したがって「repo が供給する `.claude/settings.json` の env ブロックから gate を解除される経路を塞いだ」とは書けない。閉じたのは**プロジェクト外を指す pin による事故**までである。本 gate は不注意な逸脱を止める anti-drift 機構であって敵対的耐性を主張しない、という脅威モデルの内側でこれを受け入れる。
5. `getWorkflowDir` / `getWorkflowDirRelative` は env 専用の薄いシムとして残り、production の呼び出し元はゼロになる。削除は `docs/plans/workflow-guard-followups.md` の課題 F として追跡する。

## Open observation items

1. **cwd 解決の不一致**: 5 hook はいずれも `process.env.CLAUDE_TEST_CWD || process.cwd()` で cwd を得ており、`context.input.cwd` を使っていない。subagent 経路では両者が一致することを実測済み (親と同じ `session_id` / `cwd`)。**worktree 経路は未測定**であり、そこで不一致が出れば導出先が変わる。起動時サマリの cwd 行が発火するかで観測する。
2. **`env-rejected` の実運用での発火**: 起動時サマリに `env-rejected` が出るかどうか。出る場合は pin の書き方か、Consequences 2 のサブディレクトリ起動の縮退が現に起きている。
3. **`unresolvable` の発火**: guard は `unresolvable` のとき毎ツール呼び出しで systemMessage を出す。この表示が出続けるようなら、Consequences 3 の kill-switch か session id の形式違反が起きている。同時に、毎回出続けること自体が「正常時に鳴る警告」に近づくため、頻度が観測されたら課題 H の後続設計の入力にする。

## References

- `docs/decisions/0001-document-workflow.md` — `session.ts` による `DOCUMENT_WORKFLOW_DIR` の自動設定を定めた。本 ADR がその前提を訂正する
- `docs/decisions/0003-document-workflow-enforce.md` — enforce モードを定めた。同上
- `docs/plans/workflow-guard-followups.md` — 本変更の調査中に出た、本体スコープ外の課題 9 件。可観測性の後続設計 (課題 H) の証拠一式もそこにある
- 実装 commit (Phase 2): `34e4f35` / `7100cd9` / `7524b1b` / `1125054` / `25a3aac` / `4287224` / `99090b7` / `520abaf`
- lint 化の評価 (`docs/adr-rule-mapping.md:19-27` のチェックリストへの回答): 本 ADR の決定は特定の構文パターンではなく解決順序の性質であり、oxlint jsPlugin の AST パターンにも custom-rules の正規表現にも落ちない。したがって lint ルールは追加せず、対応表も更新しない (ADR-0004 以降の慣行に合わせる)
