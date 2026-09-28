# Document Workflow レビューフェーズ:実コスト・歩留まり分析

## データ範囲と既知の欠落

`reviewer-runs.log` 保有セッション N=7(project-A×2, project-B×2, chezmoi×3)、doc は 9 件(二層モードの spec/plan-N を含む)。**project-A/A2 は plan.md 等が session dir から消失**(promotion 先の候補文書も照合したが該当なし)。`plan-review.cache.json` と `.round-baseline` から spec.md が round6、plan.md が round3、plan-1/2/3 が計 15 クラスタと分かるのみで、内容は追えない。**この 1 件は部分データとして別枠**。

もう一点、計器側の誤り: `reviewer-runs.log` は `security-vulnerability-analyzer` と `architecture-boundary-analyzer` を一度も記録しない。4 セッションで meta.json 実行数とログ行数の差が両者の実行数に厳密一致(例: A1 は 39−33=6=security5+architecture1)。ログはラウンド構成の完全な索引ではない。

## セッション×doc 概要

| doc                 | rounds                                   | 常時4名+extras                           | verdict推移                                            | 承認     | round内wall-clock(並列/最遅) | inter-round gap                        |
| ------------------- | ---------------------------------------- | ---------------------------------------- | ------------------------------------------------------ | -------- | ---------------------------- | -------------------------------------- |
| A1/archived         | 4                                        | +security,test,deployment(→architecture) | NW×3→pass                                              | approved | median~50-150s               | 2-6min                                 |
| A1/current          | 4                                        | +security,test,deployment                | NW→pass→NW→pass                                        | approved | 同上                         | 2-21min(+日をまたぐ空白2387min=別作業) |
| project-B/B1        | 3                                        | extrasなし                               | NW(4/4)→NW(1)→pass                                     | approved | ~75-210s                     | 4-6min                                 |
| project-B/B2 spec   | 3                                        | +security                                | blocker→blocker→blocker→(スコープ確定, 再検証なし)pass | approved | ~45-410s                     | 7min                                   |
| project-B/B2 plan-1 | 5                                        | extrasなし(plan層2名)                    | NW→pass→pass→NW(nit)→pass                              | approved | 同上                         | 7min〜170min                           |
| chezmoi/d4443fb3    | 2                                        | extrasなし                               | NW(3/4)→pass                                           | approved | ~55-130s                     | 3min                                   |
| chezmoi/85e77cd5    | 3                                        | extrasなし                               | NW→NW→pass                                             | approved | ~50-170s                     | 1.5-3min                               |
| chezmoi/5a9f74bd    | 3                                        | +security                                | NW(3/5)→NW(3/5)→pass                                   | approved | 60s-34min(outlier)           | 12-36min                               |
| project-A/A2        | 部分(spec6/plan3/plan-1・2各1/plan-3・3) | 不明                                     | 不明(データ欠落)                                       | 不明     | —                            | —                                      |

サンプル内 8/8 doc が最終的に approved(棄却例は観測なし)。

## ラウンド歩留まり曲線(新規実質指摘の有無、N=対象doc数)

| Round | 新規実質指摘あり | 率   |
| ----- | ---------------- | ---- |
| R1    | 8/8              | 100% |
| R2    | 5/8              | 63%  |
| R3    | 3/7              | 43%  |
| R4    | 0/3              | 0%   |
| R5    | 0/1              | 0%   |

R4以降は本サンプルでは新規指摘ゼロ(N小、確定的結論ではない)。B2/plan-1 の R4 は編集起因の記述不整合(ISO25010節の対象ファイル数の書き間違い)であり、レビューが再発見したものではなく編集自体が生んだ手直しコスト。

## レビュアー別(needs-work/blocker率、コスト目安)

| reviewer                               | N(出現) | 実質指摘率 | 傾向                                                                                                                                    |
| -------------------------------------- | ------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| logic-validator                        | 27      | 16/27=59%  | 最高。実コードの確認・実行で、計画のままなら混入していた実バグを複数回捕捉(プロセス制御・キー正規化・作業ツリー操作の各領域で 1 件ずつ) |
| greenfield-perspective-reviewer        | 22      | 7/22=32%   | 中                                                                                                                                      |
| scope-justification-reviewer           | 27      | 3/27=11%   | 低。ほぼ確認/繰り返し                                                                                                                   |
| decision-quality-reviewer              | 22      | 2/22=9%    | 低。ほぼpass/advisory                                                                                                                   |
| security-vulnerability-analyzer(extra) | 11      | 6/11=55%   | 高いがB2/specの3/3 blockerに牽引(N小)                                                                                                   |
| test-quality-evaluator(extra)          | 6       | 3/6=50%    | N小                                                                                                                                     |
| deployment-readiness-evaluator(extra)  | 4       | 1/4=25%    | N小                                                                                                                                     |
| architecture-boundary-analyzer(extra)  | 2       | 0/2=0%     | N=2、判断不能                                                                                                                           |

logic-validator はレビュアー枠の約28%(27/95)だがコストも比例以上に大きい(セッション内reviewer cache_read の30-70%、A1で5.7M/19.0M等)。コストと歩留まりは一致——コードを読み実行するから見つかる。逆にscope-justification/decision-qualityは1件あたり安いが低歩留まり。extra reviewer は高分散: A1/current では security/test/deployment 3名が全ラウンドpass(advisory止まり)でコストのみ、B2/spec では security が3/3 blockerで必須級。

## コスト(概算・注記あり)

reviewer subagent の入力側トークン(cache_creation/read)は cost-state の sonnet層合計とcc基準で32-85%、cr基準で4-28%一致(cc/crは価格が異なるため両端をブラケットとし中点を点推定)。sonnet層自体はセッション総$の40-62%。合成するとレビューフェーズ(入力側のみ、output はストリーミング記録の欠落で帰属不能)はセッション総コストの概ね5-27%、多くは12-27%。B2/spec の最終pass(13:05)はレビュアー再実行なしの再スタンプで、blocker は独立検証でなくスコープ確定(指摘対象を当該変更の範囲外と明記)で解消された点は要記録。

## まとめ

コストは「ラウンド数×always-on4名」に集中し、extrasは使われた場合のみ上乗せ(高分散)。低歩留まりは R4以降の確認ラウンドとscope-justification/decision-qualityの繰り返し確認、および編集起因の自己矛盾修正(B2/plan-1のR4)。A2は最重セッションだがdoc内容欠落のため個別歩留まり評価不能——部分データとして明記。
