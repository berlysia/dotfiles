# 検査コマンドの使い方

日本語の表現や文書の形式を機械的に検査します。内容が正しいかどうかは、執筆者が別に確認します。検査は 2 つの道具に分かれます。

- `textlint-global`: 第三者の `preset-japanese` だけを走らせます。助詞の重複や二重否定など、日本語の文法上の問題を見ます
- japanese-check の `check --profile <種類>`: 作業進捗の混入と表のセルの長さを、`findings` の候補として出します。ルール名は `stock-boundary` と `table-cell-length` です

## コマンドを実行する

`textlint-global` は PATH にあり、どのディレクトリから実行しても同じ設定で動きます。必要なパッケージはグローバル textlint のランタイムが入れているので、パッケージのインストールは不要です。

```sh
textlint-global --format json /absolute/path/to/design.md
```

`--format` を省くと、画面で読むための形式で出ます。機械で読むときは `json` を指定します。入力には 1 つ以上の Markdown ファイルを指定します。検査によって入力ファイルが書き換わることはありません。

japanese-check の `check` には、文書の区分に対応する種類を `--profile` で渡します。区分から種類への対応は[文書分類](document-types.md#検査コマンドの指定値)の表にあります。

```sh
node ~/.claude/japanese-check/cli.ts check --profile design /absolute/path/to/design.md
```

同じ文書の `check` は、最終稿も含めてすべて同じ `--profile` で走らせます。`--profile` を付けない `check` では、作業進捗の検査と表のセルの検査は動きません。

## 検査するルール

| ルール名 | 走らせる道具 | 検査する内容 |
|---|---|---|
| `preset-japanese` | `textlint-global` | 助詞の重複や二重否定など、日本語の文法上の問題 |
| `stock-boundary` | `check --profile` | 参照用の文書に混ざった作業進捗や追跡情報 |
| `table-cell-length` | `check --profile` | 表の見出しと本文セルの文字数 |

`stock-boundary` は、種類が `design` か `reference` のときに動きます。作業進捗、チェックボックス、PR番号、PR・Issue・Jira の URL が対象です。`table-cell-length` は、`design`、`reference`、`procedure`、`report` のときに動きます。

`check` は、形態素解析の結果から次の 2 つも `findings` として出します。名詞を重ねた分かりにくい名詞句（`opaque-compound`）と、程度や指示語だけで動作を述べる曖昧な表現（`vague-action`）です。

## 日本語の文型と検出範囲

文型の検査は japanese-check の `check` が持ちます。`適切に対応しました` のような曖昧な動作や、`業務の効率化の基盤` のような名詞の連なりは、`check` の `findings` に `vague-action`、`opaque-compound` として出ます。`textlint-global` は、助詞の重複や二重否定など、preset-japanese の検査だけを行います。

文脈に合う言葉かどうかは執筆者が判断します。検査で扱っていない表現や、離れた語同士の修飾関係、文脈に合う訳語かどうかも、執筆者が確認します。未知の問題を見つけたら、同じ構造の言い換えと、それに似た正しい用例をテストに加え、検出漏れと誤検出の両方を確認します。

## 表の文字数

`table-cell-length` は、表示上 61 文字以上のセルを指摘します。Markdown の装飾記号とリンク先の URL は数えず、リンクの表示文とインラインコードは数えます。セル前後の空白は数えません。結合文字と複数コードポイントの絵文字は、表示上の 1 文字として数えます。`<br>` は改行 1 文字として数え、セル内で改行しても、セル全体で数えます。

引用原文とコード例はこのルールの対象外です。先頭に `|` の無い表は、表として扱いません。長い説明を表へ詰め込まず、表の外へ移してください。条件や例外を削ってはいけません。意味のない分割や独自の略語で文字数だけを減らしてもいけません。

## 終了コード

`textlint-global` の終了コードで、検査が完了したかを確認できます。

| 終了コード | 意味 |
|---|---|
| `0` | 検査が完了し、指摘がない |
| `1` | 検査が完了し、指摘がある |
| `2` | 引数・設定・ファイルの読み書きにエラーがある。実行環境が無いときも 2 で、stderr に `textlint: runtime not installed` が出る |

終了コード 1 で、stderr に `Cannot find package` か `ERR_MODULE_NOT_FOUND` があるときは、指摘ではなく依存が見つからない状態です。

検査が動かないときの扱いは、`SKILL.md` の「検査して届ける」に従います。

指摘された表現は、文の意味を確認してから直し、最終変更後に再検査してください。検査に通っても、辞書やパターンにない表現、文をまたぐ指示関係、事実の正しさは保証されません。日本語の意味は [日本語の基準](japanese.md)、節の分担と形は [文書の構成と本文の形](structure.md) に沿って確認します。一般の技術語を長さだけで禁止しません。直訳調の語の検出は `textlint-global` の対象外で、japanese-check の `check` が持ちます。

## 残す表現の記録

検査の指摘を残す表現は、本文の該当行に japanese-check の keep の注記（rule 名、対象の文字列、理由を書く）で記録します。書き方は japanese-check の `check` の出力と SKILL を参照してください。`textlint-global` に、例外を登録する設定はありません。表セルの上限も緩められません。検査を通すためにルール全体を無効にしたり、問題のある文をコードや引用へ移したりしてはいけません。
