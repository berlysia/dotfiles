# textlint の検査を 1 つの仕組みにまとめ、tanteki の独自ルールを自分のものにする

グローバル textlint（`textlint-global`）と tanteki の検査は、依存の置き場だけが共通で、検査を走らせる仕組みと設定は別々にある。これを 1 つの仕組みにまとめ、tanteki の独自ルールは上流の写しではなく、自分で解釈し直したルールとして持つ。片付いたら、このファイルを消す。

## 今の状態

- 共通にしたもの: 依存。tanteki の依存は `home/dot_config/textlint/package.json` と `bun.lock` に入っており、`.skills/tanteki/node_modules` は `~/.config/textlint/node_modules` への相対 symlink である（`docs/decisions/0036-japanese-writing-skills-roles-and-entries.md`）
- 別々のもの:

|                | tanteki                                                                                                                | グローバル textlint                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 走らせる仕組み | `.skills/tanteki/scripts/lint.mjs` が `@textlint/kernel` でルールを組み立てる。`--type` で文書の種類ごとに検査を変える | `textlint-global` が textlint の CLI を呼ぶ    |
| 設定           | `.skills/tanteki/.textlintrc.json`                                                                                     | `home/dot_config/textlint/dot_textlintrc.json` |
| ルール         | `preset-japanese` と、独自ルール 2 本（`.skills/tanteki/rules/`）                                                      | `preset-japanese`（仮の設定。ADR-0050）        |

- 独自ルールは、上流 `iwasa-kosui/tanteki` の写し（`Derived from` 行あり）で、週次の `skill-upstreams.yml` で上流の変更を追っている
- 形態素解析を使っていた独自ルール 2 本と共通の lib は、japanese-check の `check` の検査に移した（ADR-0051）。tanteki に残る独自ルールは `stock-boundary` と `table-cell-length` で、どちらも形態素解析を使わない
- 語の辞書で検出していた `no-ai-jargon` と `preset-ai-words-ja` の語は、japanese-check の一覧（`home/dot_claude/japanese-check/data/words.json`）に移した（ADR-0050）
- グローバル textlint の設定は、rule が 0 本だと止まる。そのため、構想が決まるまで `preset-japanese` にしてある

## 前提: 文章スキルの役割分け（ADR-0036）との関係

ADR-0036 は、検査の道具を含めて自作する案（「上流を写さず、検査の道具も含めて自作する（白紙設計）」）を却下し、上流の派生のまま持つと決めている。却下の根拠は、ルールの量、上流で tests を通していること、週次の追跡で上流の修正を知れることである。形態素解析を使う 2 本については、ADR-0051 がこの決定を上書きした。残る 2 本と検査を走らせる仕組みについての構想も、決まったら ADR-0036 を上書きする ADR を書く。

検査の手順の持ち主は、役割スキルの `ja-check`（textlint 系と yomiyasu 系の検査の分担と手順を持つ）である。統合した後も `ja-check` が持つ見込みである。

## 決めること

- 1 つにまとめる単位。走らせる仕組み（`textlint-global` に寄せるか、`lint.mjs` のような自前の runner に寄せるか）と、設定（文書の種類ごとの切り替えを、CLI の設定ファイルでどう表すか）
- 独自ルールの置き場（`home/dot_config/textlint/` の下か、別のパッケージか）と、配備の経路
- 解釈し直す範囲。残る 2 本のルール（`stock-boundary`、`table-cell-length`）の、どれを残し、どれを書き直し、どれを捨てるか
- 上流の tests の代わりに、自分で持つ tests
- 残る 2 本を自作に移した後の、tanteki の `Derived from` 行の扱い（`check-skill-upstreams.sh` は 1 スキルに `Derived from` を 1 本だけ許し、LICENSE があれば必須にする）と、週次の追跡から外すもの
- 上流のファイルのうち、規則を役割へ移したものと入口に残したものの振り分け（各役割スキルの「参考」節と、ADR-0036「上流の取り込み」の取り込み時の確認）との整合

## 確かめていないこと

- textlint の CLI の `--rulesdir` などで、パッケージになっていない ESM（`.mjs`）のルールを読めるか
- 文書の種類ごとの切り替え（`lint.mjs` の `--type`）を、CLI の設定だけで表せるか
