# plan-2・plan-4 の作業中に出た小さな残件

いずれも未調査。本文は観察の要約で、原因は推測を含む。

- `delegation record` が振り返りを促す文を出すとき、出力先のパイプが閉じていると EPIPE で落ちたことがある（printReviewPrompt）。
- data-contract のレビュアーの Round 5 の pending が、どの記録に当たるか分からないまま残った。
- commit 前の検査が 1 回だけ失敗し、同じ内容で 2 回目は通った。出力が切れて原因は分からない。
