# japanese-check の注記を shiori で追う

japanese-check は、候補を残す判断を文書の中の注記（`ja-check-keep`）で受ける。注記が増えると、どこに何件あり、どれが古いかを一覧で見たくなる。shiori の台帳でこれを追えるようにする。

## shiori 側で要る変更

berlysia/shiori に、次の 2 つが要る。0.2.2 で確かめた。

- `.md` を HTML のコメントとして読む。拡張子の表（`EXTENSION_MAP`）に `.md` が無く、Markdown は `//` や `/* */` のコメントとして読まれる。同じ中身を `.html` にすると、単独の `<!-- shiori: JA-2 -->` は注記として見つかった。
- `ja-check-keep` を lint の指令として認める。今は、知っている lint の指令の後ろの `-- shiori:` だけを注記として扱うので、`ja-check-keep … -- shiori: JA-1` の形は注記として扱わない。

## dotfiles 側の段取り

shiori が上の 2 つに対応したら、次を行う。

1. `shiori init` で `.config/shiori/` に台帳を作る。
2. 注記の理由の欄を `shiori: JA-<番号> reason="…"` の形で書き、台帳に同じ番号を登録する。japanese-check は理由の欄を自由な文として読むので、この形でも動きは変わらない。
3. `shiori verify` を CI に入れ、台帳に無い番号と、文書から消えた番号を落とす。
