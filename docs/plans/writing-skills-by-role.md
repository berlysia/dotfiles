# 日本語の文章スキルを役割別に分ける

koncise と tanteki、japanese-tech-writing、yomiyasu を同じ文書に重ねて試したところ、各スキルが同じ役割を別々に持っていて、食い違いはその重なりから出た。役割ごとに 1 つのスキルが持つ形に組み直す。片付いたら、このファイルを消す。

設計の判断を複数のスキルにまたがって含むので、Document Workflow（spec と plan-N）で進める。koncise の残件（`docs/plans/koncise-followups.md`）とは別の branch にする。

## 試しで見えた役割と、今の持ち主

| 役割                                       | 今の持ち主                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| 事実を変えない（数値、否定、条件、識別子） | koncise、tanteki、yomiyasu がそれぞれに書いている                           |
| 構成と順序                                 | koncise。yomiyasu は「見出しと節の数と順を変えない」とする                  |
| 表記と文体（読点、比喩動詞、太字、定型句） | japanese-tech-writing、tanteki、yomiyasu。koncise も規則 8、10 で一部を持つ |
| 機械的な検査                               | tanteki（textlint）、yomiyasu（Python の lint と check）                    |
| 読み手と文書の種類の判定                   | tanteki、yomiyasu がそれぞれに持つ                                          |

順に重ねる試し（koncise → yomiyasu と、その逆）では、どちらの順でも先にかけたスキルの直しが残った。各 1 回の試しなので、揺れの幅はまだ分からない。

## 先に行うこと: tanteki と yomiyasu を自己管理にする

役割で分けるには、外のスキルの中にも手を入れる必要がある。koncise と imozuru と同じく、`.skills/` の下に置いて自分で持つ。

- tanteki: [iwasa-kosui/tanteki](https://github.com/iwasa-kosui/tanteki)、MIT（Copyright (c) 2026 Kosui Iwasa）。今は `home/dot_apm/apm.yml` で入れている。textlint の依存（`package.json`）と `scripts/lint.mjs`、独自の rule を持つ
- yomiyasu: [nanaism/yomiyasu](https://github.com/nanaism/yomiyasu)、MIT（Copyright (c) 2026 nanaism）。今は入れていない。`79d15a6` を読んだ。Python の lint、check、hook と plugin の定義を持つ。同梱の Unicode 由来データには `UNICODE-LICENSE.txt`（Unicode License V3）が付く。検証に使った外部資料（CC BY 4.0 など）の権利は各著作者にあると README にある

決めること:

- 取り込む範囲（SKILL.md と参照文書だけか、スクリプトと依存も含めるか。yomiyasu の hook とコーパスを持つか）
- 上流の commit と、派生元の書き方（koncise の末尾の `Derived from` 行と `LICENSE` の写しにそろえる）
- apm.yml から tanteki を外す手順と、`docs/decisions/0024-skill-approval-checklist.md` の確認
- 依存の置き場（tanteki の node_modules、yomiyasu の Python）と、`run_after_sync-skills` の rsync での扱い
