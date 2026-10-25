# ref の無い ja-check-keep の注記も CI で落とす

dotfiles の `ja-check-keep` の注記は、shiori の台帳（`.config/shiori/registry.json`）で追っている。CI の「shiori Annotations」は、台帳と文書の ref を比べる。ただし今は、理由に `shiori: JA-<番号>` を付け忘れた注記を CI で落とさない。付け忘れた注記は、`shiori check` の出力に台帳に無い候補として出るだけである。

落とさないのは、shiori 0.3.0 が Markdown のコードブロックとインラインコードの中のコメントも読むためである。ADR-0048 と ja-check の手順書にある書き方の例が候補になるので、候補で落とすと、例のたびに CI が止まる。この件は berlysia/shiori#9 に出した。

## やること

shiori#9 が直った版が公開されたら、次を行う。

1. `home/dot_config/mise/config.toml` の shiori の版を上げる。
2. リポジトリの根で `shiori check` を実行し、候補が本物の注記だけになったことを確かめる。書き方の例が候補に出なければよい。
3. 台帳に無い候補でも落ちるように、`.github/workflows/ci-shiori.yml` の check の条件を変える。shiori の新しい版で、候補を落とす指定が何かを確かめてから書く。
4. ADR-0048 の Amendments に、ref の無い注記も落とすようにしたことを書き、このファイルを消す。
