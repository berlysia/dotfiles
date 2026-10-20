# document-workflow-guard の後続課題

`document-workflow-guard` の env 非依存化（ADR-0013）の調査中に見つかった、本体スコープ外の課題。コードの位置はファイル名と関数名で指す。着手時に現行のコードで再確認する。

## 課題 A: `&>` / `&>>` によるゲート回避

`document-workflow-guard.ts` のリダイレクト対象抽出は、`&` を先頭に持つトークンを一貫して除外する。

- `isRedirectionToken` は `/^(?:\d*>>?|\d*>\|)$/` にマッチするトークンのみをリダイレクトと認識する
- 分離形では、次トークンが `&` で始まると対象抽出から除外される（`!next.startsWith("&") && !isStderrRedirection(token)`）
- インライン形（`file>path` のように 1 トークンにまとまった形）では `!inline[3].startsWith("&")` が同様に `&` 始まりを除外し、加えて `inline[1] !== "2"` で `2>` 系の fd 番号を持つものを一律除外する
- `isStderrRedirection` は `/^2(>>?|>\|)$/` にマッチするトークンを stderr リダイレクトとして扱う

`!startsWith("&")` は `2>&1` / `>&2` のような fd 複製構文を誤検知しないための load-bearing なチェックで、単純に外すと正当な構文が偽陽性 deny になる。gate 閉時の repo 内ファイルの変更は tripwire（rolling `git status` baseline）が事後に検知して `off-plan-writes.log` に記録する。分類器そのものは変わっておらず、事前 deny としての穴は残る。

## 課題 B: 複合コマンド構文によるゲート回避

`lib/bash-parser.ts` の `extractCommandsStructured` は、tree-sitter でパースした `result.commands` を「入力全体と一致する 1 件」と「それ以外」に分け、後者のみを `individualCommands` として返す。`if` / `while` / 関数本体のような複合コマンドの内側のコマンドは、`parsingMethod: "tree-sitter"` のまま `individualCommands` から漏れうるので、複合コマンドの内側に隠れたリダイレクトは対象抽出から漏れる形になっている可能性がある。`lib/bash-parser.ts` には `if_statement` / `while_statement` の処理があり、すでに直っている可能性もある。着手時に再現して確かめる。事後検知は課題 A と同じ tripwire が担う。

## 課題 C: 非 Bash 経路の「対象不明 → allow」と、matcher に載らないツールが評価されないこと

- `document-workflow-guard.ts` は `getTargetFilePath` が対象パスを取れなかった場合に無条件で allow する（`if (!targetPath)` の分岐）
- 評価対象が `lib/guarded-tools.ts` の `GUARDED_TOOLS` と、`.settings.hooks.json.tmpl` の matcher の交差に限られており、この集合に無いツールは呼び出しごと評価を通過しない

Write/Edit の `file_path` 欠落はツール入力スキーマ違反であって抽出失敗ではなく、原因クラスが Bash 経路と異なるため、Bash 経路の対処とは別に扱う。

## 課題 E: `CLAUDE_TEST_CWD` の採用条件の限定と production からの除去

production コードで `process.env.CLAUDE_TEST_CWD` を読むファイルの数は、文書ごとに割れていた。着手時に `git grep CLAUDE_TEST_CWD -- home/dot_claude/hooks ':!*/tests/*'` で数え直し、それを SSoT にする。

機構の名指しに注意する。「`isOutsideProject` を全 allow に倒す」とは書かない。`isOutsideProject` は `resolve(cwd, expandTilde(path))` を偽 cwd 基準で解決するため、**相対パスのターゲットは偽 cwd 配下＝「プロジェクト内」と判定される**。全面解除の実体は、偽 cwd が `resolveWorkflowDir` の基準ごとすり替わり、`wfPaths.research` が不在になって `isWorkflowActive` が偽になることである（副次的に、リポジトリ内の**絶対パス**ターゲットは「プロジェクト外」と判定されて allow される）。K11 が塞いだものより強い kill-switch が同じ surface に残っている。

`NODE_TEST_CONTEXT` による gating を共有ヘルパにすると、新しい実装が古い lib を経由してしまう窓が開く。着手時は「lib 追加のみの段」を先に置く two-phase か、各 hook への複製かを先に決める。

## 課題 F: 死んだコードの削除

対象は `lib/workflow-paths.ts` の派生関数（`getPlanPath` 等）、`getWorkflowDir` / `getWorkflowDirRelative` のシム 2 本、`knip.json` の `-public` tag。強制力が無い理由は次の 3 点である。

1. `knip` は CI に配線されていない（`.github/` に `knip` の言及が無い）。
2. `workflow-paths.test.ts` が一族全体を import しているため、テストが死んだコードを緑で保護している。`bunx knip --no-progress` はシム 2 本も派生関数も報告しない。
3. `home/.chezmoiscripts/run_after_gc.sh.tmpl` が最大週 1 回 `bunx knip` をローカル実行する。報告のみでゲートではない。`set -euo pipefail` によりパイプの終了コードは knip のものになり、検出時は「knip reported issues」と出る。

## 課題 G: GC が guard を無言で disarm する経路

- GC（`home/.chezmoiscripts/run_after_gc.sh.tmpl`）は `find "$SESSIONS_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +` で**セッション dir 自身の mtime のみ**を見る。dir mtime はエントリの追加・削除でしか更新されないため、7 日以上休止した進行中 workflow を「中身のファイルを編集しながら再開する」形では触っても、削除対象のまま残る。
- 寿命は「7 日ちょうど」ではなく **7 日以上・上限なし**である。同スクリプトの `INTERVAL_DAYS=7` + `$HOME/.claude/.last-gc` の頻度ゲートがあり、さらに `run_after_` なので `chezmoi apply` を実行しなければ発火しない。
- これは「guard の無言 disarm」になる。`isWorkflowActive` はファイル存在判定のみで、ファイル存在が唯一の arming スイッチである。GC の `rm -rf` は、最安の自己解除である `rm <wfDir>/research.md` と同じ効果を、誰の操作もなく自動で起こす。承認状態・`off-plan-writes.log`・`plan-review.cache.json` も同時に消える。
- 隣接する 2 件も同じ課題に含める。1 つは `isOutsideProject` への `~/.claude/hooks/` denylist 案（実装コストは小さいが `isOutsideProject` の他の利用者への影響評価が別途要る）。もう 1 つは `CLAUDE_ENV_FILE` への書き込みで、`session.ts` は値を `shellSingleQuote` でエスケープして書くようになっている。

## 課題 H: 「guard の実行状態を可視化する」後続 spec

まだ設計されていない。3 つの責務（長期間走っていないことの検出 / `env-rejected`・`unresolvable` の再通知 / armed・deactivated の状態遷移告知）をまとめて扱う。ADR-0013 側には判断と 1-2 行の要約しか置かないため、**証拠一式はここが唯一の所在になる**。

### 1. 否定済みの設計空間

追記型 sink の候補 4 案は実測で否定されている。否定の理由は 2 つ。

- `finally` で書く上書き型スタンプは、例外を連発している最中も「健全」と報告する（実行された事実と結果が分離できていない）
- machine-global な単一レコードは、別プロジェクトの活動を自プロジェクトの活動と誤読する

### 2. 設計の起点

「実行の証拠を **per-project** に、**結果次元付き**で、**atomic** に残す」。再利用候補は `lib/insight-digest.ts` の `writeFileSyncAtomic` と `ensureDir`、`session.ts` の projectHash 導出（`context.input.cwd` の `/` を `-` に置換して先頭の `-` を落とす形）である。`insight-digest.ts` の所在は `implementations/` ではなく `lib/` 配下である。

### 3. `unresolvable` と `env-rejected` の可視性は非対称で、無言なのは後者である

- `unresolvable`: `document-workflow-guard.ts` が**毎ツール呼び出しで** systemMessage を返す。加えて `session.ts` が起動時にも出す。
- `env-rejected`: 出すのは `session.ts`（SessionStart の 1 回きり）と `compaction-testament.ts` で、セッション途中に読み手が見落とすと再通知が無い。
- したがって後続 spec が扱うべき再通知の主対象は `env-rejected` である。`unresolvable` については逆に「毎回出続けること」が正常時に鳴る警告として読み手に無視を訓練しないかを検討対象にする。両者は別方向の課題であり、ひとまとめに「再通知が要る」とは書かない。

### 4. 未解決の設計課題

状態遷移の告知（armed / deactivated）は未実装である。未解決の点は次の 2 つ。

- 判定媒体を wfDir 内に置くと GC / `git clean` で dir ごと消えて状態が読めなくなる（課題 G と同根）
- `cp -a` によるセッション引き継ぎで、前セッションの行が混入する

## 課題 I: `plan-review.cache.json` が git 追跡下のディレクトリに落ちる

`plan-review-automation.ts` は `const planDir = dirname(absoluteTargetPath);` でキャッシュ位置を決め、containment 検査を行わない。対象判定は `lib/workflow-paths.ts` の `getWorkflowDocumentType` が **basename のみ**を見る。

- 再現: 追跡下の `plan.md` または `spec.md`（例: `home/dot_claude/templates/spec.md`）を Write/Edit すると、同じディレクトリに `plan-review.cache.json` が作られる。`git check-ignore` にも掛からないため `git status` に現れて誤コミットされうる。
- `rules/workflow.md` の Session Artifact Retention は「実装計画（未着手・途中）は `docs/plans/` に移動」と指示しているため、`plan-N.md` の名前のまま移送すると同じ事故が起きる（かつ guard は wfDir スコープなのでそのファイルを workflow 文書として認識しない）。`docs/plans/` 配下に spec/plan を凍結コピーすると hook が反応して cache を作るので、コミット前に削除する運用が要る。

原因の切り分けと対処方針の検討は済んでいない。

## 課題 J: `CronCreate` で予約したプロンプトの「承認」を approval-recorder が利用者の入力として扱う

`document-workflow-guard` は `CronCreate` / `ScheduleWakeup` の PreToolUse で、承認の形の `prompt` を deny する（ADR-0023 の「改訂（2026-10-03）」節）。記録の仕組み（approval-recorder）は変えていない。残る点を下に置く。測定の詳細は ADR-0023 が指す表（M0〜M4）として下に残す。

- 調べていない入口: `RemoteTrigger`（クラウドの別セッションで実行されるので本セッションの recorder には届かない、というのは推論で未実測）、Monitor の通知（プロンプトとして届くときに本文が「承認」だけになるかは未実測）、Bash から `claude` を起動する経路（R4 と同じ Bash の迂回）。閉じたとは主張しない
- hook-timer の `source` / `prompt_id` の射影は残してある。Claude Code を更新して再測定するときに、`source` に値が入ったかを見る手段がこれだけだから
- 再訪のきっかけ: spec K7（承認の発話の判定）を改訂するとき、Claude Code の UserPromptSubmit の入力に出どころのフィールドが文書化されたとき、Claude Code を更新して下の測定をやり直すとき

### 測定（Claude Code 2.1.287）

hook-timer が入力の `source` / `prompt_id` を記録する（文字列だけを 64 文字で切る）。予約の試行は、承認が記録されないように存在しない文書名を付けた（`承認 plan-99.md`）。M0 だけは素の「承認」で、すべての試行は承認待ち 0 件で行った。

| 試行 | 経路                                         | hook 入力の `source` | `prompt_id` | recorder の分岐                                  | transcript の行（後で読んだもの）                                   |
| ---- | -------------------------------------------- | -------------------- | ----------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| M0   | 利用者がターミナルで「承認」と打つ（対照）   | 値なし               | あり        | 利用者の入力（「承認を待っている文書が無い」）   | `promptSource: queued` / `turnOrigin: human` / `origin.kind: human` |
| M1   | `CronCreate` 1 回限り                        | 値なし               | あり        | 利用者の入力（「plan-99.md は…満たしていない」） | `system` / `scheduled` / `scheduledTaskId` あり                     |
| M2   | `/loop 1m`（`CronCreate` の繰り返し）        | 値なし               | あり        | 利用者の入力                                     | `system` / `scheduled` / `scheduledTaskId` あり                     |
| M3   | `ScheduleWakeup`                             | 値なし               | あり        | 利用者の入力                                     | `system` / `scheduled` / `scheduledTaskId` あり                     |
| M4   | `ScheduleWakeup`（承認の形でない `J-probe`） | 値なし               | あり        | （発話でないので recorder は無言）               | `system` / `scheduled` / `scheduledTaskId` あり                     |

- 「値なし」の根拠: hook-timer の記録は `null` で、同じ発火の approval-recorder は `stderr_bytes: 0` だった。cc-hooks-ts は `source` を picklist で検証するので、文字列以外の値なら parse に失敗して stderr に出る。よって値そのものが無い。hook 入力の `source` と transcript の `promptSource` は別の語彙である
- 2.1.287 では、利用者が打ったプロンプトと予約が発火させたプロンプトの間で、hook 入力の `source` に差が無い（どちらも値なし）。cc-hooks-ts 2.1.281 の型にある `loop_wakeup` / `schedule_wakeup` は、この版では届かない
- `prompt_id` はすべての経路で hook 入力に載り、transcript 行の `promptId` と一致した
- transcript 行は予約と利用者の入力を区別する（`turnOrigin: scheduled` と `human`、`origin.kind: human` の有無、`scheduledTaskId` の有無）。ただし UserPromptSubmit の hook の実行時点では、どの経路でも当該行がファイル全体に無かった。UserPromptSubmit の hook からは、この区別を読めない
- `ScheduleWakeup` は、発火の後で次の `ScheduleWakeup` を呼ばずにターンを閉じると、同じ prompt で約 20 分後に自動で予約し直される。`ScheduleWakeup` に「承認」を 1 回渡すと、同じ文面が繰り返し発火しうる。止めるには `ScheduleWakeup` に `stop: true` を渡す
- 推論（未実測）: 予約の経路で承認待ちが 1 件あれば、素の「承認」は記録される。上の 4 経路はどれも、記録する側の分岐（利用者の入力）に入ったため
- PreToolUse の時点で、当該プロンプトの transcript 行が読めた（実測、1 件、利用者の入力の経路のみ。予約の発火の後の PreToolUse では測っていない）。公式ドキュメント（hooks の `transcript_path`）は、transcript が非同期に書かれ、hook の発火時点で最新のメッセージを含まないことがあると書いており、この観測は保証されない

### AskUserQuestion で承認を受ける案の測定

model が入力の `answers` に値（`A`）を先に入れて AskUserQuestion を呼び、利用者には「質問が出たら B を選ぶ」と伝えた。

| 時点                                          | 見えた `answers`  | 出典                                                               |
| --------------------------------------------- | ----------------- | ------------------------------------------------------------------ |
| model の tool_use 入力                        | `A`               | transcript                                                         |
| PreToolUse / PermissionRequest の hook の入力 | `A`（model の値） | `~/.claude/logs/decisions.jsonl`（auto-approve の 3 層とも `ask`） |
| ツールの結果（`toolUseResult`）               | `B`               | transcript                                                         |

- `answers` を先に入れても質問の UI は出て、結果は利用者が選んだ `B` になった。PreToolUse と PermissionRequest の時点の hook には model が入れた値が見える。この時点で回答を読んで承認を記録すると、model が承認を作れる
- 推論（未実測）: PostToolUse の `tool_response.answers` は利用者の回答（`B`）である。hook の入力そのものは記録していない
- 確かめていないこと: PermissionRequest が UI なしで通る場合（hook が `allow` を返す、bypassPermissions のモード）に、model の値がそのまま結果になるか。公式ドキュメントは、AskUserQuestion はどのモードでも自動承認されず、PreToolUse が `allow` だけを返しても足りず、`updatedInput` と組にする必要があると書く。UI を飛ばせるのは hook が `answers` を自分で返すときで、その値は model の入力ではなく hook が書いた値になる、というのは文書からの推論である

## 課題 K: 二層の plan-N の条件が診断で ✓/✗ の行にならない

`diagnoseGate`（`lib/workflow-gate.ts`）は、二層の plan-N の条件（未承認、parent-spec-hash の不一致）を ✓/✗ の行にせず `note` でしか示さない。`workflow-gate.test.ts` の不変条件テストは「✗ 行か `note:` 行があり、satisfied と言わない」までを守り、note の文言が本当の原因を名指ししているかは検証しない。

判定を診断から導く形（`evaluateTarget = decide(diagnose(...))`）は、`GateDiagnosis` を plan-N 単位に作り直す必要があり、判定と診断のずれが research.md の 1 条件だけだった間は範囲に見合わないので採っていない。着手の条件は、別の条件で判定と診断がずれたとき。

## 課題 L: 承認行の値が空のとき、hash の正規化が次の行を落とす

- 再現: `computeDocumentHash(content, SPEC_NORMALIZERS)` は、承認行が `- Approval Status:`（値なし）または空白だけのとき、その次の行を hash から落とす。次の行だけが違う 2 つの文書が、同じ hash になる。

  | 承認行                            | 次の行が `LINE-A` | 次の行が `LINE-B` |
  | --------------------------------- | ----------------- | ----------------- |
  | `- Approval Status: pending`      | `3ff5ee5089d0`    | `9345699391c4`    |
  | `- Approval Status:`              | `ddc8b939f327`    | `ddc8b939f327`    |
  | `- Approval Status: `（空白のみ） | `ddc8b939f327`    | `ddc8b939f327`    |

- 原因: `home/dot_claude/hooks/lib/document-hash.ts` の正規化 `c.replace(/^(- Approval Status:)\s*.*$/m, "$1")` で、`\s*` が改行に一致する。値が空だと行末の改行を越え、続く `.*` が次の行を取り込む。
- 推論（未実測）: 承認の迂回には使いにくい。承認が記録されると承認行に `approved` が入り、次の行が hash に戻るので、記録した hash と合わなくなって gate が閉じる。テンプレートどおりの文書では、承認行の次は空行と marker なので害が出ない。
- 承認行を書き換える側（`lib/workflow-marker.ts` の `setApprovalStatusLine`）の正規表現は `/^- Approval Status:.*$/m` で、`\s*` を含まない。値が空の文書を承認しても、次の行は消えない。次の行を落とすのは hash の正規化の側だけである。
- 修正の案: `\s*` を `[ \t]*` にする。
- 再訪のきっかけ: hash の正規化を変えると、承認済みの進行中の文書がすべて deny される。reference skill の「S3 デプロイ移行手順」を伴う作業になる。他の理由で正規化を変えるときに、合わせて直す。
