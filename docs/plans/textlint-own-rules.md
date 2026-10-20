# textlint の検査を 1 つの仕組みにまとめ、tanteki の独自ルールを自分のものにする

グローバル textlint（`textlint-global`）と tanteki の検査は、依存の置き場だけが共通で、検査を走らせる仕組みと設定は別々にある。これを 1 つの仕組みにまとめ、tanteki の独自ルールは上流の写しではなく、自分で解釈し直したルールとして持つ。片付いたら、このファイルを消す。

## 今の状態（#335 の merge 後）

- 共通にしたもの: 依存。tanteki の依存は `home/dot_config/textlint/package.json` と `bun.lock` に入っており、`.skills/tanteki/node_modules` は `~/.config/textlint/node_modules` への相対 symlink である（`docs/decisions/0036-japanese-writing-skills-roles-and-entries.md`）
- 別々のもの:

|                | tanteki                                                                                                                | グローバル textlint                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 走らせる仕組み | `.skills/tanteki/scripts/lint.mjs` が `@textlint/kernel` でルールを組み立てる。`--type` で文書の種類ごとに検査を変える | `textlint-global` が textlint の CLI を呼ぶ    |
| 設定           | `.skills/tanteki/.textlintrc.json`                                                                                     | `home/dot_config/textlint/dot_textlintrc.json` |
| ルール         | `preset-japanese` と、独自ルール 5 本（`.skills/tanteki/rules/`）                                                      | `preset-ai-words-ja`                           |

- 独自ルールは、上流 `iwasa-kosui/tanteki` の写し（`Derived from` 行あり）で、週次の `skill-upstreams.yml` で上流の変更を追っている

## 前提: 文章スキルの役割分け（ADR-0036）との関係

ADR-0036 では、「検査の道具は作り直さず、上流の派生のまま持つ」と決めている。根拠は、ルールが約 24KB あること、上流で tests 11 本を通していること、週次の追跡で上流の修正を知れることである。この構想はその決定を覆すので、別の spec で扱い、決まったら ADR-0036 を改訂する ADR を書く。

検査の手順の持ち主は、役割スキルの `ja-check`（textlint 系と yomiyasu 系の検査の分担と手順を持つ）である。統合した後も `ja-check` が持つ見込みである。

## 決めること

- 1 つにまとめる単位。走らせる仕組み（`textlint-global` に寄せるか、`lint.mjs` のような自前の runner に寄せるか）と、設定（文書の種類ごとの切り替えを、CLI の設定ファイルでどう表すか）
- 独自ルールの置き場（`home/dot_config/textlint/` の下か、別のパッケージか）と、配備の経路
- 解釈し直す範囲。5 本のルール（`no-ai-jargon`、`no-opaque-compound`、`no-vague-action`、`stock-boundary`、`table-cell-length`）と `rules/lib/japanese-rule.mjs` の、どれを残し、どれを書き直し、どれを捨てるか
- 上流の tests の代わりに、自分で持つ tests
- ルールを自作に移した後の、tanteki の `Derived from` 行の扱い（`check-skill-upstreams.sh` は 1 スキルに `Derived from` を 1 本だけ許し、LICENSE があれば必須にする）と、週次の追跡から外すもの
- ADR-0036 の付表（上流ファイルと役割の対応表）との整合

## 確かめていないこと

- textlint の CLI の `--rulesdir` などで、パッケージになっていない ESM（`.mjs`）のルールを読めるか
- 文書の種類ごとの切り替え（`lint.mjs` の `--type`）を、CLI の設定だけで表せるか
