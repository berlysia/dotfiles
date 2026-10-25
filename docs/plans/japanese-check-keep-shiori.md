# japanese-check の注記を shiori で追う

japanese-check は、候補を残す判断を文書の中の注記（`ja-check-keep`）で受ける。注記が増えると、どこに何件あり、どれが古いかを一覧で見たくなる。shiori の台帳でこれを追えるようにする。

## shiori 側で要る変更

shiori 0.2.2 は `.md` を HTML のコメントとして読まない。拡張子の表（`EXTENSION_MAP`）に `.md` が無く、Markdown は `//` や `/* */` のコメントとして読まれる。berlysia/shiori の `feat/markdown-comment-syntax` ブランチで、`.md` と `.markdown` を HTML の系統に加えた。`.mdx` は対象外である。このブランチが公開版に入るのを待つ。

既定の `--patterns` には `.md` が入らないので、dotfiles 側で設定か `-p "**/*.md"` で指定する。

## `ja-check-keep` を指令として読ませる設定

shiori の変更は要らず、`.config/shiori/config.yaml` で独自の指令を定義すれば足りる。

```yaml
candidates:
  ja-check:
    keep: true
    _matchers:
      keep:
        pattern: "\\bja-check-keep\\s+(.*)"
        rules: csv
        separator: "--"
```

- `keep: true` が要る。自分で定義した指令は、明示しない限り無効である。
- 0.2.2 で、同じ中身を `.html` に置いて確かめた。`shiori:` の付いた注記は注記として、付かない注記は台帳に載っていない候補として出た。
- `rules: csv` は空白でも分けるので、`<rule> <text>` の 2 語が 2 つの規則として読まれ、1 つの注記が同じ ref の注記 2 件になった。先頭の語だけを規則として読む指定があるかを、取り込む前に確かめる。

## dotfiles 側の段取り

shiori の公開版が `.md` を読めるようになったら、次を行う。

1. `shiori init` で `.config/shiori/` に台帳を作り、上の `config.yaml` を置く。scan の対象に `**/*.md` を入れる。
2. 注記の理由の欄を `shiori: JA-<番号> reason="…"` の形で書き、台帳に同じ番号を登録する。japanese-check は理由の欄を自由な文として読むので、この形でも動きは変わらない。
3. `shiori verify` を CI に入れ、台帳に無い番号と、文書から消えた番号を落とす。
