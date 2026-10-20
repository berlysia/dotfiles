# ADR-0038: マシン固有で非公開のローカルファイルは別の chezmoi source が持ち、gateway セッション用の plugin は `claude()` が読み込む

## Status

accepted (2026-10-20)

## Context

このリポジトリは public である。gateway セッション（`docs/llm-gateway-sessions.md`）には、公開できない値を持つローカルファイルが要る。

- `~/.env.1password.local`: gateway の URL などの平文と、1Password の参照
- `~/.config/claude-local/gateway-mcp.json`: gateway 経由の MCP 定義

これらはこのリポジトリが管理しない手書きのファイルで、どこにも記録が無く、別のマシンで再現できなかった。gateway セッションでだけ使うスキル（非公開の情報を前提にするもの）の置き場所も無かった。

観察した制約は次のとおりである。

- `~/.claude/skills/` は `run_after_sync-skills.sh.tmpl` の `rsync --delete` が、除外リストに無い名前を消す。
- `~/.claude/settings.json` の `env`（`CLAUDE_CODE_PLUGIN_DIRS` を含む）は、このリポジトリのテンプレートが丸ごと置き換える。
- `~/.claude.json` の `mcpServers` と settings はこのリポジトリが生成しており、別のツールが書くと書き合いになる。
- `claude()` はすでに gateway セッションで `--mcp-config=~/.config/claude-local/gateway-mcp.json` を付けていた。

## Decision

1. 公開できないローカルファイルは、config と state を分けた 2 つ目の chezmoi source（private リポジトリ）が持つ。2 つ目の source は専用の config ファイル（`chezmoi -c <別の config>`）で動かし、素の `chezmoi` を向けない。このリポジトリが管理するパス（`~/.config` 自体、`~/.claude/` 配下の生成物）には書かない。
2. gateway セッション用の plugin は `~/.config/claude-local/plugins/<名前>/` に置き、`claude()` が `--mcp-config` と同じ条件で、直下の各ディレクトリを名前順に `--plugin-dir` で付ける。
3. このリポジトリには、2 の読み込み経路と、置き場所の規約だけを書く。中身（社内の値、plugin の中身、照合の規則）は 2 つ目の source に置く。

## 却下した案

- このリポジトリに混ぜる: 公開できない値が public の履歴に入る。
- 個人の非公開スキル用の external（private-skills）に入れる: 個人の正典と業務の情報が混ざる。
- `~/.claude/skills/` に置く: `rsync --delete` で消える。
- settings の `CLAUDE_CODE_PLUGIN_DIRS` に足す: このリポジトリのテンプレートが丸ごと置き換え、2 つ目の source から足せない。

## Consequences

- `~/.config/claude-local/plugins/` に置いた plugin は、検証なしでそのまま読み込まれる。このディレクトリは利用者本人が管理する（2 つ目の source の push 権限を持つ者が、このマシンでの実行権限を持つのと同じ）。
- 2 つ目の source とこのリポジトリは、ファイル単位では管理対象が重ならない。親ディレクトリ（`~/.config`、`~/.local/bin`）は両方に出るが、どちらも `exact_` にしない。
- `claude()` の振る舞いは `tests/claude-wrapper/` で確かめる（gateway 変数が無いときは今までどおり素通し）。
- 社内固有の決定・照合規則・計測値は、2 つ目の source の README にある。このリポジトリには書かない。

## References

- `home/dot_shell_common/functions.sh`（`claude()`）
- `tests/claude-wrapper/run.sh`
- `docs/llm-gateway-sessions.md`
