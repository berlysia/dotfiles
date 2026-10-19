# dotfiles-sync-doctor の実機確認

PR #323 を merge した後に、各マシンで行う。終わったらこのファイルを消す。

1. `chezmoi update` を実行する（この時点では hook はまだ無い）。続けて `chezmoi init` で config を作り直す。
2. `dotfiles-sync-doctor` を実行する。exit 0 になり、`update hook: installed` と `signing: ok` が出ることを確かめる。
3. 1Password の Settings > Developer で「Use the SSH agent」をオフにし、未 push のコミットを 1 つ作ってから `chezmoi update` を実行する。pull の前に `update: pre:` で止まり、`fix: start and unlock 1Password` が表示されることを確かめる。確かめたら設定をオンに戻し、コミットを消す。
