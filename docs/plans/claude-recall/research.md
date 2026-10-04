# Research: claude-recall の導入

## 対象

https://github.com/babarot/claude-recall（Go、単一バイナリ `recall`）。Claude Code のセッション JSONL を `~/.claude/vault.db`（SQLite FTS5）に取り込み、MCP サーバー・TUI・Web UI で検索させる。

## 確認した事実

### リリースと年齢ゲート

- repo の created_at は 2026-04-10、初リリース 0.1.0 は 2026-09-29。最新は 1.5.0（2026-10-03T16:33Z）。10 リリースすべてが公開から 7 日未満
- `home/dot_config/mise/config.toml` の `minimum_release_age = "7d"` により、`mise ls-remote github:babarot/claude-recall` は空になり、`10 newer ... releases hidden by minimum_release_age` と警告が出る
- バージョンを明示すると通る: `mise install --dry-run github:babarot/claude-recall@1.5.0` → `would install`
- 年齢ゲートの扱いはユーザーが「1.5.0 を明示 pin」と回答済み

### バイナリの配置

- リリース asset は `claude-recall-linux-x86_64` など、アーカイブではない単一バイナリ
- mise github backend の `bin` option で名前を変えられる（mise docs: 「Use `bin` for single binary downloads (non-archives)」）
- 実測: `mise install 'github:babarot/claude-recall[bin=recall]@1.5.0'` → `installs/github-babarot-claude-recall/1.5.0/recall`。`recall --version` → `recall 1.5.0`。sha256 `e1543aac…35c1` が `checksums.txt` の linux-x86_64 の値と一致
- config.toml は Renovate の mise manager が厳格にパースする plain TOML（ファイル冒頭のコメント）。table 形式のエントリはすでにある（`"npm:@mizchi/readability" = { version = ..., allow_low_downloads = true }`）

### Claude Code plugin

- 上流の `plugin/` には `.claude-plugin/plugin.json`、`.mcp.json`（`recall mcp`）、`hooks/hooks.json`（SessionEnd で `recall import 2>/dev/null`、async）、`skills/recall/SKILL.md`（`recall ui` を起動してブラウザで開く）がある
- repo にも plugin にも marketplace.json はない。そのため `claude_plugins.yaml`（marketplace 経由の `claude plugin install`）には載せられない
- README: 「A plugin directory under `~/.claude/skills/` loads as `claude-recall@skills-dir`」
- リリースごとに `claude-recall-plugin.tar.gz` が出る。1.5.0 の tar の中身は `./.claude-plugin/plugin.json`、`./hooks/hooks.json`、`./.mcp.json`、`./skills/recall/SKILL.md` で、トップディレクトリはない。sha256 `6923106d…f34f` が checksums.txt と一致
- SKILL.md を読んだ。外部送信はなく、localhost:6276 の UI を `xdg-open` で開くだけ

### dotfiles 側の配布経路

- `home/.chezmoiexternal.toml.tmpl` には、`~/.claude/skills/ui-skills/SKILL.md` を external で置く先例がある
- `home/.chezmoiscripts/run_after_sync-skills.sh.tmpl` は `.skills/` から `~/.claude/skills/` へ `rsync -a --delete` する。tool が持つディレクトリは `TOOL_OWNED_EXCLUDE_ARGS`（`/ui-skills` `/.system` `/synced` `/.trash`）で守っている。external で `~/.claude/skills/claude-recall` に置くなら、ここに足さないと apply のたびに消える
- `run_after_sync-mods` は `~/.claude/mods/` 配下で `mods/` にないディレクトリを `rm -rf` する。そのため external の置き先にはできない
- `tests/smoke/run_after_sync-skills/{apm-only,empty-env}/setup.sh` は exclude の一覧を持っていない（grep で `ui-skills` / `exclude` はヒットしない）
- chezmoi v2.72.2。`chezmoi execute-template '{{ (include "dot_config/mise/config.toml" | fromToml).tools ... }}'` で config.toml からバージョンを読める（gomi で `1.6.5` を確認）

### archive external の実測（使い捨て source / destination、`mktemp -d` 配下）

- `type = "archive"`、1.5.0 の URL、`exact = true`、`checksum.sha256` だけの場合 → `chezmoi: .claude/skills/claude-recall: inconsistent state (...)` で止まる。tar の `./` エントリが external 自身と重なるため
- `stripComponents = 1` を足すと、`.claude/skills/claude-recall/` の直下に `.mcp.json`、`.claude-plugin/plugin.json`、`hooks/hooks.json`、`skills/recall/SKILL.md` の 4 ファイルが出る
- 空の `--cache` で `chezmoi managed --refresh-externals=never --include all` を実行 → 終了コード 0。archive の中身 4 ファイルまで列挙され、cache に `httpcache` ができる。つまり、キャッシュがなければ `never` でも取得する

### PATH と CI

- `home/dot_shell_common/init.sh` で `mise activate zsh|bash` を行う。この Claude Code セッションの Bash ツールの PATH には mise installs のディレクトリが 36 件入っている。つまり Claude Code はこの PATH を継いで起動されている
- `renovate.json` の mise manager は `dot_config/mise/(config|conf.d/*).toml` を対象にし、mise のツールに `minimumReleaseAge: 7 days` を付ける。mise ツールを automerge する repo ルールはない
- `.github/workflows/ci-agent-vm.yml` は `home/dot_config/mise/**` の変更で起動する。`tests/agent-vm/run-templates.sh` は `chezmoi managed --refresh-externals=never` を VM と host のデータで実行する
- `.chezmoiignore` の agent_vm 分岐は `.claude/**` と `.config/mise/config.toml` を VM に入れる。`conf.d/host-toolchains.toml` は go / rust 系だけを置くと決まっている

## 未検証

- skills-dir から plugin が読み込まれ、MCP・hook・skill が有効になるか（新しいセッションで確認する）
- Renovate の mise manager が `github:` backend の table 形式を更新するか
- 上流が vault.db のスキーマを自動で移行するか
