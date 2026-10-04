# Research: Issue #235 — Bash パーサーの超線形時間

対象は `home/dot_claude/hooks/lib/bash-parser.ts`（1121 行）と、それを通る 3 つの guard hook。
計測は 2026-10-04、この worktree（d37c2ab）、bun 1.4.0、web-tree-sitter 0.26.8、tree-sitter-bash 0.25.1。
計測スクリプトは session の scratchpad にあり、repo には入れていない。数値はどれも 1 回の実行。

## 1. Issue の記述と実測の対応

Issue #235 は 4 つの形を挙げ、原因を「推定（未確認）」としていた。実測すると、原因は 2 種類に分かれる。

| 形                       | Issue の推定                    | 実測した原因                                                                             |
| ------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `xargs ` の繰り返し      | メタコマンドの再帰              | 推定どおり。加えて無条件の `console.error` が出力を 3 乗にする                           |
| `a \| ` の繰り返し       | 記載なし                        | tree-sitter の parse 自体（構文エラーの回復）                                            |
| `(a) ` の繰り返し        | `collectExecutableTexts` も寄与 | tree-sitter の parse 自体。`collectExecutableTexts` が遅いのは 2 回目の parse をするから |
| `echo ` + `>` の繰り返し | パーサー                        | tree-sitter の parse 自体                                                                |

## 2. 欠陥 A: 構文エラーのある入力で tree-sitter の parse が超線形

`a | `・`(a) `・`>` の繰り返しは、どれも bash の構文として誤りである（`rootNode.hasError === true`）。
`parseForCollect`（`parser.parse` だけを呼ぶ）の時間と、抽出まで含めた時間はほぼ等しい。

| 形      | 文字数 | parse だけ | `extractBaseCommands` | `collectExecutableTexts` | `extractCommandsStructured` |
| ------- | ------ | ---------- | --------------------- | ------------------------ | --------------------------- |
| `>`     | 5k     | 131 ms     | 131 ms                | 128 ms                   | 251 ms                      |
| `>`     | 10k    | 520 ms     | 486 ms                | 468 ms                   | 945 ms                      |
| `a \| ` | 20k    | 402 ms     | 261 ms                | 299 ms                   | 599 ms                      |
| `(a) `  | 20k    | 645 ms     | 678 ms                | 657 ms                   | 1,312 ms                    |
| `>`     | 20k    | 1,638 ms   | 1,658 ms              | 1,659 ms                 | 3,297 ms                    |
| `(a) `  | 100k   | 15,419 ms  | —                     | —                        | —                           |
| `>`     | 100k   | 45,654 ms  | —                     | —                        | —                           |

同じ形でも構文が正しければ線形である（1 プロセス 1 parse で計測）。

| 形                       | 100k   | 200k            |
| ------------------------ | ------ | --------------- |
| `a \| a \| … \| a`       | 159 ms | 297 ms          |
| `a && a && … && a`       | 31 ms  | 53 ms           |
| `ls -la; ls -la; … true` | 36 ms  | 52 ms（別計測） |
| `cat > f <<'EOF'` + 本文 | 3 ms   | 5 ms            |

`extractCommandsStructured` は同じ文字列を 2 回 parse する（`parseWithTreeSitter` の `bash-parser.ts:531` と、`collectExecutableTexts` 経由の `parseForCollect` の `bash-parser.ts:950-954`）。
`<<` を含むコマンドでは `maskDataHeredocBodies`（`heredoc-data.ts:518-523`）がもう 1 回 parse する。
3 つの hook はどれも `prepareDenyInput`（`deny-input.ts:33-38`）からこの経路に入る。

`a | ` の形は 60k 文字以上で wasm が `RuntimeError: Aborted()` を投げる（約 1.0〜1.2 秒後）。
現在のコードはこれを catch して fallback に落とすが、2 回目の parse も同じ時間をかけて同じ例外になる。

## 3. 欠陥 B: メタコマンドの再帰が 2 乗の出力と 3 乗のログを作る

`xargs ` の繰り返しは構文が正しく、parse は 100k 文字で 28 ms である。
時間は `extractMetaCommands`（`bash-parser.ts:672-805`）が使う。

- `xargs` のパターン `/(.+)/`（`bash-parser.ts:108`）が残り全部を取り、`extractCommandsInternal`（`bash-parser.ts:644-670`）を再帰で呼ぶ。入れ子の段ごとに 1 回再帰し、各段が残りの文字列全体を走査する
- 各段は `[その段の文字列, ...内側の結果]` を返すので、結果はすべての接尾辞になる。5k 文字の入力で 833 個・合計 208 万文字（入力の 2 乗）
- `console.error` が各段で結果を `join(", ")` して出す（`bash-parser.ts:742`、`791`、`484`）。`console.error` を数えるだけの関数に差し替えて測ると、5k 文字で stderr が 1.16 GB になる（入力の 3 乗）
- 引数 `processed`（`Set<string>`）は `add` されるだけで、どこからも読まれていない（`bash-parser.ts:710`、`759`、`852`）

ログを捨てたときの `extractBaseCommands` は 1.2k = 20 ms、2.5k = 95 ms、5k = 344 ms（長さ 2 倍で約 4 倍）。
Issue のコメントの 5k = 1,806 ms との差は stderr への書き出しである。

遅くなるのは、入れ子の段数が入力の長さに比例して増える場合だけである。段数が固定なら線形だった（`extractCommandsStructured`、1 回）。

| 形                                                                        | 20k 文字 | 100k 文字 |
| ------------------------------------------------------------------------- | -------- | --------- |
| パイプで挟む（`ls \| xargs -n1 echo \| xargs …`、100k 文字で約 5,900 個） | 26 ms    | 99 ms     |
| 2 段（`xargs xargs echo a a a …`）                                        | 26 ms    | 97 ms     |
| 8 段                                                                      | 35 ms    | 118 ms    |
| 4 種を 1 回ずつ（`timeout 10 env A=b xargs sh -c '…'`）                   | 8 ms     | 22 ms     |

パイプで挟んだ場合、`extractMetaCommands` は最初にメタコマンドを含む部分で結果を返すので、再帰は 1 段で終わる。

一方、構文上の入れ子が 1〜2 段でも遅い形がある。抽出器は構文を見ず、パイプラインの 1 つの部分の中でメタコマンドの単語（`xargs`、`time`、`env`、`timeout`、`sh`、`bash`、`zsh`）を見つけるたびに、その後ろ全部を取り出して再帰する。同じ部分に単語が N 個あれば N 段再帰する。

| 形（`extractBaseCommands`）                             | 8k 文字  | 16k 文字  | 32k 文字  |
| ------------------------------------------------------- | -------- | --------- | --------- |
| `echo $(xargs echo a) $(xargs echo a) …`                | 4,249 ms | 38,242 ms | 33,309 ms |
| ``sh -c 'echo `timeout 1 echo a` …'``                   | 532 ms   | 3,898 ms  | 29,820 ms |
| `git commit -m "the time it takes the time it takes …"` | 195 ms   | —         | —         |
| `for a in b; do ` の繰り返し                            | 8 ms     | 11 ms     | 20 ms     |
| 引用符と置換を交互にした 5 段の鎖                       | 16 ms    | 17 ms     | 27 ms     |

### 抽出器が走査する文字数

`extractMetaCommands`・`extractCommandSubstitutions`・`extractFromControlStructures` が受け取る文字列の長さを、1 回の `extractBaseCommands` の中で合計した（scratchpad に複製した `bash-parser.ts` に加算を 3 行足して計測）。

実際のコマンド（直近 30 日の transcript、重複を除いて 6,540 件）:

| 指標                | 走査した文字数 | そのコマンドの長さ | 時間 |
| ------------------- | -------------- | ------------------ | ---- |
| 中央値              | 450            | 225                | 0 ms |
| 99 パーセンタイル   | 6,480          | 3,239              | 0 ms |
| 99.9 パーセンタイル | 18,690         | 9,112              | 1 ms |
| 最大                | 70,668         | 17,288             | 2 ms |

走査した文字数が 100,000 を超えたコマンドは 0 件。コマンドの長さに対する比は最大 7 倍。
同じ 6,538 件で `extractMetaCommands` に入った回数を数えると、9 回を超えたものが 108 件あった（最大 153 回）。再帰の段数で制約すると、実際のコマンドが該当する。

退化した形:

| 形                        | 1k                 | 2k               | 4k                | 8k                 |
| ------------------------- | ------------------ | ---------------- | ----------------- | ------------------ |
| `xargs ` の繰り返し       | 464 万文字 / 12 ms | 3,720 万 / 45 ms | 2.97 億 / 186 ms  | 23.7 億 / 1,114 ms |
| `$(xargs echo a)` の兄弟  | 80 万 / 20 ms      | 620 万 / 94 ms   | 4,825 万 / 551 ms | 3.81 億 / 4,407 ms |
| `time` を含む文の繰り返し | 54 万 / 1 ms       | 428 万 / 7 ms    | 3,352 万 / 37 ms  | 2.65 億 / 195 ms   |

走査 100 万文字あたりの時間は、形によって 1〜24 ms だった。

hook 1 回の合計も測った。auto-approve は断片ごとに `pattern-matcher` 経由で `extractCommandsStructured` を呼び直すので、「コマンド全体を 1 回、重複を除いた各断片を 1 回ずつ」抽出したときの走査の合計を数えた（実際のコマンド 6,546 件。件数が上の表と少し違うのは、計測の間に transcript が増えたため）。

| 指標                | 走査した文字数 | コマンドの長さ | 断片の数 | 時間  |
| ------------------- | -------------- | -------------- | -------- | ----- |
| 中央値              | 922            | 239            | 6        | 0 ms  |
| 99 パーセンタイル   | 13,762         | 2,191          | 46       | 2 ms  |
| 99.9 パーセンタイル | 39,362         | 6,560          | 59       | 5 ms  |
| 2 番目に大きい      | 65,320         | 15,891         | 35       | 15 ms |
| 最大                | 131,530        | 17,288         | 497      | 45 ms |

200,000 文字を超えたコマンドは 0 件。
退化した形は、1 回の抽出では上限に届かない長さでも、断片ごとの呼び直しで合計が膨らむ。`xargs ` × 200（1.2k 文字）で合計 4.1 億文字・580 ms、`time` を含む文 1.2k 文字で 1,609 万文字・65 ms だった。

`[bash-parser]` と `[extractMetaCommands]` のログは無条件に出る。
`BASH_PARSER_DEBUG` で切り替える `_debugLog`（`bash-parser.ts:4-7`）は定義されているが、呼び出しがない。
`git log -S'[extractMetaCommands]'` は home/ への移動コミット（0ee3c6e）だけを返し、意図を書いたコメントや ADR はない。
このログの内容に依存するテストや文書もない（subagent が grep で確認）。
`ls` だけのコマンドでも、auto-approve と deny-node-modules は stderr に 224 バイトを出している。

## 4. parse を途中で打ち切れるか

web-tree-sitter 0.26.8 の `parse(input, oldTree, { progressCallback })` は、callback が `true` を返すと parse を打ち切る（`web-tree-sitter.d.ts:113-120`）。実験の結果は次のとおり。

- 打ち切られた `parse` は `null` を返す
- 打ち切りの後に `parser.reset()` を呼ばずに次の `parse` を呼ぶと、wasm が `Aborted()` で落ちる。`reset()` を呼べば次の parse は通常どおり動く
- `ParseState.hasError` は parse の途中では `true` にならなかった。「エラーがあるときだけ打ち切る」という条件は使えない
- 予算 100 ms での所要時間（1 プロセス 1 parse）:

| 形                      | 12k | 20k | 40k   | 60k             | 100k            | 200k            |
| ----------------------- | --- | --- | ----- | --------------- | --------------- | --------------- |
| `(a) `                  | 100 | 101 | 101   | 102             | 102             | 102             |
| `>`                     | 101 | 111 | 107   | 118             | 125             | 122             |
| `a \| `（末尾が `\|`）  | 144 | 358 | 1,616 | 1,179（Abort）  | 100             | 100             |
| `a \| … \| a`（正しい） | 25  | 40  | 70    | 104（打ち切り） | 100（打ち切り） | 100（打ち切り） |

`a | ` の形は、入力の末尾まで読んだ後に callback が呼ばれない区間がある（20k 文字で 373 ms の空白）。
この区間に入る 12k〜60k 文字では、予算を指定しても打ち切れない。最悪は 40k 文字の約 1.6 秒。
100k 文字以上では末尾に達する前に予算が尽きるので、100 ms で打ち切れる。

他の構文エラーの形 15 種でも、予算 100 ms での所要時間を 6k・12k・24k・48k・100k 文字で測った。
対象は、末尾が `&&`、閉じない `{`・`$(`・`(`・`"`・バッククォート・`[[`・`${`、`if a; then ` の繰り返し、`case a in ` の繰り返し、余分な `)`、`<`・`&`・`;` の連続、閉じない heredoc の繰り返し。
最大は余分な `)` の 168 ms で、他はすべて 120 ms 以下だった。
予算で打ち切れなかったのは、調べた 18 種のうち「末尾が `|`」の 1 種だけである。

### 32,000 文字以下での所要時間（予算 100 ms、1 プロセス 1 parse）

| 形                           | 16k             | 24k             | 32k               |
| ---------------------------- | --------------- | --------------- | ----------------- |
| `a \| `（末尾が `\|`）       | 233（打ち切り） | 536（打ち切り） | 1,282（打ち切り） |
| `(a) `                       | 100（打ち切り） | 101（打ち切り） | 102（打ち切り）   |
| `>`                          | 102（打ち切り） | 108（打ち切り） | 105（打ち切り）   |
| 余分な `)`                   | 123（打ち切り） | 126（打ち切り） | 111（打ち切り）   |
| `a \| a \| … \| a`（正しい） | 35              | 49              | 60                |
| `a && a && … && a`（正しい） | 12              | 15              | 14                |
| heredoc（正しい）            | 2               | 3               | 2                 |

予算なしの場合、`>` の繰り返しは 28k 文字で parse 1 回が 3,240 ms、40k 文字で 6,683 ms かかる。

### 実際の Bash コマンドの長さ

直近 30 日に更新された transcript（`~/.claude/projects/*/*.jsonl`、1,284 ファイル）から、Bash の tool_use の `command` の長さだけを数えた（内容は出力していない）。長さは Python の `len`（コードポイント数）で数えた。

| 指標                | 値          |
| ------------------- | ----------- |
| 件数                | 6,764       |
| 中央値              | 223 文字    |
| 90 パーセンタイル   | 890 文字    |
| 99 パーセンタイル   | 3,261 文字  |
| 99.9 パーセンタイル | 9,223 文字  |
| 最大                | 23,092 文字 |
| 2,000 文字超        | 187 件      |
| 4,000 文字超        | 36 件       |
| 8,000 文字超        | 10 件       |
| 16,000 文字超       | 2 件        |
| 32,000 文字超       | 0 件        |

### worker で止める方法

`Worker` の中で parse し、主スレッドから 100 ms 後に `terminate()` を呼ぶ実験をした（bun 1.4.0）。

- 予算では止まらなかった `a | ` × 10,000（40k 文字）が 100 ms で止まり、プロセスは 162 ms で終了した
- worker の起動と tree-sitter の初期化に 23〜24 ms かかる。短いコマンドの場合のプロセス全体は 65 ms
- 木は wasm のヒープ上の物なので worker の外に渡せない。木を歩く 3 か所（`extractCommandsFromTreeSitter`、`collectExecutableTexts`、`maskDataHeredocBodies`）を worker の中で動かす必要がある
- テストは `node --test` で走る（`package.json` の `test`）。node で同じ `Worker` の書き方が動くかは確認していない

## 5. 呼び出し側の事実（subagent の調査、file:line は読んで確認したもの）

- 3 つの hook は `prepareDenyInput` を 1 プロセスで 1 回呼ぶ（`auto-approve.ts:378`、`deny-node-modules.ts:208`、`document-workflow-guard.ts:412`）
- `parsingMethod === "fallback"` のとき、読み取り専用の免除は効かない（`read-only-command.ts:93`）。deny-node-modules は複合の断片を ask にする（`deny-node-modules.ts:220`）
- auto-approve の allow は `scanSafeList(raw)` だけが根拠で、パーサーの断片からは作らない（`safe-command-list.ts:3-6`）
- `collectExecutableTexts` は木が `null` のとき、または例外のとき、`wholeAndCoarse`（全文と `[;&|\n]+` での粗い分割）を返す（`bash-parser.ts:1006`、`1032-1036`）。`parseWithTreeSitter` は木が `null` のとき `parsingMethod: "fallback"` を返す（`bash-parser.ts:531-538`）
- `pattern-matcher.ts:419-423` は Bash の前方一致パターンごとに `extractCommandsStructured` を呼び直す。deny の Bash パターンは 21 個ある。ただし `ls -la; ` を 12,500 回並べた入力で auto-approve は 218 ms だったので、この経路が時間を使っているという計測はない
- run-guard 経由の hook は 4 つで、タイムアウトは既定の 20 秒（`executable_run-guard.sh:15`）
- 性能テストの既存の書き方は `performance.now()` の差を 1000 ms 未満と比べる形（`bash-parser.test.ts:596-601`、`deny-node-modules.test.ts:294-300`）。`deny-node-modules.test.ts:306-317` は「長い `>` の parse は 2 乗」とコメントしてパーサーを避けている
- メタコマンド抽出を固定するテストはすべて `it.skip`（`bash-parser.test.ts:166-201`）。`extractBaseCommands` の出力は `BASE_GOLDEN` が固定している
- 制約の出典: `docs/plans/heredoc-body-deny-false-positive/spec.md`（F3b、K4）と `docs/decisions/0020-boundary-deny-rephrase.md`。deny 側の集合は増える方向にだけ変えてよく、3 つの hook が allow する入力を増やしてはならない

## 6. hook プロセスの現状（run-guard 経由、1 回）

| hook                    | `ls`     | `>` 10k  | `a \| … \| a` 100k | `xargs ` 1.2k          |
| ----------------------- | -------- | -------- | ------------------ | ---------------------- |
| auto-approve            | 約 50 ms | 1,016 ms | 856 ms             | 114 ms（stderr 16 MB） |
| deny-node-modules       | 約 41 ms | 888 ms   | 450 ms             | 79 ms（stderr 16 MB）  |
| document-workflow-guard | 約 25 ms | 24 ms    | 26 ms              | 24 ms                  |

document-workflow-guard は workflow が armed でないとパーサーに入らない。上の計測時は armed でなかった。
bun の起動と tree-sitter の初期化（約 20 ms）を合わせた固定費は約 50 ms 以下。

## 7. Issue #241 との関係

#241 は `file-access-guard.ts` の `extractPathsFromBashCommand`（`file-access-guard.ts:280`）、`permission-auto-approve.ts` の `isSessionScratchpadSafe`、`document-workflow-guard.ts` の interpreter scratch roots を対象にする。
どれも `bash-parser.ts` を import しない。`document-workflow-guard.ts` だけは `prepareDenyInput` の `individualCommands` を通じてパーサーの出力に依存する。
`git worktree list` と `git branch` には、2026-10-04 時点で #241 用の worktree や branch は見当たらなかった。

## 8. 確認していないこと

- CI や他のマシンでの parse 時間。上の数値はこのマシン（WSL2）のもの
- tree-sitter の末尾の区間がなぜ callback を呼ばないか（wasm の内部は読んでいない）
- armed な document-workflow-guard の hook プロセス単位の時間
