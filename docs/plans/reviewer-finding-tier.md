# レビュアーの指摘に Tier を付けさせる

Document Workflow の自動レビューで、レビュアーに指摘ごとの Tier（must / should / nit）を付けさせる。must が残らなくなった時点で周回を終えられるようにし、細かい指摘が続くせいでレビューが収束しない事態を減らすのが目的である。

この案は、2026-10-27 の session で委譲の評価台帳の案と一緒に出たものの片方である。台帳の側は `delegation` CLI と ADR-0055 で実装した。こちらは手を付けていない。

## やること

- 自動レビューの依頼文で、レビュアーに指摘ごとの Tier を書かせる。must の基準も依頼文に書く。たとえば「設計が誤った挙動をするか、plan に分けられない場合だけ must とし、plan で決められる細部は should にする」
- `workflow.md` の「全員 pass で軽微指摘のみなら新 round を起こさない」と、must が無いことを結び付ける。全員 pass でなくても、must が 0 件なら新しい round を起こさずに反映して終えてよいか、を決める
- reviewer の verdict と Tier の関係を決める（must があれば needs-work、無ければ pass か、レビュアーの判断に任せるか）

## 観察（2026-10-29、session 7893ee87）

委譲の評価台帳の spec のレビューは 6 round かかった。Round 3 までは、依頼文に Tier の基準を書かなかった。Round 4 では 7 名のうち 2 名の依頼文に、Round 5 と 6 では全員の依頼文に、上の must の基準を書いた。non-pass のレビュアーの数は、Round 3 で 3、Round 4 で 2、Round 5 で 1、Round 6 で 0 になった。

標本は 1 つの spec だけで、Round 5 の時点で残る指摘が少なかった影響と区別できない。基準を書いたことが収束の理由だとは、この記録からは言えない。

## 決めること

- Tier を書かせる場所（レビュアーの agent の定義か、`plan-review-automation` が出す依頼文の型か）
- must が 0 件で should が残る場合の扱い（反映して pass とするか、レビュアーをもう一度呼ぶか）
- Tier の付け方が揺れたときの直し方

## 参照

- `.tmp/sessions/6d65229b/followups/delegation-eval-ledger.md`（元の提案。workflow dir の GC で 2026-11-03 ごろ消える）
- `docs/decisions/0055-delegation-ledger.md`
