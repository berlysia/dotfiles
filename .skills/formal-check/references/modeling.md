# モデルの書き方と code の一覧

モデルは、実装の配管（I/O、フレームワーク、DB）を外した判定だけを書く。
性質には名前を付け（`NeverOverCap` のように）、`formal.json` の `property` にその名前を書く。
成り立つことを示したいのか、反例が欲しいのかを決めてから性質を書く。
同じ形のモデルは、このスキルの dir の `examples/` にある（全列挙、Z3、TLA+ を 1 つずつ）。

## モデルの形

モデルは子プロセスで動く。
モデルが import してよいのは、モデル自身、`imports` に宣言したファイル、`node:` の組み込みだけである。
ほかを import すると undeclared-import の error になる。
モデルの `console.log` は stderr に出る。

### 全列挙（kind: enumerate）

- `domain()` を export する。列挙する入力の配列か iterable（async も可）を返す。
- `property(input)` を export する。入力ごとに `true` か `false` を返す（async も可）。それ以外を返すと non-boolean の error になる。
- 最初に `false` を返した入力が witness になり、verdict は violate になる。すべて `true` なら hold になる。
- `domain()` が空なら empty-domain の error になる。空の緑にはしない。
- 境界の前後（上限の 1 つ手前、上限、1 つ先）は必ず domain に入れる。

### Z3（kind: z3）

- `property(ctx)` を export する。Z3 の Bool の式を返す。`ctx` は z3-solver の Context で、`const { Int, And } = ctx` のように使う。
- 任意で `assumptions(ctx)` を export する。Bool の式か、その配列を返す。
- 任意で `quantifier` を export する。`"forall"`（既定）か `"exists"`。
- forall: まず前提が満たせるかを解く。満たせなければ vacuous-assumptions の error になる（前提が矛盾していると、どんな性質も成り立ってしまうため）。次に「前提かつ性質の否定」を解く。解が無ければ hold、解があれば violate で、その解が witness になる。
- exists: 「前提かつ性質」を解く。解があれば hold で、その解が witness になる。解が無ければ violate になる。
- ソルバーが判定できなければ solver-unknown の error になる。時間の上限は `timeoutSec` で決まる。

### TLA+（kind: tla）

- `model` に `.tla`、`cfg` に `.cfg` を書く。
- `property` には、cfg の `INVARIANT` か `PROPERTY` で宣言した名前を書く。デッドロックを検査するなら、`property` を `Deadlock` にし、`checkDeadlock: true` を付ける。
- TLC が「エラーが無い」と言っても、cfg に性質が無い、状態が 1 つも無いときは tlc-vacuous の error になる。
- 違反した性質の名前が `property` と違えば tlc-property-mismatch の error になる。
- 同じ dir の `.tla` を `EXTENDS` か `INSTANCE` で使うと、そのファイルも digest に入る。標準のモジュール（Naturals、Integers、Sequences、FiniteSets、TLC、Bags など）の外を使うと、`--inspect` の uses I/O が yes になる。
- モデルの dir に `.class` か `.jar` があると unexpected-binary の manifest error になる。

## formal.json の欄

最上位は `schemaVersion`（1）と `checks` の配列である。知らない欄は unknown-key の error になる。

- `id`: 英小文字、数字、`-` の組み合わせ。重複できない。
- `kind`: `enumerate`、`z3`、`tla` のどれか。
- `model`: manifest の dir からの相対パス。dir の外を指せない。
- `cfg`: tla だけに要る。パスの決まりは `model` と同じ。
- `imports`: enumerate と z3 だけ。モデルが import するファイル（同じ dir の補助ファイルも、リポジトリの実装も）を、リポジトリ root からの相対パスで並べる。
- `property`: 性質の名前。
- `expect` と `role` の組は次の 3 つだけである。
  - `contract` と `hold`: 成り立つことを示し、将来の変更で落ちたら気づく。
  - `broken-variant` と `violate`: 契約のモデルの判定を、わざと誤らせたもの。検査が誤ったモデルを違反として検出できることを示す。
  - `finding` と `violate`: 見つかった反例。`question` に利用者への確認を書く。
- `brokenBy`: contract だけ。対になる broken-variant の `id` を書く。無いと no-broken-variant の警告になる。
- `question`: finding だけに要る。
- `note`: 任意の説明。
- `timeoutSec`: 1 から 600 の整数。既定は 60。
- `checkDeadlock`: tla だけ。
- `sync`: contract と finding に要る。broken-variant では任意。
  - `commit`: 確かめたときの commit（読み始める位置の記録で、判定には使わない）。
  - `covers`: `{path, sha256}` の配列。モデルが覆う実装のファイルと、確かめたときの hash。`sha256` が null なら sync-unrecorded の警告になる。
  - contract の `covers` を空にするなら、`note` に理由を書く。finding の `covers` は空にできない。
  - enumerate と z3 の contract と finding では、manifest の dir の外の `imports` は `covers` にも入れる。

パスには英数字と `._/-` だけを使う。絶対パスと `..` は書けない。

## verdict と pass

- verdict は hold、violate、error の 3 つである。error を violate に畳まない。
- pass は「verdict と expect が同じ」ときだけである。error は常に pass にならない。
- broken-variant が violate にならないと、broken-variant-mismatch の警告になる。

## --inspect の欄

- `digest`: ハーネスのバージョン、manifest、モデル、cfg、imports、tla のモジュールの hash をまとめた値。承認と `--expect-digest` に使う。
- `runtime`: ランタイムの場所（env か default）、jar の sha256、z3-solver のバージョン。
- check ごとの `model`、`cfg`、`imports`、`modules`: パスと sha256。
- `usesIo`: tla だけ。標準の外のモジュールを使うか。
- `covers`: パス、`recorded`（manifest の値）、`current`（今のファイルの hash）、状態（clean、changed、missing、unrecorded）。sync を書くときは `current` を `sha256` に書く。

## code の一覧

### manifest error（MANIFEST）

- `invalid-json`: manifest が JSON として読めない。
- `missing-schema-version`: `schemaVersion` が無い。
- `unsupported-schema-version`: `schemaVersion` が 1 ではない。
- `unknown-key`: 知らない欄がある。
- `key-not-allowed`: その kind か role では使えない欄がある。
- `missing-field`: 要る欄が無い。
- `invalid-type`: 欄の型が違う。
- `invalid-format`: 欄の書式が違う（id、hash、commit など）。
- `invalid-enum`: 決まった値の欄に、ほかの値がある。
- `out-of-range`: 数の欄が範囲の外にある。
- `duplicate-id`: 同じ id が 2 つある。
- `duplicate-path`: `covers` に同じパスが 2 つある。
- `role-expect-mismatch`: role と expect の組が決まりと違う。
- `unknown-broken-by`: `brokenBy` に書いた id の check が無い。
- `empty-covers-without-note`: contract の `covers` が空で、`note` が無い。
- `empty-covers-on-finding`: finding の `covers` が空。
- `import-not-covered`: manifest の dir の外の `imports` が `covers` に無い。
- `covers-not-file`: `covers` のパスが通常のファイルではない。
- `missing-file`: model、cfg、imports のファイルが無いか読めない。
- `path-escape`: パスが決まった dir の外を指す（symlink を含む）。
- `invalid-path-chars`: パスに使えない文字がある。
- `no-repo-root`: manifest の dir から上に `.git` が見つからない。
- `manifest-at-repo-root`: manifest がリポジトリ root にある。
- `deadlock-property-without-check`: `property` が Deadlock で、`checkDeadlock` が true ではない。
- `unexpected-binary`: tla のモデルの dir に `.class` か `.jar` がある。

### 実行の前（PRE_RUN）

- `usage`: 引数が違う。
- `digest-mismatch`: `--expect-digest` の値が今の digest と違う。モデルは実行していない。`--inspect` からやり直し、利用者の承認を取り直す。

### 実行（RUN）

- `runtime-missing`: z3-solver か jar が無い。`Recover with:` の行に従う。
- `runtime-stale`: ランタイムの依存の宣言（package.json と bun.lock）が、最後に入れたときの記録と食い違う。`Recover with:` の行に従う。
- `java-missing`: PATH に java が無い。
- `child-exit-nonzero`: モデルの子プロセスが 0 以外で終わった。
- `child-output-invalid`: 子プロセスの出力が読めない。
- `child-output-too-large`: 子プロセスか TLC の出力が上限を超えた。
- `timeout`: `timeoutSec` を超えた。
- `internal-error`: ハーネスの内部の誤り。
- `interrupted`: シグナルで止まった。

### 観測（OBSERVATION）

- `empty-domain`: 全列挙の domain が空。
- `non-boolean`: 全列挙の property が真偽値以外を返した。
- `model-threw`: モデルが例外を投げた。
- `undeclared-import`: モデルが宣言していないファイルを import した。
- `vacuous-assumptions`: Z3 の前提が満たせない。
- `solver-unknown`: Z3 が判定できなかった。
- `not-bool-expr`: Z3 の property か assumptions が Bool の式ではない。
- `tlc-vacuous`: TLC が性質を検査しないまま「エラーが無い」と終わった。
- `tlc-property-mismatch`: 違反した性質の名前が `property` と違う。
- `tlc-exit-unexpected`: TLC が想定していない終了コードで終わった。
- `tlc-version-mismatch`: jar の TLC のバージョンが、ハーネスが前提とするものと違う。
- `deadlock-found`: `checkDeadlock` が true で、Deadlock 以外の性質の check でデッドロックが見つかった。
- `invalid-model-export`: モデルの export の形が違う（Z3 の `quantifier` の値など）。

### 警告（WARNING）

`--explore` を付けないと、警告は exit 1 になる。

- `no-broken-variant`: contract に `brokenBy` が無い。
- `broken-variant-mismatch`: `brokenBy` の check が壊したモデルとして使えない。role が broken-variant でない、kind か property が契約と違う、violate にならなかった、のどれかである。
- `stale-model`: `covers` のファイルの hash が、確かめたときと違う。追従の 1 周を始める合図である。
- `covers-missing`: `covers` のファイルが無い。
- `sync-unrecorded`: `covers` の `sha256` が null。
