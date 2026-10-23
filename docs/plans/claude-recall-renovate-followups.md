# claude-recall の Renovate 自動更新: 残件

Renovate が claude-recall の mise の版と、`home/.chezmoiexternal.toml.tmpl` のプラグインの版と sha256 を同じ PR で更新するようにした変更の残件。経緯は、この変更の commit の本文にある。

## 最初の実際の bump PR で確かめる

ローカルの Renovate CLI の dry-run では、両方の dep が同じ版を選び、テンプレートの sha256 が上流の `checksums.txt` の値に更新された。hosted の Renovate App が同じように動くかは、まだ確かめていない。

次の `renovate/claude-recall` の PR で、次の 2 点を見る。

- diff に `home/.chezmoiexternal.toml.tmpl` の 2 行（版と sha256）が含まれている。v1.12.0 の PR #317 で含まれていた。
- `agent-vm tests (ubuntu-latest)` が通る。

確かめたら、この節を消す。含まれていなければ、PR はテンプレートのガードで落ちる（手で直す手順はガードのエラーメッセージにある）。その場合は、Renovate の PR のログで `claude-recall-plugin` の dep が抽出されたかを調べる。

PR #317 の `agent-vm tests (ubuntu-latest)` は `claude-recall plugin layout differs from upstream` で落ちた。原因は、展開の検査が 1.7.2 の tarball の 4 ファイルを固定の一覧で持っていたことで、v1.12.0 の tarball は `skills/` をやめて `hooks/register.tsx` などの module を持つ。chezmoi は tarball どおりに展開していた。検査の期待値を pin した tarball の一覧から作るように直したので、#317 を rebase して ubuntu が通るのを確かめたら、この節を消す。

## auto-fix ワークフローが claude-recall の PR で動かなかった理由

claude-recall の PR が CI で落ちたとき、`auto-fix-dependencies.yml` は起動した（調べる入口は run `38688669815`）。しかし `Get PR information` の段階で skip 判定になり、Claude は動かなかった。PR を特定できなかったのか、bot の PR と判定されなかったのかは、まだ調べていない。

調べること:

- skip 判定が意図どおりか。
- もし Claude が動いた場合に、上流の内容（changelog、リリースノート）を読んだ agent が sha256 の行を書き換えうるか。autonomous-lane charter の「allowlist は injection を防がない」に当たる。
