# ADR-0019: codex の設定を chezmoi の TOML 関数で合成し、行単位の TOML 処理をなくす

## Status

accepted (2026-09-30)

## Context

`~/.codex/config.toml` の合成は dasel と bun に依存していた。host では、dasel が repo の `.mise.toml` から入っていないと `chezmoi apply` が失敗する。bun が無いと、利用者の設定（`projects` の信頼設定など）が黙って消える。VM は dasel のためだけに、ソースの `.mise.toml` を信頼していた。

VM の codex の MCP の絞り込みと自己検査は、TOML を行の並びとして扱う awk と grep だった。ドット区切りのキー、インライン表、複数行の値で書かれた TOML を正しく扱えない（#196）。行単位の TOML 処理は壊す、という指摘を受けた変更である。

設計の全文と検証の記録は、この変更のセッションの spec と plan にある。ここには判断と却下した代替案を記す。使い方と回復手順は `docs/codex-config.md` にある。

## Decision

支配軸は保守性と、設定が黙って消えるリスクの回避である。TOML の解釈は、apply の時点で必ず存在する chezmoi 本体に任せる。

- **K1**: 合成は `modify_` テンプレート（`home/dot_codex/modify_private_config.toml`）で行う。今のファイルは `.chezmoi.stdin` で渡り、無いときは空として扱う。base と host overlay の読み込みと `__CHEZMOI_HOME__` の置き換えは引き継ぐ。`private_config.toml.tmpl` と `private_dot_merge-config.ts` は消し、配置済みの `~/.codex/.merge-config.ts` は `.chezmoiremove` で消す。
- **K2**: マージ規則は今の意味を保つ。強制キーは base と overlay から新しい map に深くマージし、非推奨の `features` は出さず、それ以外の最上位キーは今のファイルが勝つ。違いは 1 点だけで、`model_providers` と `projects` の特別扱いをやめ、他の最上位キーと同じに扱う。テキストの書式は保たれなくなるが、値は保たれる。
- **K3**: 読めない入力では apply を止める。今のファイル、base、overlay が読めないとき、base または存在する overlay が空の表になるとき、overlay が強制キー以外を持つときである。今の「壊れた既存ファイルは `{}` として上書きする」と「bun が無ければ base を素通しする」は、利用者の設定を黙って消すので引き継がない。
- **K4**: VM の codex の絞り込みは、K19 の構成のまま中身を TOML の解釈に替える。`agent-vm/vm-codex-config.awk` を `agent-vm/vm-codex-config.tmpl` に置き換え、最上位の `mcp_servers` のうち許可リスト（`VM_MCP_KEEP`）に無いキーを消す。許可リストが空なら失敗する。テンプレートは `home/` を読まない。
- **K5**: 自己検査は、TOML をパースした構造を全体にわたって探す。配列の中の `mcp_servers` と、表でない `mcp_servers` も違反とする。パースに失敗したら bootstrap を止める。絞り込みと同じテンプレートは使わず、絞り込みの誤りを同じ誤りで見逃さないようにする。
- **K6**: VM はソースの `.mise.toml` を信頼しない。dasel を使う処理が VM に無くなるため、`mise trust` と `mise install dasel` を消す。
- **K7**: 開発用の点検・整形スクリプトからも dasel を外す。正規形からキーの並べ替えを外し、点検は「chezmoi で読めて空でないこと」と「oxfmt の書式との一致」にする。`toToml` の書式は chezmoi のバージョンで変わりうるので、正規形には使わない。
- **K8**: テストは本物の chezmoi で動かし、CI で走らせる。
- **K9**: 記録として、この ADR と `docs/codex-config.md` を書き、ADR-0018 から参照する。

### 却下した代替案

- **差分最小案**: `.merge-config.ts` の中の dasel 呼び出しだけを置き換える。Bun は TOML を読めるが書き出せないので、書き出しを自前で持つことになり、`toToml` が既にある機能を重複して保守する。bun の有無で設定が消える経路も残る。
- **中間案（VM 専用の TOML 道具）**: host のマージは差分最小案のままにし、VM の後処理だけを `yq` や `taplo` に替える。chezmoi が VM に既にあるので道具を足す理由が無く、host と VM で別の TOML 処理が残る。
- **host テンプレートでの絞り込み**: VM の絞り込みを `agent_vm` 条件で host の `modify_` テンプレートに入れる。VM の許可リストを host のテンプレートに持ち込み、ADR-0018 K20（host に影響が無いことの固定）の対象を広げるので採らない。
- **`toToml` を点検の正規形にする**: 点検の期待値を chezmoi の出力にする。go-toml のバージョンで書式が変わると、host と CI の chezmoi の差で点検が揺れる。
- **通常テンプレートで今のファイルを `output "cat"` で読む**: `stat` による分岐と外部コマンドが残るので、`modify_` の標準入力を使う。

## Consequences

- **K3 の止まる範囲**: 壊れた `~/.codex/config.toml` があると、その対象で apply が止まり、`~/.codex` より後の対象は適用されない。壊れたファイルは変わらない。エラーには対象のファイル名と TOML の行番号が出るが、Go のテンプレートに例外を捕まえる仕組みが無いので、エラー文に回復手順は足せない。手順は `docs/codex-config.md` に書いた。VM では bootstrap の失敗として出て、`agent-vm rm` で作り直す。
- **K3 は意図した host の変更**: ADR-0018 K20（VM の導入が host に影響しない）の対象外である。
- **R1（初回の書式の差分）**: `toToml` の書式は dasel と違い（キーの順、下位の表の見出しの字下げ）、初回の apply で書式だけの差分が出る。ホストで apply を確認した結果、変更前と変更後の出力は JSON としても TOML としても等しく、書式だけが違った。コメントは変更前から残らないので、失われるものは増えない。
- **R2（codex が出力を読めるか）**: TOML の仕様では見出しの前の空白は許される。ただし開発ホストでは、codex の CLI が現在起動しない（インストール後にネイティブバイナリが消える。原因は未特定）。そのため「codex が合成したファイルを読める」ことの確認は、ホストではなく agent-vm の VM の中で行う。
- **R7（ローカル日付・時刻のずれ）**: chezmoi v2.72.1 の `fromToml` と `toToml` の往復は、タイムゾーンを持たない日付・時刻・日時を、実行環境のタイムゾーンの分だけずらす（手元で再現した。JST で `2024-01-02` が `2024-01-01` になる。`TZ=UTC` では保たれる）。ずれは apply のたびに重なる。host の `~/.codex/config.toml` と repo の base・overlay には日付・時刻の値が無く、日付型のキーを使う codex の設定も知られていない（codex のスキーマでは未確認）ので、今の実害は無い。既知の制約として `docs/codex-config.md` に書き、`scripts/test-codex-config-merge.sh` の M9 が挙動を固定する。テンプレートの中で検出して止める案は、見分けの根拠が chezmoi と go-toml の文書化されていない内部のラベルで、使われない型のためにテンプレートが複雑になるので採らない。
- **対象外 1（`profile` と `profiles`）**: 今のファイルの `[profiles.x]` に強制キーを書くと、codex がプロファイルの値を優先しうる（codex の実装では未確認）。今のコードも同じ挙動で、この変更で変わらない。別の Issue として扱う（#198）。
- **対象外 2（他の場所から読む MCP の設定）**: プロジェクトの `.codex/config.toml`、`-c` の上書き、`/etc/codex` などは、絞り込みも自己検査も対象にしない。今の VM の許可リストも対象にしていない。
- **対象外 3（パーサーの違い）**: 自己検査は Go の TOML パーサー（chezmoi）で読み、codex は Rust のパーサーで読む。Go のパーサーは重複したキーなどを拒むので、失敗する側に倒れる。ただし 2 つが同じファイルを違う構造に読む可能性は残る。
- **VM の依存の減少**: VM はソースの `.mise.toml` を信頼しなくなり、VM で `.mise.toml` の env や hook が動く経路が無くなる。

## References

- https://github.com/berlysia/dotfiles/issues/196
- https://github.com/berlysia/dotfiles/issues/198
- `docs/codex-config.md`
- `docs/decisions/0018-agent-vm-orbstack.md`
- `home/dot_codex/modify_private_config.toml`
- `agent-vm/bootstrap.sh`
- `scripts/test-codex-config-merge.sh`
