# document-workflow-guard の後続課題

`document-workflow-guard` の env 非依存化（ADR-0013）の調査中に発見した、本体スコープ外の課題をまとめる。実測は全て 2026-08-28〜2026-09-04 時点。session 成果物（`.tmp/sessions/`）は GC で失われるため、再調査コストの高い事実をここへ移送している。

設計層（spec）が列挙したのは 8 件だが、本ドキュメントは 9 件を扱う。課題 I は plan のレビュー中に新規発見したものを追加した。spec は承認済みで凍結されており本 plan は spec を触らないため、spec だけを読んだ人が 9 件目を見落とさないよう、この橋渡しをここに置く。

## 2026-09-10 更新: ADR-0015 での扱い

`docs/decisions/0015-document-workflow-operator-ergonomics.md` の実装で以下が変わった。

- **課題 D は解消**: `workflow-bash-sync`（PostToolUse `Bash`）が wfDir 内 spec/plan/plan-N の内容 hash 差分で編集を検知し、`plan-review-automation` と同じ推奨を出す。tool 名の allowlist には依存しない。
- **課題 A / B は事後検知の対象になった**: gate 閉時に repo 内ファイルが変わると tripwire（rolling `git status` baseline）が検知して `off-plan-writes.log` に記録する。分類器のリダイレクト・複合コマンド解析そのものは未変更で、事前 deny としての穴は残る。tree-sitter 側の対応は引き続き別タスク。
- **課題 I は未解消のまま**: `plan-review.cache.json` は依然 plan と同ディレクトリに落ちる。`docs/plans/` 配下に spec/plan を凍結コピーすると hook が反応して cache を作るので、コミット前に削除する運用が必要。

## 課題 A: `&>` / `&>>` によるゲート回避

`document-workflow-guard.ts` のリダイレクト対象抽出は、`&` を先頭に持つトークンを一貫して除外する形になっている。

- `isRedirectionToken`（`document-workflow-guard.ts:764`）は `/^(?:\d*>>?|\d*>\|)$/` にマッチするトークンのみをリダイレクトと認識する
- 分離形の場合、`document-workflow-guard.ts:744-745` の `!next.startsWith("&") && !isStderrRedirection(token)` により、次トークンが `&` で始まると対象抽出から除外される
- インライン形（`file>path` のように 1 トークンにまとまった形）の場合、`document-workflow-guard.ts:754-755` の `!inline[3].startsWith("&")` が同様に `&` 始まりを除外し、加えて `inline[1] !== "2"` により `2>` 系の fd 番号を持つものを一律除外する
- `isStderrRedirection`（`document-workflow-guard.ts:768`）は `/^2(>>?|>\|)$/` にマッチするトークンを stderr リダイレクトとして扱う

未着手である理由: ユーザー判断で別タスクに切り出すことを確定済み（2026-08-28）。`!startsWith("&")` は `2>&1` / `>&2` のような fd 複製構文を誤検知しないための load-bearing なチェックであり、単純に外すと `2>&1` のような正当な構文が偽陽性 deny になる。

## 課題 B: 複合コマンド構文によるゲート回避

`lib/bash-parser.ts` の `extractCommandsStructured`（`lib/bash-parser.ts:927-974`）は tree-sitter でパースした `result.commands` を「入力全体と一致する 1 件」と「それ以外」に分け、後者のみを `individualCommands` として返す。`if` / `while` / 関数本体のような複合コマンドは、内部の個々のコマンドが `parsingMethod: "tree-sitter"` のまま `individualCommands` から漏れる形になっており、複合コマンド構文の内側に隠れたリダイレクトはこの経路で対象抽出から漏れる。

未着手である理由: ユーザー判断で別タスクに切り出すことを確定済み（2026-08-28）。

## 課題 C: 非 Bash 経路の「対象不明 → allow」と、matcher に載らないツールが評価されないこと

- `document-workflow-guard.ts:167-169` は `getTargetFilePath` が対象パスを取れなかった場合に `if (!targetPath) { return context.success({}); }` で無条件 allow する
- 評価対象そのものが `GUARDED_TOOLS`（`document-workflow-guard.ts:24-30`、`Write` / `Edit` / `MultiEdit` / `NotebookEdit` / `Bash` の 5 種）と `.settings.hooks.json.tmpl:4` の matcher（`"Write|Edit|MultiEdit|NotebookEdit|Bash"`）の交差に限られており、この集合に無いツールは呼び出しごと評価を通過しない

未着手である理由: K10b は Bash 経路のみを対象とした。Write/Edit の `file_path` 欠落はツール入力スキーマ違反であって抽出失敗ではなく、原因クラスが異なるため同じ後続タスクに含めなかった。

## 課題 D: Bash 経由の spec/plan 編集が 3 hook を迂回する

`lib/workflow-tool-input.ts:21,37-39` の `EDIT_TOOLS` は `Write` / `Edit` / `MultiEdit` / `NotebookEdit` の 4 種のみを allowlist に持ち、`isWorkflowDocumentEdit` はこれ以外のツール名（`Bash` を含む）に対して `isEdit: false` を早期 return する。Bash のヒアドキュメントやリダイレクトで spec.md / plan-N.md の内容を書き換えても、この判定を消費する `plan-review-automation` / `spec-plan-placeholder-scan` / `spec-plan-self-audit` の 3 hook はいずれも編集として認識しない。

未着手である理由: allowlist の拡張は各 hook の入力前提（`tool_input.file_path` の存在）に波及するため、独立タスクとして切り出す必要がある。

## 課題 E: `CLAUDE_TEST_CWD` の採用条件の限定と production からの除去

production コードで `process.env.CLAUDE_TEST_CWD` を読むのは次の **7 ファイル**である: `spec-plan-self-audit.ts:27`、`plan-review-automation.ts:554-555`、`block-plan-mode.ts:22`、`file-access-guard.ts:330`、`document-workflow-guard.ts:228`、`lessons-learned-extractor.ts:102`、`spec-plan-placeholder-scan.ts:34`。

リポジトリ内で数え方が割れている。設計層（spec）は 1 箇所で「6 ファイル 7 箇所」（`file-access-guard.ts` が漏れている）、別の箇所で「5 hook」と書いており、spec 内部でも 5 と 6 に割れている。`session.ts:127` のコメントは "five CLAUDE_TEST_CWD readers" と書く。実測は 7。本ドキュメントの 7 を以後の SSoT とする。

機構の名指しに注意する: 「`isOutsideProject` を全 allow に倒す」とは書かない。`document-workflow-guard.ts:275-277` の `isOutsideProject` は `resolve(cwd, expandTilde(path))` を偽 cwd 基準で解決するため、**相対パスのターゲットは偽 cwd 配下＝「プロジェクト内」と判定される**。全面解除の実体は、偽 cwd が `resolveWorkflowDir` の基準ごとすり替わり、`wfPaths.research` が不在になって `isWorkflowActive` が偽になることである（副次的に、リポジトリ内の**絶対パス**ターゲットは「プロジェクト外」と判定されて allow される）。K11 が塞いだものより強い kill-switch が同じ surface に残っている、という結論自体は正しい。

未着手である理由: `NODE_TEST_CONTEXT` による gating を共有ヘルパにすると、新しい実装が古い lib を経由してしまう窓が開く。後続では「lib 追加のみの段」を先に置く two-phase か、各 hook への複製かを先に決める必要がある。

## 課題 F: 死んだコードの削除

対象は派生 8 関数（`getPlanPath` 等）、`getWorkflowDir` / `getWorkflowDirRelative` のシム 2 本、`knip.json` の `-public` tag。強制力が無い理由は次の 3 点である。

1. `knip` は CI に配線されていない。`grep -rn "knip" .github/` はヒット 0。
2. `home/dot_claude/hooks/tests/unit/workflow-paths.test.ts:6-23` が一族全体を import しているため、テストが死んだコードを緑で保護している。実測: `bunx knip --no-progress` の出力は `Unused exported types (1) WorkflowDirUnresolvableReason` のみで、シム 2 本も派生関数も報告されない。
3. `home/.chezmoiscripts/run_after_gc.sh.tmpl:64-75` が最大週 1 回 `bunx knip` をローカル実行する。これは報告のみでゲートではない。（2026-09-24 訂正: 以前「`| tail -20` の終了コードで常に clean になる」と書いていたが誤り。同スクリプト 9 行目の `set -euo pipefail` によりパイプの終了コードは knip のものになり、検出時は「knip reported issues」と出る。）

加えて、`document-workflow-guard.ts` の未使用 import `isWorkflowDocument` の除去は spec.md の K8 項目 6 に含まれていたが、plan-2 の `25a3aac` で既に解消済みである（実測: 同ファイルに `isWorkflowDocument` は 1 件も残っていない）。本課題からは除外する。

## 課題 G: GC が guard を無言で disarm する経路

- GC（`home/.chezmoiscripts/run_after_gc.sh.tmpl:28-32`）は `find "$SESSIONS_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +` で**セッション dir 自身の mtime のみ**を見る。dir mtime はエントリの追加・削除でしか更新されないため、7 日以上休止した進行中 workflow を「中身のファイルを編集しながら再開する」形では触っても、削除対象のまま残る。
- 寿命は「7 日ちょうど」ではなく **7 日以上・上限なし**である。`run_after_gc.sh.tmpl:11-23` に `INTERVAL_DAYS=7` + `$HOME/.claude/.last-gc` の頻度ゲートがあり、さらに `run_after_` なので `chezmoi apply` を実行しなければ発火しない。
- 本変更後、これは「guard の無言 disarm」になる。`isWorkflowActive` はファイル存在判定のみで、env を on/off スイッチから外した以上、ファイル存在が唯一の arming スイッチである。GC の `rm -rf` は、最安の自己解除である `rm <wfDir>/research.md` と同じ効果を、誰の操作もなく自動で起こす。承認状態・`off-plan-writes.log`・`plan-review.cache.json` も同時に消える。
- 隣接する 2 件も同じ課題に含める。1 つは `session.ts` の `CLAUDE_ENV_FILE` への未エスケープ書き込み（既知。詳細は `docs/plans/hook-target-diagnostics-followups.md` を参照し、ここでは記述を複製しない）。もう 1 つは `isOutsideProject` への `~/.claude/hooks/` denylist 案（実装コストは小さいが `isOutsideProject` の他の利用者への影響評価が別途要る）。

## 課題 H: 「guard の実行状態を可視化する」後続 spec

他の 8 件と違い、これはまだ設計されていない。本 spec から切り出した 3 つの責務（長期間走っていないことの検出 / `env-rejected`・`unresolvable` の再通知 / armed・deactivated の状態遷移告知）をまとめて扱う。

ADR-0013 側には判断と 1-2 行の要約しか置かないため、**証拠一式はここが唯一の所在になる**。

### 1. 否定済みの設計空間

追記型 sink の候補 4 案は実測で否定されている。否定の理由は 2 つ。

- `finally` で書く上書き型スタンプは、例外を連発している最中も「健全」と報告する（実行された事実と結果が分離できていない）
- machine-global な単一レコードは、別プロジェクトの活動を自プロジェクトの活動と誤読する

### 2. 設計の起点

「実行の証拠を **per-project** に、**結果次元付き**で、**atomic** に残す」。再利用候補は `home/dot_claude/hooks/lib/insight-digest.ts:309` の `writeFileSyncAtomic` と、同ファイル `:320` の `ensureDir`。もう 1 つは `session.ts:139-141` の projectHash 導出（`context.input.cwd` の `/` を `-` に置換して先頭の `-` を落とす形）である。`insight-digest.ts` の所在は `implementations/` ではなく `lib/` 配下であり、projectHash の行は guard 判定の docstring とは無関係なので、それぞれの所在を混同しない。

### 3. `unresolvable` と `env-rejected` の可視性は非対称で、無言なのは後者である

- `unresolvable`: `document-workflow-guard.ts:76-84` が**毎ツール呼び出しで** systemMessage を返す。加えて `session.ts:203-209` が起動時にも出す。
- `env-rejected`: `grep -rn "env-rejected" home/dot_claude/hooks/implementations/*.ts` は `session.ts:224` の 1 箇所のみ。すなわち **SessionStart の 1 回きり**で、セッション途中に読み手が見落とすと再通知が無い。
- したがって後続 spec が扱うべき再通知の主対象は `env-rejected` である。`unresolvable` については逆に「毎回出続けること」が正常時に鳴る警告として読み手に無視を訓練しないかを検討対象にする。両者は別方向の課題であり、ひとまとめに「再通知が要る」とは書かない。

### 4. 未解決の設計課題

状態遷移の告知（armed / deactivated）は、Round 1 のレビューで一度「要修正」と判定され実装予定だったものを、後続ラウンドの縮小で意図的に外した後退である。未解決のまま残っているのは次の 2 点。

- 判定媒体を wfDir 内に置くと GC / `git clean` で dir ごと消えて状態が読めなくなる（課題 G と同根）
- `cp -a` によるセッション引き継ぎで、前セッションの行が混入する

## 課題 I: `plan-review.cache.json` が git 追跡下のディレクトリに落ちる

`plan-review-automation.ts:291-294` は `const planDir = dirname(absoluteTargetPath);` でキャッシュ位置を決め、containment 検査を行わない。対象判定は `getWorkflowDocumentType`（`home/dot_claude/hooks/lib/workflow-paths.ts:108-121`）で **basename のみ**を見る。

- 実測: 本リポジトリには追跡下の `plan.md`（リポジトリルート）と `home/dot_claude/templates/spec.md` が実在する。どちらかを Write/Edit すると `plan-review.cache.json` が追跡下ディレクトリに作られ、`git check-ignore` にも掛からないため `git status` に現れて誤コミットされうる。
- `rules/workflow.md` の Session Artifact Retention は「実装計画（未着手・途中）は `docs/plans/` に移動」と指示しているため、`plan-N.md` の名前のまま移送すると同じ事故が起きる（かつ guard は wfDir スコープなのでそのファイルを workflow 文書として認識しない）。

未着手である理由: 本 plan のレビューで新規に発見したため、原因の切り分けと対処方針の検討がまだ済んでいない。

## 課題 J: `CronCreate` で予約したプロンプトの「承認」を approval-recorder が利用者の入力として扱う

ADR-0023 Consequences 12 の配備後実測（plan-5 T5 Step 6）で確認した。Claude Code 2.1.287、2026-10-02。

- 実測: 承認待ちが 0 件のセッションで、`CronCreate`（1 回限り、prompt=`承認`）を 18:42 に予約した。recorder の返答は「承認を待っている文書が無いので、何も記録していない。」で、`source` が `user` 以外のときの分岐（「利用者が打ったものではない（source=…）」、`approval-recorder.ts:162-173`）に入らなかった。発火が予約から来たことは、ジョブが消えていたことと、その時間帯の approval-recorder の発火が 09:42:00Z の 1 件（`stdout_bytes: 298`）だけだったことで確かめた。
- 推論（未実測）: 分岐のコードから、この経路の `source` は `user` か値なしで届いている。したがって承認待ちが 1 件あるときに model が `CronCreate` で「承認」だけのプロンプトを予約すると、recorder はそれを承認として記録する。ADR-0023 はこれを意図的な迂回（spec R4 の外）として受け入れているが、「`source` で予約のプロンプトを区別できる」という前提は、少なくとも `CronCreate` の経路では成り立たない。
- 再訪のきっかけ: spec K7（承認の発話の判定）を改訂するとき、Claude Code の UserPromptSubmit の入力に出どころのフィールドが文書化されたとき、Claude Code を更新して下の測定をやり直すとき。

### 実測の補完（2026-10-02、Claude Code 2.1.287）

計装: hook-timer が入力の `source` / `prompt_id` を記録する（文字列だけを 64 文字で切る）。approval-recorder は承認の形の発話への返答の末尾に `probe:` 行を付ける（`lib/prompt-origin-probe.ts`）。probe は、recorder の実行時点の transcript から `prompt_id` が一致する user 行を探し、その `promptSource` / `turnOrigin` を出す。予約の試行は、承認が記録されないように存在しない文書名を付けた（`承認 plan-99.md`）。`source` の分岐は文書名の分岐より前にあるので、どちらの分岐に入ったかは返答で分かる。M0 だけは素の「承認」で、すべての試行は承認待ち 0 件で行った。

| 試行 | 経路                                         | hook 入力の `source` | `prompt_id` | recorder の分岐                                  | probe（recorder の実行時点）    | transcript の行（後で読んだもの）                                   |
| ---- | -------------------------------------------- | -------------------- | ----------- | ------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------- |
| M0   | 利用者がターミナルで「承認」と打つ（対照）   | 値なし               | あり        | 利用者の入力（「承認を待っている文書が無い」）   | `transcript=missing scope=file` | `promptSource: queued` / `turnOrigin: human` / `origin.kind: human` |
| M1   | `CronCreate` 1 回限り                        | 値なし               | あり        | 利用者の入力（「plan-99.md は…満たしていない」） | `transcript=missing scope=file` | `system` / `scheduled` / `scheduledTaskId` あり                     |
| M2   | `/loop 1m`（`CronCreate` の繰り返し）        | 値なし               | あり        | 利用者の入力                                     | `transcript=missing scope=file` | `system` / `scheduled` / `scheduledTaskId` あり                     |
| M3   | `ScheduleWakeup`                             | 値なし               | あり        | 利用者の入力                                     | `transcript=missing scope=file` | `system` / `scheduled` / `scheduledTaskId` あり                     |
| M4   | `ScheduleWakeup`（承認の形でない `J-probe`） | 値なし               | あり        | （発話でないので recorder は無言）               | （なし）                        | `system` / `scheduled` / `scheduledTaskId` あり                     |

- 「値なし」の根拠: hook-timer の記録は `null` で、同じ発火の approval-recorder は `stderr_bytes: 0` だった。cc-hooks-ts は `source` を picklist で検証するので、文字列以外の値なら parse に失敗して stderr に出る。よって値そのものが無い。hook 入力の `source` と transcript の `promptSource` は別の語彙である
- 観測から言えること:
  - 2.1.287 では、利用者が打ったプロンプトと予約が発火させたプロンプトの間で、hook 入力の `source` に差が無い（どちらも値なし）。cc-hooks-ts 2.1.281 の型にある `loop_wakeup` / `schedule_wakeup` は、この版では届かない。ADR-0023 Consequences 12 の「値が無いのは古い Claude Code」という前提は、2.1.287 では成り立たない
  - `prompt_id` はすべての経路で hook 入力に載り、transcript 行の `promptId` と一致した
  - transcript 行は予約と利用者の入力を区別する（`turnOrigin: scheduled` と `human`、`origin.kind: human` の有無、`scheduledTaskId` の有無）。ただし recorder の実行時点では、どの経路でもファイル全体に当該行が無かった（`scope=file`）。行の `timestamp` は hook の開始より 20〜30 ms 前だが、書き出しは hook の後である。したがって UserPromptSubmit の hook からは、この区別を読めない
  - `ScheduleWakeup` は、発火の後で次の `ScheduleWakeup` を呼ばずにターンを閉じると、同じ prompt で約 20 分後に自動で予約し直された（M4 の後と M3 の後に 1 回ずつ。M3 の再発火は 11:26Z に `承認 plan-99.md` として届いた）。`ScheduleWakeup` に「承認」を 1 回渡すと、同じ文面が繰り返し発火しうる。止めるには `ScheduleWakeup` に `stop: true` を渡す
- 推論（未実測）: 予約の経路で承認待ちが 1 件あれば、素の「承認」は記録される。上の 4 経路はどれも、記録する側の分岐（利用者の入力）に入ったため
- probe は recorder の実行時点の観測である。判定を別の hook（例: Stop や次の PreToolUse）に置けば transcript の行は書き出された後になりうるが、それは測っていない
- 次の一手: spec K7 の改訂を別の計画で決める。論点は次のどれを採るか。probe と hook-timer の射影を残すか外すかも、その計画で決める
  - (a) 予約の迂回を R4 の外として受け入れ続け、ADR-0023 の前提の記述だけを直す
  - (b) 承認の記録を UserPromptSubmit から、transcript が書き出された後に読める時点へ移す
  - (c) 承認を発話ではなく、model が出す AskUserQuestion への回答で受け取る。予約したプロンプトは UI に答えられないので、課題 J の経路そのものが無くなる

### AskUserQuestion 案（c）の測定（2026-10-02、Claude Code 2.1.287）

model が入力の `answers` に値（`A`）を先に入れて AskUserQuestion を呼び、利用者には「質問が出たら B を選ぶ」と伝えた。

| 時点                                          | 見えた `answers`  | 出典                                                               |
| --------------------------------------------- | ----------------- | ------------------------------------------------------------------ |
| model の tool_use 入力                        | `A`               | transcript                                                         |
| PreToolUse / PermissionRequest の hook の入力 | `A`（model の値） | `~/.claude/logs/decisions.jsonl`（auto-approve の 3 層とも `ask`） |
| ツールの結果（`toolUseResult`）               | `B`               | transcript                                                         |

- 観測: `answers` を先に入れても質問の UI は出て（利用者の申告）、結果は利用者が選んだ `B` になった
- 観測: PreToolUse と PermissionRequest の時点の hook には model が入れた値が見える。この時点で回答を読んで承認を記録すると、model が承認を作れる
- 推論（未実測）: PostToolUse の `tool_response.answers` は利用者の回答（`B`）である。cc-hooks-ts の型で `AskUserQuestionOutput.answers` は必須で、transcript の結果も `B` だった。hook の入力そのものは記録していない
- 確かめていないこと:
  - PermissionRequest が UI なしで通る場合（hook が `allow` を返す、bypassPermissions のモード）に、model の値がそのまま結果になるか。入力の説明は「answers collected by the permission component」で、今回 UI が出たのは、この環境の auto-approve が AskUserQuestion を「User decision tool」として必ず `ask` にしているためかもしれない。そうなら (c) の安全性は permission の設定に依存する
  - Remote Control 経由のデスクトップアプリで質問の UI が出て、回答が届くか

## 課題 K: `research.md` が無いことによる deny を、診断が理由として示さない

ADR-0023 の配備後実測の作業中に踏んだ。2026-10-02。

- 実測: wfDir に `plan.md` だけがあり（`research.md` なし）、plan.md の 6 条件（Plan / Review / Approval Status / marker verdict / hash match / approval）がすべてそろった状態で、`## Files` に載せたファイルを Edit すると deny された。deny の理由は 6 条件すべてに ✓ を付け、「Next: The gate conditions are satisfied.」と書いていた。`research.md` を書いた後は同じ Edit が通った。
- 原因: `evaluateTarget`（`home/dot_claude/hooks/lib/workflow-gate.ts:375`）は `research.md` が無いと deny する。一方 `diagnoseGate` は `research.md` か `plan.md` のどちらかがあれば workflow を有効とみなし（同 `:164`）、plan の 6 条件だけを表示する。判定が見る条件と、診断が表示する条件が一致していない。
- 影響: 診断が「満たされている」と言うので、利用者も model も次の一手を診断から得られない。`workflow-cli status`（対象なし）も、すべて ✓ の下で 1 行目に「is blocked」と表示する。
- 対処の候補: `diagnoseGate` が `research.md` の有無を 7 つ目の条件として表示する。または、単層モードで `research.md` を要求するかどうかを見直す（rules/workflow.md の共通フロー step 1 は research.md を書くとしている）。

解消（2026-10-02）: 候補のうち診断に条件を出す側（a）を採った。

- 採用した形: research.md の有無を `researchExists(wfPaths)` の 1 つの述語に寄せ、`evaluateTarget`・`diagnoseGate`（`research` と `active`）・`isImplementationPhase`・`isWorkflowActive` がそれを呼ぶ。`GateDiagnosis.research` に `✓/✗ research.md` の行を持たせ、research.md が無いときはそれを最初の失敗として扱う（`Next:` は research.md を書く指示、二層の plan-N の `note` は出さない）。
- 判定側の穴も同じ根で塞いだ。`isImplementationPhase` が research.md を見ていなかったため、research.md が無い間は guard の Bash インタプリタ書き込みチェックと tripwire が止まっていた。いまは gate が閉じているものとして扱う。
- status: 判定を断定するヘッダ（`formatGateDiagnosis`）と、条件のチェックリスト（`formatGateChecklist`）を分けた。対象なしの `status` は「is blocked」と断定せず、中立のヘッダで条件を並べる。二層では plan-N 側を評価しないので、spec.md が通っても allowed とは言えないため。
- research.md の要求は残した（見直し案（b）は採らない）。要求は共通フロー step 1、root `plan.md` の DW-06、`workflow-gate.test.ts` の「an approved plan without research.md still denies」で固定された意図であり、不具合は要求があることではなく診断に出ないことだった。
- 見送った再設計: 判定を診断から導く（`evaluateTarget = decide(diagnose(...))`）形。`GateDiagnosis` を plan-N 単位に作り直す必要があり、課題 K の不一致は research.md の 1 条件だけなので範囲に見合わない。着手の条件は、別の条件で判定と診断がずれたとき。
- 残る穴: 二層の plan-N の条件（未承認、parent-spec-hash の不一致）は、診断では ✓/✗ の行にならず `note` でしか示されない。`workflow-gate.test.ts` の不変条件テストは「✗ 行か `note:` 行があり、satisfied と言わない」までを守り、note の文言が本当の原因を名指ししているかは検証しない。
