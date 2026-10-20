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
