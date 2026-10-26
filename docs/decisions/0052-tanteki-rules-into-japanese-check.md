# ADR-0052: tanteki に残る独自ルール 2 本を japanese-check に移し、textlint を textlint-global の 1 つにする

## Status

accepted (2026-10-27)

## Context

tanteki の textlint には、上流 `iwasa-kosui/tanteki` からコピーした独自ルールが 2 本残っていた。
`stock-boundary` は、参照用の文書に混ざった作業の追跡（進捗の記述、PR の番号、Issue の URL、チェックボックス）を検出する。
`table-cell-length` は、60 字を超える表のセルを検出する。
どちらも形態素解析を使わず、自分たちのテストは無かった。

textlint を走らせる仕組みは 2 つあった。
tanteki の `lint.mjs`（`git show 203e2005:.skills/tanteki/scripts/lint.mjs`）は、`--type` に応じて `stock-boundary` を有効にし、preset-japanese と 2 本を走らせる。
`textlint-global` は preset-japanese だけを走らせる。
手順から呼ばれていたのは `lint.mjs` だけで、`textlint-global` は手で使う道具だった。

形態素解析を使う 2 本は、ADR-0051 で japanese-check の check に移した。
利用者は、残る 2 本も同じ方向で check に移すと決めた。

japanese-check の文書の種類（profile）の行には、この移し替えのための `stockBoundary` の欄が先にあり、どの検査もまだ読んでいなかった。

## Decision

- **K1: 2 本は japanese-check の `blocks.ts` に作り直し、`check` の `findings` に候補を出す。**
  - rule 名は `stock-boundary` と `table-cell-length` のまま。
  - 上流のコードは引き継いでいない。上流のテストの例文（stock-boundary の 8 つ、table-cell-length の 5 つ）で、上流と同じ行と桁に候補が出ることを確かめた
  - 判定は Markdown の構文木を使わず、行で行う。`markdown.ts` の同じ走査から返す `blockLines` が、空白に置き換えると空になる行（URL だけの行など）、参照定義の行、リストに続く 4 空白のリストの行も返す。検査する文字列は、コメントの範囲だけを空白にした元の行で、インラインコードと URL も検査する
  - 上流の URL の正規表現は、行ごとに当てると繰り返しの入力で二乗の時間になる。`http(s)://` の出現から区切りまでを 1 回だけ判定する走査に置き換えた。一致は上流と同じ
  - 表のセルの見える文字（リンクの表示文、インラインコード、画像の alt、自動リンク、裸の URL）は 1 回の走査で数え、閉じの記号の探索に上限を付けた
- **K2: 2 本は `--profile` を付けた `check` でだけ有効にする。**
  - `stock-boundary` は profile の行の `stockBoundary`、`table-cell-length` は新しい欄 `tableCells` で決める
  - hook のゲートが求める `--profile` なしの check では走らない。2 本は tanteki の合格条件で、文書の種類によって使うかが決まり、ゲートは種類を知らないため
  - 表のセルが 60 字を超えるのは、追跡している 295 文書のうち 30 文書・171 セルある。常に有効にすると、種類に合わない文書でも候補が出る
- **K3: tanteki の 7 区分を profile に対応させる。**
  - design-doc・prd・adr・rfc は design、stock は新しい行 reference、flow は procedure、record は report
  - 対応表は tanteki の `references/document-types.md` に置く。上流に無い節なので、上流を取り込むときに残す
  - tanteki の文書の check は、最終稿も含めてすべて同じ `--profile` で走らせる
  - PR と commit の本文の行 caller も `tableCells` を真にした。pr-description が PR の本文に tanteki の textlint を通させていて、`table-cell-length` が適用されていたため
- **K4: textlint の仕組みは `textlint-global` の 1 つにする。**
  - tanteki の `scripts/`、`.textlintrc.json`、`rules/`、`node_modules` の symlink を消した
  - textlint のランタイムから、`lint.mjs` だけが使っていた依存 4 つを外した
  - 手順は `textlint-global --format json` で、件数は JSON の `messages` の合計にする
- **K5: ADR-0036 の決定のうち 2 つを、この ADR が外す。**
  - 1 つ目は、tanteki の rule を上流の派生のまま持つこと
  - 2 つ目は、tanteki の依存の置き場（`node_modules` の symlink と check-skill-refs の許可）
  - ADR-0036 の本文と Status は書き換えない
  - tanteki の SKILL と references は上流のコピーのままで、派生のスキルとして残る。週次の追跡も今のまま。上流の rules と scripts の変更も通知されるのは受け入れる

### 構文木を考え直す基準

行の判定で上流と違う点が、下の一覧の外で見つかり、直すと `blockLines` が `markdown.ts` の走査と別の走査になるときは、Markdown の解析器を依存に足すことを考え直す。

## 却下した代替案

- **2 本を自分の textlint パッケージにし、`textlint-global` に種類ごとの設定ファイルを選ばせる。** textlint の構文木をそのまま使える。しかし、独自の規則の置き場が japanese-check と textlint に分かれたまま残り、種類の決め方も 2 か所になる。指摘も受領証に残らない
- **2 本を常に有効にする。** 種類に合わない文書の受領証に候補が増える（30 文書・171 セル）
- **stock を design の行に寄せる。** genre と、設計の文書のための module 構成まで stock の文書に適用される
- **Markdown の解析器を japanese-check の依存に足す。** 依存の検査（ADR-0051 の配布の不変条件）の手間が増え、元の行と桁を取り戻す写像も要る

## Consequences

### 上流と違う点

- 先頭に `|` の無い表は表として扱わない
- `>` の無い引用の続きの行は引用として扱わない
- 「進捗:」の値や「PR」と「#12」が改行で分かれた形は検出しない
- `-` が 3 つ未満の区切りの行は表の行として扱う（セルが短いので候補にはならない）
- 引用の中の見出し、表、チェックボックスは検出しない（上流と同じ）
- リストの記号の無い 4 空白の行はコードとして除く（入れ子を落とす側に倒した）
- 表のセルの名前つき文字参照は、よく使う約 30 の名前だけを展開する。定義の無い参照式のリンクと、`)` を含む URL のリンクは、上流と数え方が違いうる

### 受領証と keep の注記

- 検査器のハッシュに `blocks.ts` と profile の `tableCells` が入るので、配布すると既存の受領証はすべて古くなる。profile つきで検査し直した文書は、2 本の候補を直すか keep の注記で残すまで受領証が通らない
- 走らなかった rule（`--profile` が無い、または行の欄が偽）の keep の注記は、照合の前に除き、問題にしない
- keep の注記を読む行に、リストの続きと参照定義の行を足した。ほかの検査（`proseLines` を読む検査）はこれらの行を読まないので、そこに書いた既存の rule の注記は「該当する候補が無い」問題として出るようになった。この変更の時点で、リポジトリの文書にその形の注記は無かった

### genre

profile を付けると、行の genre が `--genre` より優先される（profile の設計）。
flow と record に対応する procedure と report の行は genre が business で、長い文の候補の閾値が 80 字になる。
Qiita の技術記事 34 万字（8,901 行）で比べた。design と reference は候補の差が 0 だった。procedure と report は、長い文の候補が 768 件から 1,045 件に増えた。
技術寄りの flow や record の文書では、長い文の候補が増える。

### 限界

- `Finding.text` に、一致した URL のクエリが出る。出る先は check の JSON 出力と keep の照合だけで、受領証は候補の数だけを持つ
- `lint.mjs` を消した後、配布より前の手順を読んだ別のセッションが `lint.mjs` を呼ぶと失敗する。2 本の移し替えと手順の更新を同じ PR にして、1 回の配布で反映されるようにした

## References

- 前提の決定: ADR-0036（文章スキルの役割と入口）、ADR-0047（日本語文書のゲート）、ADR-0048（keep の印）、ADR-0051（形態素解析の語の契約）
- コード（どれも `home/dot_claude/japanese-check/` の下）: `blocks.ts`、`markdown.ts`、`data/profiles.json`
- 手順: `.skills/ja-check/SKILL.md`、`.skills/tanteki/references/document-types.md`
