# 日本語の文章スキルの、役割と入口の関係を見直す

ADR-0036 は、文章スキルを規則を持つ役割（`ja-*`）と、読み手と目的を持つ入口（koncise、tanteki、yomiyasu、japanese-tech-writing）の 2 層に分けた。入口は役割を読み、役割どうしは `ja-fact-preservation` だけを読む。

## 今の状態

- `782b4366` で、CLAUDE.md の常時規則が `ja-check/references/human-documents.md` を直接読ませるようになった。入口を通らずに役割を使う読み方で、利用者の言う「実質的に新しい入口」に当たる。ADR には書かれていない
- 同じ commit で、`ja-structure/SKILL.md` が `../ja-check/references/human-documents.md` を指すようになった。役割どうしの参照なので、`check-skill-refs.sh` の検査で `skill-upstreams tests` が落ちていた（master の `45c2e786` 以降）
- 当面の対処として、`check-skill-refs.sh` の役割の許可の一覧に、この 1 ファイルだけを足した（`ROLE_ALLOWED_EXACT`）

## 決めること

- CLAUDE.md の常時規則を、ADR-0036 の 5 つ目の入口として扱うか。扱うなら、その入口が持つもの（`human-documents.md` の必須手順）と、どの役割を読むかを決める
- `human-documents.md` を `ja-check` の資料のまま置くか、入口の側へ移すか。移すなら、役割から読んでよい場所の一覧も同じ変更で直し、上の許可を外す
- 決めた形を、ADR-0036 の改訂か新しい ADR として残す
