# ADR-0035: 承認依頼の Executive Summary を「前提→目指す状態→今の状態→やり方→確かめ方」で始める

## Status

accepted (2026-10-19)

ADR-0026 が「Executive Summary の書式」として workflow.md に残した規則の、書式そのものを改訂する。規則を workflow.md に置く理由（hook の通知が Bash の stamp では届かない）は変わらない。

## Context

利用者から、spec や plan の承認時に「spec がこうなので、こういう状態を目指すために、今こういう状態から、こういうやり方をする、こうやって確かめながらやる」という説明がほしい、と依頼があった。Executive Summary に取り入れ、spec と plan の両方に対応させる形でよい、という。「両対応」は、spec と plan のどちらにも使える 1 つの書式という意味だと利用者に確かめた。

それまでの書式は、Goal / Proposed Approach / Experience Delta / Scope / Key Decisions / Risks / Review Status / Open Questions / Next Action を並べるだけだった。書式の定義は `rules/workflow.md` の節と、pass 後の Write / Edit で `plan-review-automation` が出す `buildSummaryReminder` の 2 か所にある。この書式には次の問題があった。

- 項目間のつながり（なぜその状態を目指すか、どこから始めるか、どう確かめるか）を書く場所が無い。
- 「今の状態」は Experience Delta の変更前の中に埋もれ、「確かめ方」には欄が無い。
- plan-N.md では、親 spec のどの決定を受けた plan かが書かれない。

以前にも、承認の質問をレビューの細部や仕組みの説明から書き始め、利用者に「読んでもわからん」と 2 度指摘されたことがある（agent-learnings L-ff9dd5979b8e）。

workflow.md は常時ロードされるので、予算テスト（`workflow-md-budget.test.ts`、13,312 bytes）がある。変更前は 12,697 bytes で、残りは 615 bytes だった。

## Decision

- **K1（5 項目と順）**: 承認依頼の冒頭に、前提 → 目指す状態 → 今の状態 → やり方 → 確かめ方の 5 項目を、この順に、前の項目を受けて 1-2 行ずつ書く。ラベル付きの箇条で書く。やり方には途中の確認点を含める。Goal / Proposed Approach / Experience Delta はこの 5 項目に置き換える。Scope 以降の 6 項目は文面を変えずに後ろに残す。
- **K2（層ごとの出どころ）**: 書式は 1 つにし、層ごとに違うのは出どころだけにする。hook はファイル名で出し分けず、各項目のプレースホルダに層ごとの出どころを並べて書く。

  | 項目       | spec.md / 単層 plan.md                                                                    | plan-N.md                  |
  | ---------- | ----------------------------------------------------------------------------------------- | -------------------------- |
  | 前提       | 元のオーダーの引用                                                                        | 親 spec の K-id / Scope    |
  | 目指す状態 | Goal                                                                                      | 担う K の完了像            |
  | 今の状態   | research.md の観察                                                                        | 同左                       |
  | やり方     | 方針と Tasks の順、途中の確認点                                                           | 同左                       |
  | 確かめ方   | 単層 plan.md はテスト計画の入力 → 期待結果、spec.md は ISO 25010 次元選択で選んだ品質特性 | ISO 25010 具体テストケース |

  元のオーダーを書く欄はどの文書にも無いので、会話の原文から要約せずに引用する。

- **K3（写して足さない）**: どの項目も、文書と元のオーダーの記述から写し、そこに無い主張を足さない。無ければ `N/A`。この規則を節の先頭に 1 つだけ置く。
- **K4（自己検証）**: 「Experience Delta が Goal の達成に直結しているか」に代えて、「確かめ方の各行が目指す状態のどれを確かめるか」を自己検証する。
- **K5（2 か所の一致）**: workflow.md の節と `buildSummaryReminder` の文面を、同じ項目、同じ順、同じ出どころの語でそろえる。テストで両方を読み、項目名の並びと出どころの語が一致することを確かめる。

### 却下した代替案

- **旧 9 項目を残し、「今の状態」と「確かめ方」を足す（差分最小案）**: 項目の順が Goal → Approach → Delta のままで、オーダーの流れにならない。Goal と目指す状態、Proposed Approach とやり方が重なり、同じことを 2 回書くことになる。
- **5 項目を 1 文の連鎖で書かせる**: 読みやすいが、項目が抜けても気づきにくく、テストで項目を確かめられない。
- **spec 用と plan 用に書式を分ける**: 承認者が知りたいこと（なぜ・どこへ・どこから・どうやって・どう確かめるか）は層で変わらず、違うのは出どころだけである。書式を分けても読み手の得るものは増えず、規則と hook の文面が倍になる。
- **旧書式と新書式を併用する**: 「両対応」のもう 1 つの読み方。利用者が「spec と plan の両方」の意味だと確かめたので採らない。
- **書式を stamp の出力に載せて届け方を直す**: ADR-0026 の見送り課題で、今回の依頼（説明の中身）とは別の問題なので扱わない。

## Consequences

1. workflow.md は 13,215 bytes になり、予算の残りは 97 bytes になった。次に workflow.md へ足す変更は、どこかを削るか、予算を上げる ADR が要る。
2. 流れのある説明になるか、要約が本文と食い違わないかは、機械では検査できない。model が規則に従うことに頼る。最初の確認は、この変更自身の承認依頼を新しい書式で書いたことである。5 項目とも文書とオーダーから写せた。
3. spec 層と plan-N 層の承認依頼は、この変更の時点ではまだ試していない。spec 層の「確かめ方」は、選んだ品質特性までしか書けない。具体的なケースは plan-N に書く決まりだからである。
4. hook の通知は、引き続き pass 後の Write / Edit でしか出ない（ADR-0026 の Consequences 2）。Bash の stamp で終える流れでは、workflow.md の節だけが届く。

## References

- 改訂の対象: `docs/decisions/0026-rule-removal-requires-delivery-and-backstop.md`
- 実装:
  - `home/dot_claude/rules/workflow.md`
  - `home/dot_claude/hooks/lib/workflow-review-core.ts`
- テスト:
  - `home/dot_claude/hooks/tests/unit/plan-review-automation.test.ts`
  - `home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts`
- 出どころの根拠:
  - `home/dot_claude/templates/spec.md`
  - `home/dot_claude/templates/plan-execution.md`
