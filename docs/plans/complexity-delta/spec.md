# Spec: 複雑度が悪化した関数をターンの終わりに知らせる hook（complexity-delta）

## Goal

1 ターンの作業で認知複雑度が大きく悪化した関数、または最初から複雑な関数が書かれたことを、ターンの終わりに人へ知らせる。
ターンは止めず、延ばさない。既に複雑な関数に触れただけでは鳴らさない。モデルには自動では渡さない。

## Experience Delta

- 変更前: 関数の複雑度は、人が `cccc` を手で実行しないかぎり分からない。`document-workflow-guard.ts` の `run` は 24 から 65 まで、誰にも知らされずに上がった
- 変更後: ターンが終わったとき、条件に当たる関数があれば UI に 1 件 1 行で出る（例: `[complexity-delta] hooks/implementations/document-workflow-guard.ts:412 run 24 → 44`）。条件に当たらないターンでは何も出ない。モデルに見せたいときは、人が「複雑度のログを見て」と指示する（`~/.claude/logs/complexity.jsonl` に同じ内容が残る）
- 変わらないこと: ターンは止まらず、モデルの追加の応答も起きない。この hook は `additionalContext` を出さないので、モデルの文脈へ自動で足す経路を作らない（`systemMessage` は `hooks/README.md` の記述では UI だけに出る。公式ドキュメントはモデルの入力に入らないとは明記していない）。`cccc` が見つからない環境、git リポジトリの外、ターンの途中で別のリポジトリへ移った場合は、何も起きない

## Architecture

ターンの始まりと終わりに同じ計測をし、メモリ上で比べる。変更前の内容は保存しない。

```
UserPromptSubmit ──▶ measure(root) ──▶ ~/.claude/state/complexity-delta/<session_id>.json（基準）

Stop ─────────────▶ measure(root) ──▶ diff(基準, 現在) ──▶ systemMessage で UI へ（該当があるときだけ）
```

### 部品

- `hooks/lib/complexity-delta.ts`: 副作用の無い関数だけを置く
  - `cccc` の JSON を検証し、鍵ごとの数値に平らにする（形が合わなければ失敗を返す）
  - 2 つの計測を比べて該当を返す
  - 該当を通知の文面にする（無害化を含む）
  - PATH の文字列とルートから、`cccc` の候補の順序つき一覧を作る
- `hooks/implementations/complexity-delta.ts`: hook の入口。`git` と `cccc` の実行、`realpath` の解決、状態ファイルの読み書き、出力、ログを受け持つ。UserPromptSubmit と Stop の両方に登録する（`completion-gate.ts` と同じ形）

Stop の hook は並列に走り、出力は Claude Code がまとめる。この hook は他の hook の結果にも登録の順序にも依存しない。`stop_hook_active` は見ない。

出力は 2 通りだけである。知らせることが無ければ `context.success({})`、あれば `context.json({ event, output: { systemMessage } })` を返す。`event` には入力の `hook_event_name` を渡す。`systemMessage` だけを返す先例は `session.ts:295-298`（SessionStart）にある。

### 計測

- 作業ディレクトリは hook の入力の `cwd` を使う。そこで `git rev-parse --show-toplevel` を実行し、結果をルートとする。失敗したら（git の外、所有者の違い）、状態を読まず、書かず、何も出さずに終わる
- `cccc` の実体を次の手順で決める。PATH のエントリのうち絶対パスのものだけを順に見る。`<エントリ>/cccc` の `realpath` を取り、ファイル名が `mise` のもの（shim）と、ルートまたは `cwd` の配下にあるものは捨てる。最初に残ったものを使う。残らなければ計測しない
- ルートを作業ディレクトリにして、決めた絶対パスで `cccc --no-config --exclude '.git/**' .` を実行する。timeout は 1000 ミリ秒、`killSignal` は `SIGKILL`、`maxBuffer` は 64MiB
- 出力は検証してから使う。検証は、どんな入力にも例外を出さずに「使える値」か「失敗」を返す
  - 必須: `files` が配列。各ファイルの `path` が文字列、`functions` が配列。各関数の `name` が文字列、`cognitive` が有限の数値
  - 任意: `kind` は文字列でなければ空文字として扱う。`line` は整数でなければ通知の行番号を省く。`children` は配列でなければ空として扱う。ファイルの `parse_errors` が空でない配列のとき、または `summary.parse_error_files` が文字列の配列でそのパスを含むとき、構文エラーとみなす
  - 入れ子が 64 段を超えたら失敗とする。知らないフィールドは無視する
- 計測から比較までで起きた例外は、すべて計測の失敗として扱う

計測の結果は「成功」「`cccc` が無い」「timeout」「形が合わない（検証に落ちた）」「失敗（終了コードが 0 でない、出力が大きすぎる、例外）」のどれかになる。

### 状態ファイル

`~/.claude/state/complexity-delta/<session_id>.json`。`session_id` は `/^[A-Za-z0-9_-]{1,128}$/` に合うときだけ使う。ディレクトリは 0700、ファイルは 0600 で、一時ファイルに書いてから rename する。

- `version`: 1
- `root`: この状態が属するルートの絶対パス。状態を書くたびに必ず入れる
- `baseline`: 基準。`functions`（鍵から cognitive の配列への対応）と `parseErrorFiles` を持つ。基準が無いときは `null`
- `shown`: このターンで UI に出した一覧の文面の SHA-256。出していなければ `null`。同じ通知を繰り返さないためだけに持つ。通知のたびに基準を現在の値へ進める方法でも重複は防げるが、それだと同じターンの 2 度目の Stop が「プロンプトの時点からの差」ではなく「前の Stop からの差」を出すことになるので採らない
- `timeouts`: 連続した timeout の回数
- `disabled`: 計測をやめた理由。やめていなければ持たない

読み書きの規則:

- JSON として読めない、`version` が 1 でない、型が合わない、のどれかなら「状態なし」として扱い、ログに `skip: state` を残す。ファイルが無い場合（セッションの最初のプロンプト）も「状態なし」だが、ログには残さない。移行の処理は書かない
- 書くときは、読んだ状態を土台にして、手順が挙げたフィールドだけを変える。挙げていないフィールドは読んだ値のまま残す
- 「新しい状態」は `baseline: null`、`shown: null`、`timeouts: 0` で、`disabled` を持たない

状態は 1 つのルートに属する。ルートが変わると新しい状態から始まるので、`disabled`、`timeouts`、`shown` は前のルートのものを引き継がない。

### UserPromptSubmit の手順

1. ルートを決める。決まらなければ終わる
2. 状態を読む。状態なし、または `root` が今のルートと違うなら、今のルートの新しい状態から始める
3. `disabled` があれば、何も書かずに終わる
4. 7 日より古い状態ファイルを消す（`pruneStaleBaselines` をこの hook のディレクトリに対して呼ぶ）
5. `shown` を `null` にする。計測し、結果に応じて状態を変える
   - 成功: `baseline` に結果を入れ、`timeouts` を 0 にする
   - `cccc` が無い、失敗: `baseline` を `null` に、`timeouts` を 0 にする。前のプロンプトの基準は残さない
   - 形が合わない: `baseline` を `null` に、`timeouts` を 0 にし、`disabled: "schema"` を入れ、`systemMessage` で知らせる
   - timeout: `baseline` を `null` に、`timeouts` を 1 増やす。2 になったら `disabled: "timeout"` を入れ、`systemMessage` で知らせる
6. 状態を書く

この手順は `additionalContext` を出さない。出力は、手順 5 で `disabled` にしたときの `systemMessage` だけである。`disabled` のセッションは手順 3 で終わるので、手順 4 の掃除をしない。掃除はほかのセッションが行う。

### Stop の手順

1. ルートを決める。決まらなければ終わる
2. 状態を読む。状態なし、`root` が今のルートと違う、`disabled` あり、`baseline` が `null`、のどれかなら何も書かず、何も出さずに終わる
3. 計測し、結果に応じて状態を変える
   - 成功: `timeouts` を 0 にして、手順 4 へ進む
   - `cccc` が無い、失敗: `timeouts` を 0 にし、状態を書いて終わる
   - 形が合わない: `timeouts` を 0 にし、`disabled: "schema"` を入れ、`systemMessage` で知らせる。状態を書いて終わる
   - timeout: `timeouts` を 1 増やす。2 になったら `disabled: "timeout"` を入れ、`systemMessage` で知らせる。状態を書いて終わる
4. 基準と比べる。該当が 0 件なら `shown` を `null` にし、状態を書いて終わる
5. 一覧の文面を作り、SHA-256 を取る。`shown` と同じなら、状態を書いて終わる。`completion-gate.ts` が止めて Stop がもう 1 度起きたときに、同じ通知を繰り返さないため
6. `shown` に SHA-256 を入れ、状態を書き、ログに `notice` を書き、`systemMessage` に一覧を出す

この手順は `additionalContext` も `decision` も出さない。UserPromptSubmit を経ずに Stop が起きた場合は、前のプロンプトの基準と `shown` をそのまま使う。同じ一覧は繰り返さない。

UserPromptSubmit で timeout すると `baseline` が `null` になるので、そのターンの Stop は計測しない。「連続した timeout」は、実際に行った計測が続けて timeout した回数である。

### 比較の規則

- 鍵は「ファイルのパス」と「親から子への `name:kind` の連なり」で作る。行番号は編集で動くので使わない
- 基準か現在のどちらかで構文エラーだったファイルは、比較から外す
- 基準に無いファイルの関数は、すべて「追加」になる。現在に無い鍵（削除）は何も出さない
- 同じ鍵に複数の関数があるとき（無名関数、別クラスの同名メソッド）は次の順で対応づける
  1. 基準と現在で cognitive が等しいものを 1 対 1 で消す（変わっていないとみなす）
  2. 残りを cognitive の降順に並べ、順位が同じものどうしを対にする
  3. 相手がいない現在の側は「追加」とする。相手がいない基準の側は捨てる
- 現在の値が 25 以上で、かつ「追加」または「上昇が 5 以上」のものを該当とする

境界の例: 24 → 29 は該当、21 → 25 は該当しない（上昇が 4）、25 → 29 は該当しない、追加の 25 は該当、追加の 24 は該当しない。基準 `[30, 2]`、現在 `[40, 30, 2]` は「追加 40」の 1 件だけになる。

### 通知の文面

- 1 件は `<パス>:<行> <名前> <基準の値> → <現在の値>`。追加は `<パス>:<行> <名前> new <現在の値>`。行は現在の側の行番号
- 並びは上昇幅の大きい順（追加は基準を 0 として数える）。上昇幅が同じものは、パス、名前、行の昇順に並べる。同じ該当から必ず同じ文面ができるようにするため。10 件まで出し、残りは件数だけを書く。再生した履歴では 1 コミットあたり最大 4 件だったので、10 件は余裕を見た上限である
- パスと名前は `sanitizeForDisplay` を通す。信頼できないリポジトリのファイル名と関数名に含まれる制御文字や改行を、端末にそのまま出さないため。また、`systemMessage` がモデルの入力に入らないことは公式ドキュメントに明記されていないので、入った場合の備えにもなる
- 先頭に `[complexity-delta]` を付ける

### 計測が続けて終わらないとき

- 数え方は上の 2 つの手順のとおり。timeout で 1 増やし、timeout でない結果（成功、`cccc` が無い、失敗）で 0 に戻す
- `timeouts` が 2 になったら `disabled: "timeout"` を書く。そのとき 1 度だけ `systemMessage` で知らせる。文面には、計測が 1 秒を超えたこと、このセッションのこのリポジトリではやめること、状態ファイルのパスを含める
- 形が合わないときは、1 度目で `disabled: "schema"` を書き、同じように 1 度だけ知らせる。文面には、`cccc` の出力が想定と違うこと、使った実体のパスを含める。timeout と違って待っても直らないので、2 度目を待たない
- `disabled` はセッションと一緒に終わる。次のセッションは新しい状態ファイルで始まり、また計測する。同じセッションで別のリポジトリへ移ったときも、新しい状態から始まる

### ログ

`~/.claude/logs/complexity.jsonl` に、構造を持つ行を書く。どの行にもルートを入れる。種類は 3 つ。

- `notice`: UI へ出した該当（パス、行、名前、基準の値、現在の値）。UI に出したときだけ書く（繰り返しを抑えた Stop では書かない）。パス、名前、ルートは無害化する前の値を書く。無害化した値では別の名前が同じ文字列になり、頻度を数えられないため。JSON の文字列として書くので、行は壊れない
- `skip`: 計測しなかった、または失敗した理由（`cccc-not-found`、`timeout`、`failed`、`schema`、`state`）。`cccc` を実行した場合は、使った実体のパスを入れる（mise の実体のパスは版を含むので、更新のあとの不具合を追える）。`cccc-not-found` には `recovery`（「PATH に `cccc` の実体を置く。mise なら `mise install`」）を入れる
- `disabled`: 計測をやめたこと。`recovery`（状態ファイルのパス）を入れる

`cccc` が見つからないことは UI に出さない。`cccc` を入れていない環境では正常な状態で、毎回出すと読み流されるため。

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

`completion-gate.ts` に足す。この hook は既に UserPromptSubmit で基準を保存し、Stop で比べている。変更前の内容は `git show HEAD:<path>` で取り、変更したファイルだけを計測する。

- 新しいファイルは増えない
- `completion-gate.ts` はプロジェクトが自前の Stop hook を持つと全体を省く（`completion-gate.ts:106-118`）。複雑度の通知まで消える
- `completion-gate.ts` は止める hook で、止めない通知と retry の数え方が混ざる
- HEAD を基準にすると、ターンの途中でコミットしたときに差分が消える。この dotfiles は 1 ターンでコミットまで進むことが多い

### 白紙設計案 (Greenfield)

ゼロから考えると、`cccc` の性質が設計を決める。

- `cccc` は標準入力を読めず、比較の機能も無い。変更前の内容と比べるには、内容をファイルとして置き直す必要がある
- 一方で、`cccc` は 199 ファイルを 0.020 秒で計測する。変更したファイルだけに絞る理由が薄い
- そこで「内容を取っておいて後で測る」のをやめ、「先に測って数値を取っておく」形にする。git の履歴にも一時ディレクトリにも頼らない。未追跡のファイルも、ターンの途中のコミットも、同じ扱いで済む
- 状態ファイルを持つのは、hook の呼び出しが 1 回ごとに別のプロセスだからである

起源はこの実測（標準入力が使えない、全体計測が速い）である。白紙案はそのまま上の Architecture になる。

ほかに検討した形:

- 編集のたびに知らせる（PostToolUse、`quality-loop.ts` と同じ位置）: 作業の途中の値で鳴る。書きかけの関数は一時的に複雑になる
- CI で `.summary` を追跡する（元リポジトリの方式）: この dotfiles は `master` へ直接コミットするので PR がほとんど無い。関数ごとの悪化も見えない
- `git stash create` でプロンプト時点の内容を残す: 計測は変更ファイルだけで済むが、未追跡ファイルの一覧を別に持つ必要があり、一時ディレクトリへの展開と後始末が要る
- Stop で `additionalContext` を返してモデルにすぐ渡す: 公式ドキュメントによると会話が続き、モデルにもう 1 ターンが回る。該当のたびにターンが延びる
- Stop では UI に出し、モデル向けの一覧を状態に残して次の UserPromptSubmit で渡す: ターンは延びないが、開いたリポジトリのファイル名と関数名が毎回モデルの入力に入る。無害化しても、指示めいた平文は残る。状態に持ち越しの項目が増え、UserPromptSubmit に配信の処理が要る。ユーザーが UI だけを選んだ

### 採用案と理由

白紙設計案を採る。

- 実測: 全体計測は 199 ファイルで 0.020 秒、1562 ファイルで 0.114 秒。プロンプトごとと Stop ごとに走らせても、モデルの応答時間に対して小さい
- 実測: `git stash create` は未追跡のファイルを含まない。数値を保存する方式は未追跡と追跡を区別しない
- `completion-gate.ts:106-118` の「自前の Stop hook があれば省く」は、止める検査の重複を避ける規則である。通知には当てはまらないので、別の hook にする
- 代償: 計測の時間がリポジトリの大きさに比例する。数万ファイルの規模は測っていない。1 秒の timeout は、実測の速度（1 秒あたり約 1.4 万ファイル）から決めた。それより遅いリポジトリでは、2 回続けて timeout した時点で 1 度だけ知らせて黙る

## Key Decisions

- **K1: 全プロジェクトで動かす** — ユーザーの決定。`cccc` は共有の mise 設定に入っており、前の plan は用途を「他のプロジェクトでの計測」とした。閾値は言語を問わない 1 組にする。動く条件は、hook の PATH に `cccc` の実体があることである（K6）
  - 参照: `home/dot_config/mise/config.toml:62`
  - 参照: `home/dot_claude/.settings.hooks.json.tmpl:207-229`（Stop の登録は全プロジェクトに配られる）
- **K2: 基準はプロンプトの時点、数値だけを保存する** — ユーザーの決定。根拠は上の「採用案と理由」。置き場は `completion-gate` の先例にならってプロジェクトの外にし、ディレクトリは分ける。書き込みは同じ手順（一時ファイル、rename、0600）をこの hook の中に持つ。`saveBaseline` は fingerprint の文字列を `<session_id>.txt` に書く専用の関数なので使わない。掃除は、ディレクトリを引数に取る `pruneStaleBaselines` を呼ぶ
  - 参照: `home/dot_claude/hooks/implementations/completion-gate.ts:36-40`（置き場をプロジェクトの外にする理由と 7 日の期限）
  - 参照: `home/dot_claude/hooks/lib/working-tree-fingerprint.ts:190-225`（`saveBaseline` の手順と、fingerprint 専用であること）、`:227-241`（`pruneStaleBaselines`）、`:32`（`session_id` の検証）
- **K3: 該当の条件は「現在の値が 25 以上、かつ追加または 5 以上の上昇」** — ユーザーの決定。直近 150 コミットの再生で該当は 19 コミット（12%）、26 関数。「15 以上で上昇」は 59 コミット（39%）で、通知が常態になる。この再生は名前のある関数だけを数えた。K5 の対応づけは使っていないので、無名関数を含めた頻度は測っていない
  - 参照: `research.md` の「閾値ごとの発火の頻度」
  - 参照: `home/dot_claude/hooks/implementations/document-workflow-guard.ts`（`run` は `c7f600c` で 24 → 44。この条件で出る）
- **K4: 通知は UI だけに出し、モデルには自動で渡さない** — ユーザーの決定。最初の回答は「人とモデルの両方」だったが、次の 2 点を受けて UI だけに変えた。Stop で `additionalContext` を返すと会話が続き、モデルにもう 1 ターンが回る。モデルへ渡す文面には、開いたリポジトリの作者が決められる文字列（ファイル名、関数名）が入る。UI だけにすると、この hook がモデルの入力へ自動で足す経路を持たなくなり、引き継ぎメモの「頼まれていないリファクタリングを誘発する」も起きない。モデルに見せたいときは、人が指示してログを読ませるか、`cccc` を実行させる
  - 参照: `home/dot_claude/hooks/README.md:207-212`（2 つの経路の違い）
  - 参照: `home/dot_claude/hooks/implementations/compaction-testament.ts:660-674`（`decision` を付けずに `systemMessage` を返す先例）
  - 参照: `research.md` の「Round 1 のレビューを受けて確かめたこと」（公式ドキュメントの引用）
- **K5: 同じ鍵の関数は、等しい値を消してから降順の順位で対にする** — 無名関数は `<anonymous>` 固定で、別クラスの同名メソッドも同じ鍵になる。出現順で対にすると、途中に 1 つ足しただけで後ろが全部ずれる。降順の順位だけで対にすると、大きい関数を 1 つ足したときに触れていない関数が悪化に見える（基準 `[30, 2]`、現在 `[40, 30, 2]`）。等しい値を先に消せば、触れていない関数は対から外れる。残る誤りは、同じ鍵の 2 つ以上の関数を同じターンで変えたときの取り違えである（基準 `[30, 28]`、現在 `[33, 30]` は 28 → 33 と読む）
  - 参照: `research.md` の「cccc の仕様」（`<anonymous>` 固定、同名メソッドの実測）
- **K6: `cccc` は PATH の絶対パスのエントリから実体を選び、絶対パスで実行する** — `mise exec` は他のプロジェクトの `mise.toml` を読み、足りないツールをインストールした（実測）。shim は mise への symlink なので使わない。ルートの配下にある候補を捨てるのは、開いたリポジトリに置かれた `cccc` を実行しないためである。Claude Code 本体の PATH には `cccc` の実体のディレクトリがあり、相対のエントリは無い（実測）
  - 参照: `home/dot_claude/hooks/executable_run-guard.sh:33`（既存の hook が shim のパスを候補にしている箇所。今回はこの形を採らない）
  - 参照: `research.md` の「cccc の呼び出し方」「Round 1 のレビューを受けて確かめたこと」
- **K7: git リポジトリの中でだけ動かす** — ルートを決めるためと、ホームディレクトリのような広い場所で全体を走査しないため。変更前の内容を git から取るわけではない。ルートは状態に保存し、Stop の時点で違っていれば比べない
  - 参照: `home/dot_claude/hooks/implementations/completion-gate.ts:185-195`（既存の Stop hook は `process.cwd()` を使う。今回は hook の入力の `cwd` を使う）
- **K8: ログは専用の種類を足して書く** — `logQuality` は `lint_tool` と `error_output` が必須で、lint や test の失敗の出力のための型である。`logEvent` は文字列しか受けない。後で頻度を数える（R5）には、パス、名前、基準の値、現在の値が構造として要る。`types/logging-types.ts` に種類を足し、`lib/centralized-logging.ts` に書く関数を足す
  - 参照: `home/dot_claude/hooks/types/logging-types.ts:13-21`、`:44-49`
  - 参照: `home/dot_claude/hooks/lib/centralized-logging.ts:280-286`

## Risks

- **R1**: hook の PATH に `cccc` の実体が無い環境（agent-vm を含む）では、機能全体が動かない → ログに `skip: cccc-not-found` と `recovery` を残す。UI には出さない。host では本体のプロセスの PATH に実体があることを確かめた。plan-1 に、配布後の実セッションでログの `notice` か `skip` を見る手順を入れる
- **R2**: 大きなリポジトリで計測が 1 秒を超える → 2 回続いたら `disabled` にし、1 度だけ知らせる。1 秒未満だが遅いリポジトリ（数千から 1 万ファイル）では、プロンプトごとと Stop ごとにその時間だけ待つ。対処しない。plan-1 で 1 万ファイルの規模を 1 度測り、1 秒の根拠を確かめる。状態はセッションに 1 つなので、遅いリポジトリと別のリポジトリを同じセッションで行き来すると、`timeouts` が毎回 0 から始まり `disabled` に届かない。その間は遅い側のプロンプトごとに 1 秒待つ。対処しない
- **R3**: 同じリポジトリで別のセッションが同時に編集すると、その変更も今回のターンの悪化に数える → 対処しない。通知は止めないので、害は余分な 1 行にとどまる。同じセッションの UserPromptSubmit と Stop が状態ファイルを同時に読み書きすることは想定しない。rename で書くのでファイルは壊れず、起きても 1 ターン分の通知が欠けるだけである
- **R4**: ファイルの改名と関数の移動は「追加」に見える。25 以上の関数を移すと出る → 対処しない。下の「提供しない体験」に書く
- **R5**: 閾値の根拠はこのリポジトリの hook の履歴（TypeScript、名前のある関数、コミット単位）だけである。他の言語、コミット済みの生成物や minify 済みのファイルでは頻度が違いうる → 定数は `lib/complexity-delta.ts` の 1 か所に置く。既定の除外は足さない。誤報を測っていないので、何を外すべきかの根拠が無い。ログの `notice` から後で数える
- **R6**: モデルは通知を知らないので、人が見落とすと誰も対処しない → 対処しない。K4 でモデルへの自動の経路を閉じたことの代償である。ログの `notice` は、見落とした通知を取り戻す手段にはならない（見落とした人はログを読ませる指示も出さない）。人が画面を見ていないセッション（agent-vm での無人の実行を含む）では、通知は読まれない。人が指示してモデルにログを読ませた場合、無害化する前のパス、名前、ルートがモデルの入力に入る。ログはセッションとリポジトリをまたいで溜まるので、今のリポジトリと関係のない過去のリポジトリの文字列も混ざる
- **R7**: 小さい上昇が複数のターンに分かれると、どのターンでも 5 に届かず、出ない → 対処しない。基準をプロンプトごとに取る設計の帰結である
- **R8**: `cccc` がルートの外を指す symlink をたどるかは確かめていない → 計測は読み取りだけで、timeout と `maxBuffer` で区切る。plan-1 で実測し、たどるなら結果をこの spec に戻す
- **R9**: Renovate が `cccc` を更新して JSON の形が変わる → 検証に落ち、例外にはならない。`disabled: "schema"` を入れ、セッションごとに 1 度だけ `systemMessage` で知らせる。形が合わないことは正常な状態では起きないので、黙ったままにしない。ログには `skip: schema` と実体のパスが残る

## Phase 1 で意図的に提供しない体験

### 改名と移動の追跡

- **代替経路確認**: 無い。`cccc` の出力は名前と行番号だけで、関数の本体の同一性を示す値を持たない（`research.md`「cccc の仕様」）
- **非提供対象**: 改名した関数、別のファイルへ移した関数を「同じ関数」と認識すること
- **将来の予定**: ログで誤報が目立てば検討する。予定は無い

### プロジェクトごとの閾値、除外、無効化

- **代替経路確認**: `cccc.toml` があるが、`--no-config` で読まない。開いたリポジトリの設定で計測の対象や出力を変えさせないため。止めたいときは `home/dot_claude/.settings.hooks.json.tmpl` から登録を外して `chezmoi apply` するしかない（`~/.claude/settings.json` は生成物なので、直接消しても次の apply で戻る）
- **非提供対象**: プロジェクトごとに閾値を変える、特定のディレクトリを外す、プロジェクト単位で止める
- **将来の予定**: ログで特定のプロジェクトの誤報が目立った時点で扱う

### モデルへの自動の通知

- **代替経路確認**: ログの `notice`（`~/.claude/logs/complexity.jsonl`）に、パス、名前、基準の値、現在の値が残る。モデルは Read でこのファイルを読める。Bash で `cccc` を実行して測り直すこともできる（`Bash(cccc *)` の静的な許可は無いので、許可を求められることがある）
- **非提供対象**: 該当があったことを、人の指示なしにモデルの文脈へ入れること
- **将来の予定**: 予定は無い。K4 の理由が変わらないかぎり足さない

### cyclomatic の比較

- **代替経路確認**: `cccc` の出力に値はある。人が手で `cccc --table` を実行すれば見られる
- **非提供対象**: cyclomatic の上昇を条件に含めること
- **将来の予定**: 予定は無い。閾値の実測は cognitive だけで行った

## ISO 25010 次元選択

- **機能適合性（機能正確性）**: 比較の規則（K3、K5）が、上に挙げた境界の例で期待どおりの該当を返すこと。この hook の価値は「出すべきときだけ出す」ことにある
- **性能効率性（時間効率性）**: プロンプトごとと Stop ごとに走る。timeout と `disabled` が効くこと
- **信頼性（障害許容性）**: `cccc` が無い、JSON の形が合わない、状態ファイルが壊れている、`version` が違う、ルートが変わった、git の外である、のどの場合も例外を出さず、通知も出さないこと
- **セキュリティ（完全性）**: 開いたリポジトリは信頼できない入力である。ルートの配下の `cccc` を実行しないこと、相対の PATH のエントリを使わないこと、制御文字や改行を含むパスと名前が無害化されて 1 行で出ること、`execFileSync` の既定の 1MiB を超える出力（実測 3MB）で落ちないこと
- **互換性（共存性）**: 既存の Stop hook と UserPromptSubmit hook の動作を変えないこと。登録の整合テスト（`hook-target-drift.test.ts`）を通ること
- **対象外**: 移植性（agent-vm で動くかは `cccc` の実体が PATH にあるかで決まり、R1 のログで分かる。この spec では agent-vm を起動して確かめない）、使用性（文面は 1 件 1 行で、評価の基準を数値にできない）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: Stop の `additionalContext` が追加のターンを起こすかは未確認で、「止めない」と書けない。基準が無いとき、計測が timeout 以外で失敗したときの規則が無い。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: `disabled` の回復手段が 1 度の通知だけで、構造化されていない。`logQuality` の必須フィールド（`lint_tool`、`error_output`）は複雑度の記録に合わない。

### decision-quality-reviewer

- verdict: needs-work
- 主指摘: 降順の順位対応は、大きい関数を 1 つ足すと触れていない関数を悪化として出す（旧 [30, 2]、新 [40, 30, 2]）。`cccc` が見つからないときに黙るのは、全プロジェクトに配る hook の失敗の型そのもの。

### greenfield-perspective-reviewer

- verdict: needs-work
- 主指摘: 白紙案は実測を起源としており妥当。基準の計測に失敗すると前のプロンプトの基準が残る。基準を取ったルートを持たないので、ルートが変わると全関数が追加に見える。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: `saveBaseline` は fingerprint 専用で、そのまま使えない。Stop の hook は並列に走るので、登録順を前提にできない。ログは `logEvent` か専用の型にする。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: 信頼できないリポジトリのパスと関数名がモデルの入力へ逐語で入る。PATH からの探索は、リポジトリ配下に置かれた `cccc` を弾けない。`execFileSync` の `maxBuffer` の既定は 1MiB で、実測の出力 3MB を下回る。

### data-contract-evolution-evaluator

- verdict: needs-work
- 主指摘: 状態ファイルに版が無い。`cccc` の JSON を検証せずに読むと、Renovate の更新で形が変わったときに全プロジェクトで例外になる。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: needs-work
- 主指摘: `root` を成功時にしか書かないので、最初から timeout するリポジトリでは `disabled` が効かない。timeout の数え方が手順に無く、Stop は状態を書かない。該当が 0 件になっても `pending` が残る。

### scope-justification-reviewer

- verdict: pass
- 主指摘: 追加した範囲はどれも注文か Round 1 の指摘に基づく。止める手順の「`settings.json` から外す」は、chezmoi が生成し直すので効かない。

### decision-quality-reviewer

- verdict: pass
- 主指摘: 1 ターン遅れでモデルへ渡す形は、通知の質を落とさない。`cccc` が見つからないことをログだけに残す判断は、`cccc` の無い環境が正常であることから擁護できる。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: `pending` は人が見た文面を運ぶので、白紙から設計しても同じ形になる。`reported` は `pending` との比較で代替できる。

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: ログの種類の追加は `types/logging-types.ts` と `lib/centralized-logging.ts` に閉じ、ローテーションは共通の実装が受け持つ。`pruneStaleBaselines` は今は import のまま使ってよい。

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: `sanitizeForDisplay` はバッククォートと改行を除くので、コードブロックは閉じられず、1 件は 1 行に収まる。ルートの配下の除外は、`cwd` の配下にも適用するとよい。

### data-contract-evolution-evaluator

- verdict: needs-work
- 主指摘: 書き込みが読んだ状態への上書きか全体の置き換えかが決まっておらず、`timeouts` と `disabled` が消えうる。検証が `kind`、`line`、`children`、`path`、`functions` を見ていない。

<!-- auto-review: verdict=needs-work; hash=f4a1db7bf095719b655ec0132bae9dfd9888b53f8e1c091404e0ba8aa9ec095c; design-hash=646b6b6d1897c7fe1330c47430836244aad822b43f74736b0f01eef0ea17404c; round=1; at=2026-10-05T15:14:07.384Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: pass
- 主指摘: Round 2 の 6 件はすべて解消。8 つの場面を手順どおりにたどり、誤った結果も未定義の結果も無い。R6 の手順の番号が古い（反映済み）。

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘: 書き込みの規則と結果ごとのフィールドの値に曖昧な箇所は無い。64 段を超えたときの動作と、状態ファイルが無いときのログの扱いが未定義だった（反映済み）。

### scope-justification-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### decision-quality-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=e9b22a9b4e824b537e62b4a502086be231fcd2d9c68d3d1a2c329c796527cd5d; design-hash=a288b86d376ab21d877b506f7fd4aba5ec6eedaa1882521500653f5cc412d0cc; round=2; at=2026-10-05T15:22:49.609Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 4)

### logic-validator

- verdict: pass
- 主指摘: 手順をたどり直して、誤った結果も未定義の結果も無い。「モデルの文脈には何も足されない」の言い切りは、公式ドキュメントが明記していない点と合わない（反映済み）。

### scope-justification-reviewer

- verdict: pass
- 主指摘: 無害化とログは、モデルへの経路が無くても理由が残る。`shown` の 8KiB の上限は、重複を防ぐためだけに基準まで失う設計になる（SHA-256 に変えて反映済み）。

### decision-quality-reviewer

- verdict: pass
- 主指摘: K4 の理由は挙動と入力の経路に基づいている。ログは見落としを取り戻す手段にならず、形が合わない失敗は黙ったまま続きうる（R6、R9 に反映済み）。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 状態は最小の形にほぼ収まった。`shown` の代わりに基準を進める方法もある（採らない理由を状態ファイルの節に記載）。

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: 境界は Round 2 から動いていない。`systemMessage` だけを返す形は `session.ts:295-298` に先例がある。`event` は入力の `hook_event_name` で渡す（反映済み）。

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: モデルへ自動で入る経路は閉じた。ログは生の値を残すのが正しいが、リポジトリをまたいで溜まる点を R6 が小さく書いていた（反映済み）。

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘: どの分岐でもフィールドの値が定まる。上昇幅が同じ件の並びが未定義で、同じ該当から違う文面ができうる（反映済み）。

<!-- auto-review: verdict=pass; hash=014100ed6c185bc3d30e777a9199cc8ec038bf0e9bd032fd4421954631d8b1f8; design-hash=a288b86d376ab21d877b506f7fd4aba5ec6eedaa1882521500653f5cc412d0cc; round=3; at=2026-10-05T15:25:03.897Z; reviewers=logic-validator+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=79; excluded=1; at=2026-10-05T15:25:20.648Z -->

<!-- auto-review: verdict=pass; hash=bb11a37c2f698dd1d671b5cb961297542c832812a7c11523293d9f139db95d1c; design-hash=dae1ab27b7da6aa57ab6f77da314c566ba6ea37947b7a93851f3a333824c605f; round=4; at=2026-10-05T15:35:40.595Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=24; excluded=0; at=2026-10-05T15:35:40.610Z -->
