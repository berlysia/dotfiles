# koncise の残件

`.skills/koncise/` は規範の文書だけで、機械的な検査を持たない。下の節がすべて片付いたら、このファイルを消す。

## 検査スクリプトを作る

koncise を実際の文書 5 本ほどにかけ、同じ規則の所見が 3 本以上で出たら作る。今は集めた文章が無く、規則をどこまで機械で拾えるか決められないため後回しにした。検出する型を選ぶ設計判断を含むので、着手するときは Document Workflow（plan.md）を通す。

検出の候補:

- 規則 10 の定型句（「〜について説明します」「ご不明点があればお気軽に」など）
- 6 件以上の、手順でない箇条書き（規則 9）
- 1 行目が行動でも成果でもない文章（規則 1、7）

候補を出すだけにし、直すかどうかの判断は規範の側に残す（yomiyasu の lint と同じ割り切り）。

## 「併用」節の yomiyasu の扱いを決める

tanteki と japanese-tech-writing とは、`docs/llm-gateway-sessions.md` に重ねて試した。koncise と食い違った箇所（冒頭の予告、識別子を出すかどうか、長い表の扱い）は、どれも「併用」節の分担で 1 通りに決まった。

yomiyasu（[nanaism/yomiyasu](https://github.com/nanaism/yomiyasu) の `79d15a6`）は、このリポジトリには入っていない。取ってきて同じ文書に重ねると、「併用」節の分担では決まらない食い違いが出た。

- 節の順: yomiyasu の SKILL.md は「見出しと節の数と順は、どの種類と読者でも変えません」とする。koncise の規則 1 と 4 は節を後ろへ移す
- 手順の数: yomiyasu の `references/doc-types/manual.md` は「手順の数と順を変えない」とする。koncise の規則 2 は 1 手順 1 操作に分ける
- 出力: 「書き手に確かめたい点」の上限が yomiyasu は 2 点、koncise は 3 点
- 検査の順: yomiyasu は検査（`yomiyasu_check.py`）の後に本文を 1 字でも変えたら、検査をやり直すよう求める。記録を `.yomiyasu/` に書く

koncise を先にかけ、その出力に yomiyasu をかける順にすれば、yomiyasu は koncise が決めた節と手順を原文として保つので、上の 4 点のうち始めの 2 点と検査の順は解ける。各 1 回の試しでは、この順でも逆の順でも、先にかけたスキルの直しは残った。

yomiyasu は自己管理にして、文章スキルを役割別に分ける作業の中で扱う（`docs/plans/writing-skills-by-role.md`）。「併用」節の書き方は、そこで決まった役割の分け方に合わせて直す。
