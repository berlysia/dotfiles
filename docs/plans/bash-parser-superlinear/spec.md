# Spec: Bash パーサーの所要時間を入力長に対して抑える（Issue #235）

## Goal

長い Bash コマンドで guard hook が run-guard の 20 秒に達することをなくす。
Issue #235 の 4 つの形について、100,000 文字の入力で hook のプロセス 1 回を 500 ms 以内にする。

そのために、hook が解析するコマンドに 2 つの決定的な制約を置く。長さは 32,000 文字まで、メタコマンドの抽出器が走査する文字数は hook 1 回の合計で 2,000,000 まで。どちらも入力だけで決まる。
制約を超えたコマンドは、3 つの hook が制約の内容を理由に書いて deny を返す。実行する側はコマンドを分けて出し直す。
制約の内側でも parse が 100 ms を超えた場合は、同じく deny を返す（構文エラーのある入力への保険）。
どの hook も、今 allow していない入力を allow しない。

Issue の 4 形 × 100,000 文字は、長さの制約によって parse されずに deny になる。500 ms の基準はこの形で満たす。

例外が 2 つある。

- 長さの制約の内側で、`a | ` の繰り返し（末尾が `|`）は 約 22k〜32k 文字のとき 500 ms を超える（32k 文字で約 1.3 秒）
- Issue の受け入れ基準「既存のテスト結果が変わらない」を 1 か所で緩める。約 100k 文字の入力で ask を期待している既存のテスト（`deny-node-modules.test.ts:294-302`）は、長さの制約により deny になるので、期待を改める（R2）

この変更は Issue が案として挙げた範囲（`bash-parser.ts` と parse の経路）を超えて、3 つの hook の実装にも手を入れる。理由は K4 に書く。

## Experience Delta

- 変更前: `xargs ` を 10k 文字並べたコマンドで `extractCommandsStructured` が約 13 秒、20k 文字で約 83 秒かかる（Issue #235 の 2026-10-04 のコメントの計測）。`>` を 100k 個並べると parse だけで約 46 秒かかる。hook は 20 秒で打ち切られ、run-guard の「timed out」という文言でコマンドが止まる。短いコマンドでも hook の stderr にパーサーのデバッグ行が出る
- 変更後: 32,000 文字を超えるコマンドは parse されず、hook は約 50 ms で「32,000 文字を超えている。分けて実行すること」という deny を返す。メタコマンドの単語（`xargs`、`time`、`env` など）が 1 行に多数並び、抽出器の走査が 2,000,000 文字を超えるコマンドは、その旨の deny になる。どちらにも当たらず、parse が 100 ms 以内に終わるコマンドは、今と同じ判定になる。デバッグ行は `BASH_PARSER_DEBUG=1` のときだけ出る
- 判定が今より厳しくなる入力は次の 3 種類。どれも今は検査の結果で判定されるが、変更後は deny になる
  - 32,000 文字を超えるコマンド。直近 30 日の transcript にある Bash コマンド 6,764 件のうち 0 件（最大 23,092 文字。research.md §4）
  - 抽出器の走査が 2,000,000 文字を超えるコマンド。同じ 30 日のコマンド（重複を除いて約 6,540 件）で、hook 1 回の合計の最大は 131,530 文字、2 番目は 65,320 文字で、200,000 文字を超えたものは 0 件（research.md §3）。引用符の中の文章に含まれる `time` や `env` という単語も数えられる
  - 32,000 文字以下で parse に 100 ms 以上かかるコマンド。構文エラーのある長い入力（`>` 5k 個で 131 ms）が該当する。構文が正しい入力は 32k 文字で最大 60 ms だった
- コマンドの一部（`sh -c` の中身や断片）だけが該当する場合も deny になる。上限を変える設定はない

## Architecture

```
auto-approve / deny-node-modules / document-workflow-guard
        │  打ち切りの記録が増えていたら、その理由で deny … K4
        ▼
prepareDenyInput
        ├─► maskDataHeredocBodies ──────────────────────────┐
        ▼                                                   │
extractCommandsStructured                                   │
  32,000 文字を超えたら parse しない … K8                    │
  結果を文字列ごとに覚える … K3                              │
        ├─► extractBaseCommands ─► parseWithTreeSitter ─────┤
        │                              └─► extractMetaCommands（走査 2,000,000 文字まで … K5）
        └─► collectExecutableTexts ─► parseForCollect ──────┤
                                                            ▼
                                              parseBounded（新設 … K1・K2・K8）
                                              32,000 文字を超えたら parse しない
                                              100 ms を超えたら打ち切り、reset、入力を覚える

打ち切りの記録（新設）: 種類（length / scan / time）を起きた順に並べたモジュール内の配列
```

- **parseBounded**: `parser.parse` を呼ぶ唯一の場所。長さの制約を超えた入力と、予算を超えた parse には `null` を返す
- **打ち切りの記録**: `bash-parser.ts` のモジュール内の配列。長さの制約（K8）、走査量の制約（K5）、parse の打ち切り（K1）、覚えていた入力の parse の省略（K2）、覚えていた「打ち切りあり」の結果の再利用（K3）のたびに、種類を 1 件足す。減ることはない
- **3 つの hook**: Bash のコマンドを扱う関数の最初に記録の件数を控え、パーサーを呼んだ後で件数が増えていれば deny を返す（置き場所は K4）
- 公開している型（`ExtractedCommands`、`DenyInput`、`ParseForCollect`）は変えない

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

無条件の `console.error` を消し、`extractMetaCommands` の再帰に上限を付ける。parse には手を入れない。

`xargs` の形はこれで直る（parse は 100k 文字で 28 ms）。
残りの 3 形は直らない。時間を使っているのは tree-sitter の parse で、`>` 100k 個は parse だけで約 46 秒かかる（research.md §2）。
受け入れ基準の 4 形のうち 3 形を満たせないので採らない。

### 白紙設計案 (Greenfield)

hook が parse の所要時間を制御できない以上、ゼロから設計するなら次の形になる。

1. hook が解析する入力の形を、線形に読める範囲に制約する。制約は入力だけで決まり、超えたコマンドは実行する側が分けて出し直す
2. 制約の内側で残る遅い入力のために、パーサーを別スレッドで動かし、期限が来たら外から止める
3. 解析をやめたコマンドは、hook が理由を付けて明示的に止める
4. コマンドは 1 回だけ parse し、メタコマンド（`xargs`、`sh -c`）の中身も正規表現ではなく構文木から取り出す

2 について実験した。`progressCallback` では止められなかった `a | ` × 10,000 が `Worker.terminate()` で 100 ms で止まった（research.md §4）。費用は次のとおり。

- worker の起動と初期化に 23〜24 ms かかる。Bash の呼び出し 1 回ごとに、パーサーを使う hook の数だけ払う。今の固定費は約 50 ms 以下なので、短いコマンドで約 1.5 倍になる
- 木は worker の外に出せない。木を歩く 3 か所を worker の中で動かし、結果を文字列で返す形に組み替える。`maskDataHeredocBodies` と `collectExecutableTexts` は parse 関数を引数で受け取り、テストがそこに偽の関数を差し込んでいる（`heredoc-data.ts:519`、`bash-parser.ts:999`）。この差し込み口が使えなくなる
- テストは `node --test` で走り、hook は bun で走る。node で同じ `Worker` の書き方が動くかは確認していない

### 採用案と理由

白紙設計案の 1 と 3 を採り、2 は同じスレッドでの時間予算（`progressCallback`）に置き換える。4 は採らない。

- 1 を採る理由: 遅さの原因は入力の性質で決まる。メタコマンドの側の時間は、抽出器が走査する文字数に比例する（100 万文字あたり 1〜24 ms。research.md §3）。実際のコマンドの走査は hook 1 回の合計で最大 131,530 文字で、退化した形は 1.2k 文字の入力でも 1,600 万〜4.1 億文字になる。走査量を hook 1 回の合計 2,000,000 文字で制約すれば、抽出の時間は入力の長さによらず約 50 ms 以下になる（上限を超えた呼び出しの分を足しても約 100 ms 以下）。tree-sitter の側は、構文エラーの有無を parse せずに知る方法がないので、制約にできるのは長さだけである。32,000 文字は、直近 30 日の実際のコマンド 6,764 件の最大値（23,092 文字）より大きい。この 2 つの制約は入力だけで決まるので、同じコマンドはどのマシンでも同じ判定になり、deny の理由に「何を超えたか」を書ける（100 ms の予算による判定だけはマシンと負荷に依存する）
- 入れ子の段数で制約しない理由: 抽出器は構文を見ず、同じ行にあるメタコマンドの単語の数だけ再帰する。実際のコマンド約 6,540 件のうち 108 件で再帰が 9 回を超えた（最大 153 回）。段数で制約すると、これらが deny になる。逆に、構文上 1 段の `echo $(xargs echo a) $(xargs echo a) …` は 8k 文字で 4.2 秒かかり、段数の制約では防げない。差分最小案の「再帰に上限を付ける」も、段数で数える限り同じ理由で足りない
- 長さの制約だけにしない理由: 500 ms を長さだけで満たすには上限を約 5,000 文字にする必要がある（`>` 5k 個で parse 1 回 131 ms）。直近 30 日のコマンドで 4,000 文字を超えるものは 36 件、8,000 文字を超えるものは 10 件ある。32,000 文字の上限だけでは、`>` の繰り返しが 28k 文字で parse 1 回 3,240 ms かかる
- 3 を採る理由: 解析をやめたときに粗い分割だけで検査を続けると、検査が見落とす入力を作れる。たとえば `for f in a; do tee plan.md; done` に `>` を足して予算を超えさせると、粗い分割の断片は `do tee plan.md` になる。document-workflow-guard の `analyzeSingleCommand` は先頭の単語（`do`）しか読まないので、書き込みと判定しない（`document-workflow-guard.ts:748-775`）。今は同じ入力が 20 秒で止まる
- 2 を予算に置き換える理由: 32,000 文字以下の構文エラーの形を予算 100 ms で測ると、「末尾が `|`」の 1 種を除いて 130 ms 以内に収まった（research.md §4）。worker 案はこの 1 種も 100 ms にできるが、すべての Bash 呼び出しに 23〜24 ms × hook 数を足し、3 か所の組み替えとテストの差し込み口の作り直しが要る。得られるのは 1 種の形の約 1.3 秒を約 0.2 秒にすることで、hook の判定はどちらでも deny である。長い入力だけを worker に回す折衷案も、組み替えと作り直しは同じだけ要るので採らない
- 4 を採らない理由: 構文木からメタコマンドを取り出すと、deny 側の検査に渡る断片が変わる。メタコマンド抽出を固定するテストはすべて `it.skip` で（`bash-parser.test.ts:166-201`）、変わったことを検出できない。受け入れ基準の「既存のテスト結果が変わらない」を確かめる手段がない。正規表現のまま「後ろ全部を取り出して再帰する」のをやめて線形にする案も、返す断片が変わるので同じ理由で採らない

## Key Decisions

- **K8: 32,000 文字を超えるコマンドは parse しない** — 定数 `MAX_COMMAND_CHARS = 32_000`（`String.prototype.length` で数える）。`extractCommandsStructured` は、入力がこれを超えていたら、打ち切りの記録に `length` を足し、`{ individualCommands: wholeAndCoarse(command), originalCommand: null, parsingMethod: "fallback" }` を返す。メタコマンドの抽出も parse もしない。同じ検査を `parseBashCommand`（`extractBaseCommands` と `extractCommandsDetailed` の入口。`commands: []` と `parsingMethod: "fallback"` を返す）と `parseBounded`（`maskDataHeredocBodies` の経路。`null` を返す）にも置く。`parseWithTreeSitter` はメタコマンドが見つかると parse より前に結果を返すので、`parseBounded` だけでは `parseBashCommand` の経路を覆えない。環境変数では変えられない。
  - 32,000 の根拠: 直近 30 日の Bash コマンド 6,764 件で、32,000 文字を超えるものは 0 件、16,000 文字を超えるものは 2 件、最大は 23,092 文字。構文が正しい入力の parse は 32k 文字で 2〜60 ms。この値は 1 人の利用者の 30 日分の標本から選んだもので、計算で導いたものではない（計測はコードポイント数、検査は UTF-16 の単位数で、この差は余裕の内側にある）
  - 断片は入力の一部なので、入力が制約の内側なら断片も内側にある
  - 参照: `home/dot_claude/hooks/lib/bash-parser.ts:1042-1055`（`extractCommandsStructured`）、`home/dot_claude/hooks/lib/bash-parser.ts:975-983`（`wholeAndCoarse`）、`home/dot_claude/hooks/lib/heredoc-data.ts:518-523`
- **K5: メタコマンドの抽出器が走査する文字数は、hook 1 回の合計で 2,000,000 まで** — 定数 `MAX_META_SCAN_CHARS = 2_000_000`。走査した文字数は、`bash-parser.ts` のモジュール内の 1 つの合計に足していく（減らさない）。上限は 2 か所で見る。1 回の `parseBashCommand` の中（下の作業オブジェクト）と、hook 1 回の全体（K4 の確認）である。auto-approve は断片ごとに `pattern-matcher` 経由で抽出をやり直すので、1 回の呼び出しごとの上限だけでは、断片の数だけ上限が与えられてしまう。合計は hook のプロセスごとに持つ（1 回の Bash 呼び出しで 3 つの hook が動けば、合計は 3 つある）。hook の中のパーサーの呼び出しは逐次で、並行には走らない。最悪の場合、合計が上限の直前まで来た後の 1 回の呼び出しがさらに上限まで走査するので、走査は約 4,000,000 文字、時間は約 100 ms になる。`extractMetaCommands` と `extractCommandsInternal` の引数 `processed`（`Set<string>`。書き込まれるだけで読まれていない）を、`{ start: number; capped: boolean }` の作業オブジェクトに置き換える（`start` は作った時点の走査の合計）。作業オブジェクトは必須の引数にし、既定値を持たせない（渡し忘れを typecheck が見つける）。作るのは `parseBashCommand` の 1 か所で、`parseWithTreeSitter` と `parseWithFallback` に引数で渡す。そこから先の呼び出し（`parseWithTreeSitter` から直接呼ぶ `extractCommandSubstitutions`、`extractMetaCommands` の中から呼ぶ `extractCommandSubstitutions` を含む）には、複製せずに同じオブジェクトを渡す。`extractMetaCommands`・`extractCommandSubstitutions`・`extractFromControlStructures` は、入るたびに受け取った文字列の長さを走査の合計に足す。合計と `start` の差が 2,000,000 を超えたら、1 つの関数 `markCapped` を呼び、その呼び出しは走査せずに「何も見つからなかった」ときの値を返す（`extractMetaCommands` と `extractFromControlStructures` は空の配列、`extractCommandSubstitutions` は受け取った文字列 1 件）。`markCapped` は、`capped` がまだ `false` のときだけ、`capped` を `true` にし、打ち切りの記録に `scan` を足す。`capped` が `true` になった後は、新しい走査をしない。`extractCommandsInternal` は入った直後に `capped` を見て、`true` なら分割せずに受け取った文字列 1 件を返す。`extractMetaCommands` と `extractCommandSubstitutions` の正規表現のループは、反復のたびに `capped` を見て、`true` なら抜ける。
  - 1 回の `parseBashCommand` の走査が 2,000,000 文字以下の入力は、今と同じ断片を返す
  - 2,000,000 の根拠: 実際のコマンド約 6,540 件で、hook 1 回の合計の最大は 131,530 文字（上限はその約 15 倍）、2 番目は 65,320 文字。1 回の抽出の最大は 70,668 文字。走査 100 万文字あたりの時間は 1〜24 ms なので、上限までの抽出の時間は約 50 ms 以下になる。500 ms の基準に対して、固定費（約 50 ms）と parse（予算 100 ms × 最大 3 回）を引いた残りに収まる値として選んだ。退化した形は、1.2k 文字の入力でも hook 1 回の合計が 1,600 万〜4.1 億文字になる
  - 数えるのは、この 3 つの関数が受け取る文字列の長さである。research.md §3 の計測と同じ場所で数える。この 3 つの関数の外にも、長さに比例する処理が 1 つある。`parseSimpleCommandFallback` の `originalCommand.indexOf(trimmed)`（`bash-parser.ts:931`）は、断片の数 × コマンドの長さだけかかる。これは K8 の 32,000 文字で抑えられる（5,900 個の断片・100k 文字で全体が 99 ms だった）。plan-1 で 32,000 文字の入力について測る
  - 参照: `home/dot_claude/hooks/lib/bash-parser.ts:644-670`、`home/dot_claude/hooks/lib/bash-parser.ts:672-805`、`home/dot_claude/hooks/lib/bash-parser.ts:483-529`、`home/dot_claude/hooks/lib/bash-parser.ts:540-545`、`home/dot_claude/hooks/lib/bash-parser.ts:613-642`、`home/dot_claude/hooks/lib/bash-parser.ts:808-839`
- **K1: parse は 1 回あたり 100 ms の時間予算で打ち切る** — `parser.parse` に `progressCallback` を渡し、開始から 100 ms を超えたら `true` を返す。次の 3 つを「打ち切り」として同じに扱い、`parser.reset()` を呼んで `null` を返す: (a) `parse` が `null` を返した、(b) `parse` が例外を投げた、(c) `parse` は木を返したが経過時間が 100 ms を超えていた（木は `delete()` して捨てる）。`reset()` なしで次の parse を呼ぶと wasm が `Aborted()` で落ちることを実験で確認した。打ち切りの記録に `time` を足すのと K2 の集合に入れるのは、`reset()` と `delete()` を呼ぶより前にする。`reset()` と `delete()` が投げた例外は `parseBounded` の中で捕まえ、例外の名前だけを stderr に出して `null` を返す（例外が hook まで届くと、document-workflow-guard の外側の catch が allow を返す。`document-workflow-guard.ts:333-347`）。予算は定数 `PARSE_BUDGET_MS = 100` で、環境変数では変えられない。
  - 役割は K8 の内側の保険である。32,000 文字以下で予算に達するのは構文エラーのある入力で、構文が正しい入力は 32k 文字で最大 60 ms だった
  - 時計は壁時計（`performance.now()`）を使う。負荷が高いと、同じコマンドが打ち切られることがある。打ち切りの結果は deny だけなので、時計のぶれで allow が増えることはない。CPU 時間（`process.cpuUsage()`）は callback のたびにシステムコールを呼ぶことになるので使わない
  - 「エラーがあるときだけ打ち切る」案は採らない。`ParseState.hasError` は parse の途中で `true` にならなかった
  - (b) は今の経路を変える。今は例外のとき `parseBashCommand` が catch して正規表現の分割（`parseWithFallback`）に進むが、変更後は木が `null` のときと同じ経路（`commands: []`、`parsingMethod: "fallback"`）になり、K4 により deny になる
  - 参照: `home/dot_claude/hooks/lib/bash-parser.ts:531-538`（`parseWithTreeSitter` の parse と `null` の経路）、`home/dot_claude/hooks/lib/bash-parser.ts:463-475`（例外の経路）、`home/dot_claude/hooks/lib/bash-parser.ts:950-954`（`parseForCollect`）、`home/dot_claude/hooks/lib/bash-parser.ts:21-24`（`TreeSitterParser` に `reset` と parse の第 3 引数を足す）
- **K2: 時間で打ち切った入力は覚えておき、同じ文字列は二度と parse しない** — K1 の (a)(b)(c) に該当した文字列を、モジュール内の `Set<string>` に入れる。`parseBounded` はこの集合にある文字列を受け取ると、parse せずに `null` を返し、打ち切りの記録に `time` を足す。これで、打ち切られる入力の parse 時間は 1 プロセスで 1 回分になる。`<<` を含むコマンドでは `maskDataHeredocBodies` が先に生の文字列を parse するが、打ち切られると生の文字列をそのまま返すので、続く `extractCommandsStructured` は同じ文字列を受け取って集合に当たる。集合はプロセスが終わるまで残る。hook は 1 回の起動で 1 つのコマンドだけを扱う。
  - 参照: `home/dot_claude/hooks/lib/deny-input.ts:33-38`、`home/dot_claude/hooks/lib/heredoc-data.ts:518-523`、`home/dot_claude/hooks/lib/bash-parser.ts:1042-1055`
- **K3: `extractCommandsStructured` の結果を入力の文字列ごとに覚える** — モジュール内の `Map` に、結果の Promise と「この計算の間に足された打ち切りの記録」を入れる。足された記録は、計算の前後の配列の差で決める（内側の呼び出しでの打ち切りも含まれる）。同じ文字列の 2 回目以降は、覚えた Promise を待ってから結果を返し、覚えていた記録を配列に足し直す。返すときは `individualCommands` の配列を複製する。Promise が reject した場合は Map から消す。`pattern-matcher.ts:419-423` は deny の Bash パターン（21 個）ごとに断片を `extractCommandsStructured` に渡し直すので、覚えないと、予算に近い時間がかかる断片 1 つにつき parse 2 回 × 21 パターンを払う。K5 の hook 1 回の合計は、この記憶によって各断片が 1 回だけ走査されることを前提にしている（research.md §3 の計測も「全体を 1 回、重複を除いた各断片を 1 回」で数えた）。覚えないと、断片ごとに 21 回走査されて合計が約 21 倍になる。この経路が実際に時間を使っているという計測はまだない（research.md §5）。実装後に、実際の deny の一覧を使った auto-approve で走査の合計を測り、research.md §3 の値と比べる。32,000 文字の構文が正しいパイプラインを auto-approve のプロセス単位で測る手順を plan-1 に入れ、覚える前後の時間を記録する。同じ関数の中の 2 回の parse（base と supplement）で木を共有することはしない。予算内の parse 2 回は合計 200 ms 未満で、共有するには `parseWithTreeSitter` と `collectExecutableTexts` の引数を変える必要がある。
  - 参照: `home/dot_claude/hooks/lib/pattern-matcher.ts:419-423`、`home/dot_claude/hooks/lib/bash-parser.ts:1042-1055`
- **K4: 解析をやめたコマンドは、3 つの hook が理由を付けて deny にする** — `bash-parser.ts` が 2 つの関数を export する。`parserGiveUpMark()` は、打ち切りの記録の現在の件数と、走査の合計（K5）の現在値を組にして返す。`parserGiveUpReasonSince(mark)` は、控えた時点より後に足された記録があるか、控えた時点からの走査の合計が 2,000,000 を超えていれば deny の理由（後者は `scan` の理由）を返し、どちらでもなければ `null` を返す。hook は Bash のコマンドを扱う関数の最初に `parserGiveUpMark()` を控え、パーサーを呼んだ後で `parserGiveUpReasonSince` を呼ぶ。理由が返れば、その理由で deny を返す。この処理は、パーサーの例外を握りつぶす try/catch の外に置く。
  - 理由の文言は種類ごとに 1 つで、`bash-parser.ts` の中だけで定義する。複数の種類があるときは `length`、`scan`、`time` の順で最初のものを使う
    - `length`: `Bash command is longer than 32,000 characters, so the guard does not analyse it and blocks it. Split it into smaller commands.`
    - `scan`: `Bash command repeats wrapper words (sh, bash, zsh, xargs, timeout, time, env) or command substitutions too many times on one line for the guard to analyse, quoted text included (over 2,000,000 characters scanned), so it is blocked. Split it into smaller commands or shorter lines.` 単語の一覧は、抽出器が使う定数 `META_COMMANDS` のキーから作る（`bash-parser.ts:102-114`）
    - `time`: `Bash command could not be parsed within 100 ms, so the guard blocks it. It probably contains a syntax error; fix it or split it into smaller commands.`
  - 文言は「分けて実行する」ことだけを勧める。スクリプトファイルに書いて実行することは勧めない（Bash の guard はファイルの中身を見ない）
  - auto-approve（`processBashTool` の中）: `prepareDenyInput` の直後、`checkHomeDestruction`（全文を読む検査）より前に 1 回目の確認をする。ここで deny を返すと、全文を読む検査も断片ごとの検査も走らせないので、時間を使わない（どちらの結果も deny なので、順序を入れ替えても判定は弱くならない。ホームディレクトリを壊すコマンドが制約にも当たる場合、表示される理由は制約の方になり、コマンドを分けて出し直した時点で `checkHomeDestruction` が働く）。断片ごとのループでは `classifyBashDeny` を呼んだ直後、その結果を見て ask などを返すより前に確認し、理由が返ればループを抜けて deny を返す（`pattern-matcher.ts:419-423` が断片を parse し直したときの打ち切りを拾う）。関数が結果を返す箇所のすべて（ask、pass、最後の return）で、返す前に確認する
  - deny-node-modules（`analyzeBashCommand` の中）: `prepareDenyInput` の直後に確認する。この後はパーサーを呼ばない。全文に `node_modules` を含むかどうかによらず deny にする
  - document-workflow-guard: `analyzeBashWrite` を呼んだ直後、`isWriteLike` を見るより前に確認する。この経路は workflow が active のときだけ通る（今と同じ）。`DOCUMENT_WORKFLOW_WARN_ONLY=1` のときは、この hook の他の deny と同じく警告だけになる。この hook の外側の catch（`document-workflow-guard.ts:333-347`）は例外のとき allow を返すので、`parserGiveUpMark()` は `run` の先頭、外側の try（`document-workflow-guard.ts:81`）より前で控え、catch の中でも `parserGiveUpReasonSince` を呼んで、理由が返れば通常の経路と同じ扱いにする（`DOCUMENT_WORKFLOW_WARN_ONLY=1` なら警告、そうでなければ deny。`warnOnly` は try の中の変数なので、catch では環境変数を読み直す）
  - ask ではなく deny にする理由: 今、これらの入力は 20 秒のタイムアウトで無条件に止まっている。ask にすると、deny されるはずのコマンドに `>` を足して ask に変えることができる。また、hook の ask が権限モードによってどう扱われるかは hook のコードからは決まらない。deny は今の挙動より弱くならない
  - K8・K5・K1 だけを入れて K4 を入れないと、今止まっている入力が粗い検査だけで通るようになる。K4 は同じ変更に入れる
  - 型にフラグを足さずモジュール内の記録にする理由: 打ち切りは、hook が渡した文字列だけでなく、`pattern-matcher` が渡し直す断片や、fallback の経路でも起きる。文字列ごとのフラグでは、これらを hook まで運ぶ経路を 1 つずつ足す必要がある。記録なら、どこで起きても hook が同じ方法で知る。誤って記録が増えた場合の結果は deny である
  - 記録は意図して消さない。hook が確認を忘れると、解析をやめたコマンドが粗い検査だけで通る。Bash を扱う 3 つの hook の実装が `parserGiveUpReasonSince` を参照していることを、ファイルを読むテストで固定する（`bash-parser.test.ts:558-575` の既存の書き方と同じ）
  - 他の呼び出し元は変えない。`permission-analyzer.ts`（allow パターンの提案をする道具で、guard ではない）、`command-parsing.ts`（`extractCommandsStructured` の薄い包み）は、速くなるだけで、記録を見ない
  - 参照: `home/dot_claude/hooks/implementations/auto-approve.ts:378-430`、`home/dot_claude/hooks/implementations/deny-node-modules.ts:203-250`、`home/dot_claude/hooks/implementations/document-workflow-guard.ts:404-427`、`home/dot_claude/hooks/implementations/document-workflow-guard.ts:219-284`、`home/dot_claude/hooks/lib/pattern-matcher.ts:419-423`
- **K6: デバッグ行は `BASH_PARSER_DEBUG=1` のときだけ文字列を作って出す** — `[bash-parser]` と `[extractMetaCommands]` で始まる無条件の `console.error` をすべて、`DEBUG` が真のときだけ引数を評価する形にする。3 乗の stderr の原因は `join(", ")` を含む 3 行（`bash-parser.ts:484`、`742`、`791`）だが、残りの行も同じ形に揃える。K5 と K8 が入ると stderr の量も抑えられるので、これは所要時間の対策ではなく後始末である。その結果、短いコマンドで出ていた 224 バイトの stderr もなくなる。`console.warn` の fallback 通知と、`collectExecutableTexts` の例外名だけを出す `console.error` は残す。
  - 参照: `home/dot_claude/hooks/lib/bash-parser.ts:4-7`（未使用の `_debugLog`）、`home/dot_claude/hooks/lib/bash-parser.ts:680-803`、`home/dot_claude/hooks/lib/bash-parser.ts:1033-1035`（残す行）
- **K7: 「末尾が `|`」の 約 22k〜32k 文字で 500 ms を超えることは、この変更では直さない** — この形は入力の末尾まで読んだ後に callback が呼ばれない区間があり、予算で止められない（1 回の parse が 16k 文字で 233 ms、24k 文字で 536 ms、32k 文字で 1,282 ms）。K1 の (c) と K2 により、この parse は 1 プロセスで 1 回だけ走り、hook は K4 の deny を返す。プロセス全体は最大約 1.3 秒で、20 秒の内側に収まる。K8 の制約がこの形の上限を決めている。この数値はこのマシンでの計測で、他のマシンでは測っていない。
  - 参照: `home/dot_claude/hooks/executable_run-guard.sh:15`（既定のタイムアウト 20 秒）

## Risks

- **R1**: 予算は壁時計なので、遅いマシンや負荷の高いときに、32,000 文字以下の構文が正しいコマンドが 100 ms を超えて deny になる → このマシンでは、最も遅い正しい形（8,000 段のパイプライン、32k 文字）で 60 ms、他の正しい形は 15 ms 以下。数 KB のコマンドは 1 ms 前後である。負荷がかかった状態（3 つの hook の同時実行など）では測っていない。deny の理由に、分けて実行することを書く。allow は増えない
- **R2**: 既存のテストが、制約や予算に当たって期待と食い違う → `parsingMethod: "tree-sitter"` を固定しているテストの入力は 100 文字未満。約 100k 文字の入力を使う既存のテストのうち、K8 の影響を受けるのは 2 か所。`deny-node-modules.test.ts:294-302` は ask を期待しており、変更後は deny になるので期待を改める（正規表現の表が線形であることを確かめる目的は、32,000 文字以下の入力で別に残す）。`bash-parser.test.ts:596-601` は時間だけを見ているので通るが、for ループの本体の分割を通らなくなるので、入力を 32,000 文字以下に縮めて目的を保つ。`command-parsing.test.ts:219-222` は正規表現の関数 `checkDangerousCommand` を直接呼ぶテストで、パーサーを通らないので影響を受けない
- **R3**: web-tree-sitter の更新で `progressCallback` や `reset()` の挙動が変わる → 「打ち切った後に短いコマンドを parse すると木が返る」ことをテストで固定する
- **R4**: K2 の集合・K3 の Map・打ち切りの記録は、テストのプロセスの中で共有される → hook は控えた件数より後の記録だけを見るので、前のテストの打ち切りは次のテストの判定に影響しない。K2 と K3 は、覚えていた打ち切りを再利用するたびに記録を足すので、同じ文字列を使う 2 つ目のテストでも記録が増える
- **R5**: 時間のテストが遅い CI で不安定になる → 長さと走査量の制約のテストは時間を見ない（判定と理由の文言を固定する）。時間を見るテストは既存の書き方（`performance.now()` の差を 1000 ms 未満と比べる）に合わせ、対象は予算で止まる形（32k 文字以下の `(a) ` と `>`）に限る。K7 の形は判定（deny）だけを固定する。500 ms の基準は hook プロセス単位の手動計測で確認する
- **R6**: `DOCUMENT_WORKFLOW_WARN_ONLY=1` のとき、今は 20 秒のタイムアウトで止まる入力が、変更後は document-workflow-guard を警告だけで通る → この環境変数は guard 全体を無効にする設定で、利用者が明示的に付ける。auto-approve は同じ入力を deny する
- **R7**: 32,000 文字を超える正当なコマンドや、走査が 2,000,000 文字を超える正当なコマンド（`time` や `env` という単語を 1 行に数百回含む文章を引数に持つコマンド。`git commit -m "…"` の本文など）が今後出てくる → 直近 30 日の約 6,540 件では 0 件だった（1 人の利用者の標本）。deny の理由に上限の値と対処を書く。上限はそれぞれ定数 1 つで、変えるときは research.md §3・§4 の計測をやり直す

## Phase 1 で意図的に提供しない体験

### 「末尾が `|`」の形を 500 ms 以内にすること

- **代替経路確認**: `home/dot_claude/hooks/executable_run-guard.sh:15`（20 秒のタイムアウトは変えない。最大約 1.3 秒はこの内側に収まり、hook は K4 の deny を返す）
- **非提供対象**: 末尾が `|` で終わる 約 22k〜32k 文字の入力を 500 ms 以内に判定すること
- **将来の予定**: Issue #235 にこの数値を書いて残す。同じ種類の形が他にも見つかった場合に worker 案を検討する

### 構文木からのメタコマンド抽出

- **代替経路確認**: `home/dot_claude/hooks/lib/bash-parser.ts:672-805`（正規表現による抽出を残し、K5 の制約で走査量を抑える）
- **非提供対象**: `extractMetaCommands` を構文木ベースに置き換えること、同じ関数の中の 2 回の parse で木を共有すること、`pattern-matcher.ts:419-423` が断片ごとに抽出をやり直すのをなくすこと（これがなくなれば K5 の hook 1 回の合計は要らなくなる。今回は上限で抑えるだけで、やり直し自体は残す）
- **将来の予定**: 別の Issue にする。先にメタコマンド抽出の出力を固定するテスト（今は `it.skip`）が要る。動機になる事実は、抽出器が引用符の中の `time` や `env` という単語もメタコマンドとして扱い、K5 の deny の原因になりうること

## ISO 25010 次元選択

- **性能効率性（時間効率性）**: Issue の本題。4 形 × 100k 文字 × 3 hook のプロセス単位の時間と、32k 文字以下の構文エラーの形の時間。document-workflow-guard は workflow が active な状態で測る。3 つの hook を同時に走らせた場合も 1 回測る
- **セキュリティ**: 解析をやめたコマンドが、3 つの hook のどれでも allow・ask・pass にならないこと。断片の parse し直しで打ち切りが起きた場合も deny になること
- **機能適合性（正確性）**: 制約の境界（32,000 文字と 32,001 文字、走査 2,000,000 文字の前後）で判定が切り替わること。境界の内側で断片が今と同じであること。既存のテストの結果が、R2 に挙げた 2 か所を除いて変わらないこと
- **信頼性（障害許容性）**: 打ち切りの後もパーサーが使えること
- **使用性（エラーの明確さ）**: deny の理由が、超えた制約と対処を 1 文ずつで伝えること
- **対象外**: 移植性（実行環境を変えない）、互換性（公開の型を変えない）、保守性（構造の整理は目的にしない）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: 今は「例外」と「木が null」で経路が違うので「新しい分岐なし」は不正確。上限到達を返すフラグの受け渡しとカウンターの範囲が未定義。350 ms の計算と、末尾 `|` の形のプロセス単位の時間が不正確。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: 「覚える条件」が打ち切りと例外だけだと、木を返して予算を超えた parse が繰り返される。`pattern-matcher` の 21 パターンの呼び直しを根拠と計測対象に入れること。

### decision-quality-reviewer

- verdict: needs-work
- 主指摘: 時間切れの経路は入力で意図的に踏ませられ、fail-closed が粗い検査に変わる。deny 側が縮まないことを示していない。worker への置き換え位置が同じという主張は自分の記述と矛盾する。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: Issue の `a | ` の形が予算で止まらない形そのものであることを Goal に書くこと。結果を文字列ごとに覚えれば 2 回 parse と 21 パターンをまとめて抑えられる。構文木ベースの抽出は別の変更。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: 木が null のとき document-workflow-guard は `do tee plan.md` のような断片を書き込みと判定できず、今は 20 秒で止まる入力が通る。deny パターンの前方一致と deny-node-modules も弱くなる。

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: needs-work
- 主指摘: 上限到達の印が fallback の経路と `extractCommandSubstitutions` で失われる。`pattern-matcher` が parse し直す断片だけが打ち切られた場合を hook が知れない。「今と同じ断片」の条件がカウンターの数え方と合っていない。→ K4 をカウンター方式にし、K5 の `markCapped` と条件を書き直した

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: K4 は K1 の安全上の前提で切り離せないことと、Issue の範囲を超えることを明記すること。`extractCommandsStructured` の他の呼び出し元の扱いを書くこと。→ Goal と K4 に書いた

### decision-quality-reviewer

- verdict: needs-work
- 主指摘: 今は無条件に止まる入力が、deny-node-modules で allow、他で ask になる。パディングで deny を ask に落とせる。壁時計の根拠は「失敗の向きが安全」と書くべき。→ 3 つの hook とも deny にし、K1 の根拠を書き直した

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 長い入力だけ worker に回す折衷案を比較に足すこと。`incomplete` を読まない呼び出し元の扱いを書くこと。→ 採用案と K4 に書いた

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: 100 ms〜20 秒で終わっていた入力は今は検査の結果で deny されるが、断片の検査より前に ask を返すと deny が ask に弱まる。断片の parse し直しでの打ち切りが hook に伝わらない。`DOCUMENT_WORKFLOW_WARN_ONLY=1` では通る。→ deny に統一し、返す直前にも回数を比べる。R6 に書いた

<!-- auto-review: verdict=needs-work; hash=03bdd657f8ff86772680e8e0edf5d6a0df7334d4d412e3863b5fd8f64af5009c; design-hash=838727013bc70fb03c015f441536f6b9882b9978f3d0d49deafed6c4de89119f; round=1; at=2026-10-04T09:32:28.369Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+security-vulnerability-analyzer -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: pass
- 主指摘: 打ち切りの経路はすべてカウンターで hook に見える。軽微: auto-approve の比較の置き場所、断片ごとのループでも回数を見て抜けること、`markCapped` を 1 回だけ数えること。→ K4・K5 に反映した

### scope-justification-reviewer

- verdict: pass
- 主指摘: Round 2 の指摘は解消。軽微: 実際のコマンドが 100 ms〜20 秒の帯に入るという証拠がないことを書くこと。→ Experience Delta と R1 に書いた

### decision-quality-reviewer

- verdict: pass
- 主指摘: deny に倒す重み付けは guard として妥当。軽微: 負荷がかかった状態の計測がないことを未確認として書き、同時実行の計測を手順に足すこと。→ R1 と ISO に書いた

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: カウンターは「どこで打ち切っても deny 側に倒れる」ので guard に合う。軽微: deny の文言を 1 か所で定義すること。→ K4 に書いた

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: 打ち切りが起きて allow・ask・pass を返す経路は見つからない。軽微: 回数を増やすのは `reset()` より前、作業オブジェクトは必須の引数、document-workflow-guard の比較は `analyzeBashWrite` の直後。→ K1・K4・K5 に反映した

<!-- auto-review: verdict=needs-work; hash=d609609f3be00006256634f62c9a33fa734faa7e3b2a93bba7399b23ca6bc5f4; design-hash=26e844619316a080aa74a343da45c08213248bfc0169851099f68681883ee990; round=2; at=2026-10-04T09:36:53.837Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+security-vulnerability-analyzer -->

## Reviewer Outputs (Round 4)

### logic-validator

- verdict: needs-work
- 主指摘: 入れ子の中の置換の鎖と for ループの正規表現が未計測。`parseBounded` だけでは `parseBashCommand` の経路の長さの検査を覆えない。R2 の 3 件目はパーサーを通らないテスト。→ 計測したところ、段数の制約では防げない形と、段数の制約に当たる実コマンド 108 件が見つかった。K5 を走査文字数の制約に置き換え、K8 と R2 を直した

### scope-justification-reviewer

- verdict: pass
- 主指摘: K8・K5・K1 は互いに置き換えられない。軽微: 「既存のテスト結果が変わらない」の緩和を Goal に書くこと、引用した数値を research に載せること。→ Goal と research §2 に書いた

### decision-quality-reviewer

- verdict: pass
- 主指摘: 決定的な制約を主に、時計を保険にする構成は整合している。軽微: 100k 文字が基準を満たすのは長さで deny するからだと書くこと。→ Goal に書いた

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 入力を制約して呼び出し側に分けさせるのは、白紙から設計しても到達する形。軽微: 「どのマシンでも同じ判定」は長さと走査量の制約に限ること。→ 採用案に書いた

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: `reset()` や `delete()` が例外を投げると、document-workflow-guard の外側の catch が allow を返す。→ `parseBounded` の中で捕まえ、catch の中でも打ち切りの記録を見て deny にする（K1・K4）

<!-- auto-review: verdict=pass; hash=6b09c5b7c2b016830fbeba1145f76c2224862db4162800914b1b388fd711cbd5; design-hash=33adfd5232763e72b5d09c183b10507eb67854ff9164ee1c77f6128322a5d7d6; round=3; at=2026-10-04T09:41:11.852Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=66; excluded=0; at=2026-10-04T09:41:29.347Z -->

## Reviewer Outputs (Round 5)

### logic-validator

- verdict: needs-work
- 主指摘: 走査の予算が呼び出しごとだと、auto-approve の断片ごとの抽出のやり直しで断片の数だけ予算が与えられる。上限に達した後もループが走査を続ける。「12k〜32k で 500 ms 超」は計測と合わない（約 22k 以上）。→ 予算を hook 1 回の合計にし（実コマンドの最大は 131,530 文字）、上限後の振る舞いと数値を直した

### scope-justification-reviewer

- verdict: pass
- 主指摘: K5 の値と指標は research §3 で裏付けられている。軽微: deny の文言の単語の一覧を抽出器の定数から作ること。→ K4 に書いた

### decision-quality-reviewer

- verdict: pass
- 主指摘: 段数から「実際に払うコスト」に移したのは正しい。軽微: 上限の大きさの理由と、引用符の中の文章も数えることを書くこと。→ K5 と Experience Delta に書いた

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 抽出器の作り直しを今回に入れない判断は妥当。軽微: 正規表現のまま線形にする案を比較に足すこと。→ 採用案に書いた

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: guard を今より弱める経路は見つからない。軽微: catch の中での `WARN_ONLY` の扱いを通常の経路と揃えること。→ K4 に書いた

<!-- auto-review: verdict=needs-work; hash=d014cadfc2f17c979217bc544800248e0d2b38888a60c29f3c2636b68ccbf129; design-hash=b8f5af744e7d0d88d83e3ac9a3b2eaac924403a1f4f42edf46d5439b51b63937; round=4; at=2026-10-04T10:01:43.203Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+security-vulnerability-analyzer -->

## Reviewer Outputs (Round 6)

### logic-validator

- verdict: pass
- 主指摘: 断片ごとに予算が与えられる問題は解消。最悪の走査は約 4,000,000 文字で約 100 ms。軽微: 並行に呼ばれないことの明記、ホームディレクトリの検査の理由が隠れることの明記。→ K5 と K4 に書いた

### scope-justification-reviewer

- verdict: pass
- 主指摘: hook 1 回の合計とその値は research §3 で裏付けられている。軽微: 件数の表記を揃えること。

### decision-quality-reviewer

- verdict: pass
- 主指摘: 上限は退化した形への安全側の境界で、実コマンドとは 2 桁離れている。軽微: 模した計測が実際の呼び出し回数と合うかを確かめること。→ K3 に実装後の計測を書いた

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 合計の上限と結果の記憶は、断片を変えずに抑える方法として妥当。軽微: 抽出のやり直しをなくすことを後続として名前を挙げること。→ 「提供しない体験」に書いた

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: guard を今より弱める経路は見つからない。軽微: deny パターンごとの抽出のやり直しで、害のない長いコマンドが上限に届かないかを実際の deny の一覧で測ること。→ K3 に前提と計測を書いた

<!-- auto-review: verdict=needs-work; hash=3ba2a3b8ca30bb968683654d6f249b06e47a03b84ff44487f724c371067c42c9; design-hash=e92e1f52a5707b9023f6d8a83895678f8bd0c1d07d24df4f0d594e900fafab62; round=5; at=2026-10-04T10:09:19.705Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+security-vulnerability-analyzer -->

<!-- auto-review: verdict=pass; hash=004215ca25a2dfce93ec399e26d1a5c8702c62968965a846ae7e7bc2f0f0df16; design-hash=95f0f8e11005e8429bfe609a6ab62def85035bab031275bd033b32fdf41ffbd9; round=6; at=2026-10-04T10:12:18.810Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=118; excluded=0; at=2026-10-04T10:12:18.828Z -->
