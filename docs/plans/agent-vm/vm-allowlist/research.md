# Research: agent-vm に配る dotfiles を allowlist にする

## 発端

PR #191 の mac 実機検証（2026-09-29、OrbStack 2.2.3、Ubuntu resolute arm64）で、`agent-vm prewarm` の初回 bootstrap が 2 通りに止まった。

1. `run_before_10-validate-json-templates-unix` が `jq: command not found` で失敗する（rc=1、109 秒）。VM に jq を手で入れて再実行すると次に進む。
2. `run_onchange_install-packages-1-linux` が apt で host 用の一覧を入れる途中、推奨依存で入った postfix の debconf ダイアログ（Postfix Configuration）で入力待ちになり、14 分以上止まった。bootstrap は stdin が `/dev/null` の非対話実行なので、永久に進まない。

どちらも、VM を「普通の Linux host」として host 用構成をそのまま適用していることが原因である。ユーザー判断: VM に配るものを allowlist にする（Option A）。

## 事実（観測・実験で確認したもの）

### 現状の VM 分岐

- VM 判定は chezmoi data の `agent_vm`（`home/.chezmoi.toml.tmpl:10`、`stat "/etc/agent-vm"`）。参照しているのは `home/dot_config/mise/config.toml.tmpl` だけである。
- spec.md:46 は「`agent_vm` は mise 軽量化のみ」と明記し、ADR-0018 の K4 は「分岐は 1 つ（data キー 1 つ）」と書く。allowlist 化は分岐の**適用範囲**を広げる新しい決定であり、K4 の「data キーは 1 つ」は保たれる。

### `.chezmoiignore` の意味論（chezmoi v2.72.1、一時 source/destination/config で実験）

- `**` で全ターゲットを除外できる（dotfile とネストも含む）。`*` はトップレベルにしか効かない。
- `!pat` は再包含する。**再包含は順序に関係なく除外に勝つ**。再包含したサブツリーの一部を除外し直すことはできない。
- ディレクトリを丸ごと戻すには `!dir` と `!dir/**` の両方が要る。`!dir/file` 単独でも、そのファイルは戻る。
- パターンは属性を除いたターゲットパスに当たる。script は `.chezmoiscripts/<run_ 系の属性と .tmpl を除いた名前>` に当たる（例: `run_onchange_after_install-safe-chain.sh.tmpl` → `.chezmoiscripts/install-safe-chain.sh`）。ソース名で書くとマッチせず、**黙って全部実行される**。
- `.chezmoiexternal` の項目も同じ規則で絞り込まれる。
- `.chezmoiignore` は config と同じ data でテンプレート展開される。`dig "agent_vm" false .` はキー不在で false になる。

### 既存設計の制約（docs/plans/agent-vm/spec.md、ADR-0018）

- K2: staging は追跡ファイル全体（`git ls-files`）の複製。allowlist は apply 時の絞り込みであり、staging の中身は変わらない。
- K3: staging のハッシュは追跡ファイル全体から計算される。`.chezmoiignore` や `bootstrap.sh` の変更は、既存 VM でも次回起動時に再 bootstrap を起こす。修正を既存 VM に届ける経路はこれで足りる。
- K4: host では描画結果が変わらないこと（mise では `test_host_render_equals_template_without_vm_guards` で担保している）。
- K7 / V15: `~/.claude/.credentials.json` と `~/.codex/auth.json` が再 apply 後も残ること。`exact_` を持ち込まない限り、ignore は既存ファイルに触れない。
- K8: 署名と push は agent forwarding で、gitconfig は host と同じもの。VM には `~/.gitconfig`、`~/.gitconfig_gpg_ssh`、`~/.config/git/allowed_signers` が要る。
- K9: `~/.claude/projects` と `~/.codex/sessions` は bootstrap が outbox へ symlink する。chezmoi の管理対象に入れない。
- K16: claude は bootstrap が公式 installer で入れる（chezmoi 外）。
- cloud-init はマシン作成時にしか走らない。既存 VM に前提パッケージを届けるには、bootstrap 側でも冪等に入れる必要がある。
- `sudo` は環境をリセットするので、`DEBIAN_FRONTEND=noninteractive` は `sudo DEBIAN_FRONTEND=noninteractive apt-get …` の形で渡す必要がある。

### VM で必要なものの棚卸し（要点。根拠は各ファイル）

| 区分 | 対象 |
|---|---|
| 必須 | `~/.claude/settings.json`（`update-settings-json` が jq で合成）、`~/.claude/{package.json,bunfig.toml}` と hooks 本体（`implementations`、`lib`、`cli`、`types`、`run-guard.sh`、`hook-timer.sh`）、`~/.codex/{config.toml,AGENTS.md,rules}`、git 設定 3 点、`~/.config/mise/config.toml`、shell 設定（`.zshenv`、`.zsh/**`、`.bashrc`、`.bash_profile`、`.shell_common` の共通部分） |
| 必須の script | `install-packages-0-prepare`、`install-mise-tools`、`install-hook-deps`、`zz-verify-provisioning`、`update-settings-json`。mise 本体は `install-packages-1-linux` の中で `curl https://mise.run \| sh` によって入る |
| 不要（host 専用） | 音声・通知（`hooks/sounds`、`~/.claude/lib/unified-audio-*`、`speak-notification`）、distill-insights 一式（scripts、systemd unit、register script）、`gc`、`install-root-deps`（launchd の MCP 用）、`textlint` 一式、`refresh-go-latest-tools`、GUI 系設定（emacs、ghostty、karabiner、octorus）、診断ツール類（`dotfiles_doctor` など）、`hooks/tests/**` |
| 判断が要る | MCP サーバー（`update-claude-json`）、プラグイン（`install-claude-plugins`）、skills（`sync-skills`、`apm`、`private-skills` external）、`~/.claude/{agents,commands,templates}`、CLAUDE.md と rules、worktree 系の小道具、statusLine（ccstatusline）、safe-chain |
| 前提ツール | jq（`update-settings-json` など 5 か所と、command_history hook）。apt の一覧のうち VM で要るのは jq、ripgrep（推測: claude の検索用）、shellcheck（任意: quality-loop 用）。その他（emacs、dunst、sox、patchutils、libnotify-bin、pulseaudio-utils、age、wget、bat、fd-find）は不要。postfix はこのうちのどれかの推奨依存（どのパッケージかは未特定） |

### 推測（未検証）

- `ripgrep` は claude の Grep ツールが使う（claude は同梱の rg を持つ可能性もある）。
- `quality-loop` の `npx oxfmt` / `oxlint` / `shellcheck` は、失敗しても工程を飛ばすだけで止まらない。
- `permission-llm-evaluator` は agent SDK 経由で Anthropic API を呼ぶ。VM 内の claude の認証で動くかは未確認。

## 影響範囲

- `home/.chezmoiignore`（allowlist ブロックの追加）
- `home/.chezmoiscripts/run_onchange_install-packages-1-linux.sh.tmpl` と `home/.chezmoidata/packages.yaml`（VM 用の apt 一覧と非対話化）
- `agent-vm/cloud-init.yaml`、`agent-vm/bootstrap.sh`（前提パッケージ）
- `tests/agent-vm/run-templates.sh`（allowlist と host 不変のテスト）
- `docs/plans/agent-vm/spec.md` ではなく ADR-0018 と `docs/agent-vm.md`（spec は承認時の原本として固定されている）
