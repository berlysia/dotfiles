# agent-vm の持ち越した課題

原因を切り分けていない観測を、症状と再現の条件だけ記す。仕様ではなく、再現して原因を特定するまで `docs/agent-vm.md` には書かない。

## iTerm に macOS のアクセス許可ダイアログが出る

- 症状: iTerm に対する macOS のアクセス許可（「"書類"フォルダ内のファイル」「ほかのアプリのデータ」）が出る。
- 再現の条件: launcher 経由で claude / codex を続けて起動すると、3 回の起動の間に合わせて 4 回出た。launcher を使わずに `orb delete` と `op item delete` / `op item get` だけを実行したときにも、「ほかのアプリのデータ」の許可が出た。
- 分かっていること: launcher が触れるのは状態の置き場、`~/.config/agent-vm`、`~/.claude/projects`、`~/.codex/sessions`、repo だけである。`orb` と `op` のどちらが原因かは切り分けていない。

## package.json の版だけを変えた `chezmoi apply` で `bun install --frozen-lockfile` が失敗する

- 症状: `bun install --frozen-lockfile` が lockfile の不一致で失敗し、`chezmoi apply` の終了コードが 1 になる。
- 再現の条件: `package.json` の依存の版だけを変えて（lockfile は更新せずに）`chezmoi apply` を実行する。`package.json` を戻して再実行すると終了コード 0 になる。
- 分かっていること: ブラウザのストアの更新とは無関係だった。

## `agent-vm rm` の確認プロンプトに EOF を渡すと「failed unexpectedly」と出る

- 症状: 「failed unexpectedly」と表示される。
- 再現の条件: `agent-vm rm` の確認プロンプトの入力に EOF を渡す（標準入力を閉じる、または空にする）。

## VM の中の `$HOME` が host と違うと、新しい worktree の置き場がずれる見込み

- 見込まれる症状（作成）: VM の中で作った worktree が、VM の `$HOME/worktrees/<repo>/` に置かれる。そこは VM だけにあり、host から見えない。該当する作成の手段は `git-worktree-create` と Claude Code の `--worktree` である。
- 見込まれる症状（同期）: node_modules の同期は、host の `~/worktrees/<repo>/` にある worktree を置き場の外と判定し、同期しない。
- 起きる条件の見込み: 置き場は、規則を実行した場所の `$HOME` から決まる。規則の `currentRoot` は、シェル（`worktree-location.sh`）と TS（`worktree-locations.ts`）の両方にある。OrbStack の machine の中の `$HOME` が `/home/<user>` で、host の `/Users/<user>` と違えば起きる。
- 分かっていること: VM の中の `$HOME` の値は確かめていない。確かめられたのは WSL だけで、そこには OrbStack が無い。置き場が `<repo>/.git/worktree/` だった間は、置き場が repo の mount の中にあったので起きなかった。
- 確かめ方: mac で `agent-vm shell` を開いて `echo $HOME` を見る。値が host と違えば、host の home を VM の中の規則に渡す案（`agent-vm` が環境変数で渡し、規則が `$HOME` より先に読む）を検討する。直すまでは、mac で `chezmoi apply` をしない。
