# codex の設定（`~/.codex/config.toml`）の合成

`~/.codex/config.toml` は、chezmoi が `apply` のたびに 3 層から作る。chezmoi 本体の TOML 関数だけで動き、dasel や bun は要らない。判断の経緯は `docs/decisions/0019-codex-config-toml-merge.md` にある。

## 仕組み

合成は `home/dot_codex/modify_private_config.toml`（`modify_` テンプレート）が行う。入力は次の 3 つである。

1. base: `home/dot_codex/.config.toml`
2. host overlay: `home/dot_codex/.config.<hostname>.toml`（そのマシンの hostname のファイルがあるときだけ使う）
3. 今の `~/.codex/config.toml`（利用者や codex が書き足した内容）

base と overlay の `__CHEZMOI_HOME__` は、ホームディレクトリの絶対パスに置き換えて読む。

## 規則

- 次のキーは強制キーで、値は必ず base と overlay から来る: `mcp_servers` `sandbox_mode` `sandbox_workspace_write` `shell_environment_policy` `allow_login_shell` `approval_policy` `network_access`
  - 表は深くマージし、スカラーと配列は overlay が勝つ
  - 今のファイルにある強制キーの値は捨てる
  - base にも overlay にも無い強制キーは出力に出ない
  - overlay は強制キー以外の最上位キーを持てない
- `features` は非推奨のキーとして出力に出さない。
- それ以外の最上位キーは、今のファイルにあればその値が残り、無ければ base の値になる。
- 出力は TOML を読み込んで書き直すので、コメントとキーの順は残らない。値は保たれる。
- すべての `[profiles.*]` から `sandbox_mode` と `approval_policy` を取り除く。codex（0.130.0 で確認）は有効な profile の値を最上位の値より優先し、`-p` は最上位の `profile` が無くても profile を選べるため、残すと強制キーを上書きできてしまう（#198）。profile の他のキーと `profile` 自体は残る。
  - 強制キーのうち他の 5 つは、codex の profile に書けないキーなので対象にしない。
  - 新しい codex の `--profile` が重ねる `<name>.config.toml` と、強制キーに入っていない `default_permissions` は、この合成では制御できていない（未確認の穴として #198 に記録）。

## apply が止まったとき

読めない入力があると、ファイルを変えずに apply を止める。chezmoi は失敗した対象で打ち切るので、`~/.codex` より後の対象も適用されない。

- エラーに `.codex/config.toml` と `toml: line N` が出たとき: 今のファイルが TOML として読めない。その行を直して apply し直す。
- 直せないとき: `mv ~/.codex/config.toml ~/.codex/config.toml.broken` で退避して apply し直し、退避したファイルから `[projects.…]` など必要な部分を戻す。退避すると `projects` の信頼設定は失われるので、戻す作業が要る。
- エラーに `has no keys` や `may only set forced keys` が出たとき: repo の base か overlay の誤りである。エラーに名前が出たファイルを直す。
- VM の中で止まったとき: `agent-vm rm` で作り直す。

## VM

VM では apply の後に `agent-vm/vm-codex-config.tmpl` が許可リスト外の MCP を取り除き、bootstrap が取り除けたことを自己検査する。詳細は `docs/agent-vm.md` にある。

## 既知の制約

TOML のタイムゾーンを持たない日付・時刻・日時（ローカル日付、ローカル時刻、ローカル日時）は、apply のたびに実行環境のタイムゾーンの分だけずれる。`~/.codex/config.toml` にはこれらを書かない。タイムゾーン付きの日時は保たれる。

これは chezmoi の `fromToml` と `toToml` の往復で起きる挙動で、`scripts/test-codex-config-merge.sh` の M9 が現状の挙動を固定している。chezmoi 側が直ればこのテストが失敗して知らせる。

## 初めてこの仕組みで apply する前に

出力の書式が変わり（キーの順、下位の表の見出しの字下げ）、コメントが消える。値は変わらない。初回の前に退避しておく。

```bash
cp -p ~/.codex/config.toml ~/.codex/config.toml.before-modify
```

退避したファイルは、不要になったら削除する。

## 元に戻すとき

1. この仕組みを入れたコミットを `git revert` する。`private_config.toml.tmpl` と `private_dot_merge-config.ts` が戻り、`.chezmoiremove` の `.codex/.merge-config.ts` の行も消える。
2. 退避したファイルを `~/.codex/config.toml` に戻す。
3. `chezmoi apply` を実行する。

戻したあとの合成は dasel と bun を使う。dasel を `.mise.toml` から外すコミットの後であれば、そのコミットも revert して dasel を戻す必要がある。
