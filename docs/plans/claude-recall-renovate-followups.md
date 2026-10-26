# claude-recall の Renovate 自動更新: 残件

Renovate が claude-recall の mise の版と、`home/.chezmoiexternal.toml.tmpl` のプラグインの版と sha256 を同じ PR で更新するようにした変更の残件。経緯は、この変更の commit の本文にある。

## auto-fix ワークフローが claude-recall の PR で動かなかった理由

claude-recall の PR が CI で落ちたとき、`auto-fix-dependencies.yml` は起動した（調べる入口は run `38688669815`）。しかし `Get PR information` の段階で skip 判定になり、Claude は動かなかった。PR を特定できなかったのか、bot の PR と判定されなかったのかは、まだ調べていない。

調べること:

- skip 判定が意図どおりか。
- もし Claude が動いた場合に、上流の内容（changelog、リリースノート）を読んだ agent が sha256 の行を書き換えうるか。autonomous-lane charter の「allowlist は injection を防がない」に該当する。
