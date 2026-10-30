# reviewer の Codex 経路の対象を読み取れる文面にする

`document-workflow-reference` の「帳簿に載る reviewer」は、どの reviewer が Codex で動くかを読み取れない。片付いたら、このファイルを消す。

## 状態

提案・未着手。出どころ: dotfiles-feedback 20261030T141830Z-06b757aa53e6。

## 分かっていること

- `.skills/document-workflow-reference/SKILL.md` の 2 か所が「帳簿に載る reviewer」と書く。この語の定義は同じ skill に無い。
- `home/dot_claude/agents/` のうち `executor: codex` を持つ定義は 10 個である（2026-10-30 に数えた）。
- あるセッションで、route の推奨が codex のときに、内容で選ばれた追加の reviewer 3 名を対象外かもしれないと読み、sonnet で起動した。3 名の定義には `executor: codex` があった。定義を読まなかったのは、メインループの誤りである。
- この読み違いが起きると、追加の reviewer が route の推奨から外れて動き、枠の配分と記録の比較がずれる。

## 再開するときの手順

1. 対象を「定義に `executor: codex` がある reviewer。必須か追加かを問わない。無ければ executor なしで起動する」と書き換える。
2. `plan-review-automation` の推奨文に、reviewer ごとの Codex 経路の可否を出すかを決める。定義を検索して判定できると推測しているが、確かめていない。

`docs/decisions/0057-route-lookahead-and-surplus.md` にも同じ語がある。ADR は経緯の記録なので書き換えない。
