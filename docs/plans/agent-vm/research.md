# Research: OrbStack で Claude / Codex を per-repo 仮想化して起動する

## オーダー

各リポジトリで Claude Code / Codex CLI を起動するとき OrbStack で仮想化して作業する。

- ホームにセットアップ済みの道具類への透過的参照（安全な範囲で読み込み限定）＋同期
- 1Password 等への参照

## 前提制約

- 本セッションは WSL2 (Linux) 上。OrbStack は macOS 専用で `orb` バイナリが無い。**OrbStack の挙動はここでは一切検証できない**。依存する挙動は下記「mac 実機検証項目」として plan のテスト計画で人間に渡す。
- 成果物は chezmoi source として darwin 側に deploy される。

## 事実（一次情報を自分で確認）

- F1: isolated machine の `--mount` は `SOURCE[:DEST]`（繰り返し可、config では `machine.<name>.mounts` にカンマ区切り）。**read-only 指定はドキュメントに存在しない**。 https://docs.orbstack.dev/machines/isolated
- F2: isolated machine は `/mnt/mac` なし・host への到達不可・`mac` コマンド不可・SSH agent 転送 off（`--forward-ssh-agent` で有効化）。`--isolate-network` で他 machine/host IP を遮断し internet は維持。 同上

## 報告ベース（subagent 調査、mac 未検証）

### OrbStack
- R1: 通常 machine は mac の home を同一パス・`/mnt/mac` で read-write 共有。制限フラグなし（all-or-nothing）。
- R2: 通常 machine は `mac <cmd>` で host の任意コマンドを実行可能 → guest コード = host コマンド実行権。選択的無効化は無く、isolated にするしかない。
- R3: default user は mac と同名・passwordless sudo。UID 一致は未記載。
- R4: cloud-init は `orb create -c/--user-data <file>` で対応。
- R5: 1Password SSH agent socket を container に bind した場合の不調報告あり（orbstack/orbstack#185）。machine 側 agent 転送との相性は未確認。
- R6: Docker container（OrbStack engine）は `-v host:ctr:ro` が使える（標準 Docker 挙動）。VirtioFS。

### 1Password
- R7: desktop app 連携（生体認証）は VM 境界を越えない。選択肢は (a) mac 側で `op run`/`op inject` して解決済み値のみ渡す、(b) Service Account token (`OP_SERVICE_ACCOUNT_TOKEN`)、(c) Connect server。

### Claude / Codex
- R8: Claude Code は Linux では `~/.claude/.credentials.json`（0600）に認証を保存。Codex は `~/.codex/auth.json`（`cli_auth_credentials_store` で切替）。
- R9: Codex の Linux sandbox は Landlock+seccomp。ネスト環境で効かない可能性。Claude Code の Linux sandbox は bubblewrap+socat。
- R10: Anthropic 公式 devcontainer は deny-by-default egress firewall (`init-firewall.sh`) を持つ。
- R11: 既存ツール: `defkode/orbx`（per-project isolated OrbStack VM を cloud-init で生成する Bash CLI、小規模）、dagger/container-use、trailofbits/claude-code-devcontainer、Apple `container`。

## リポジトリ現状（subagent 調査、主要点のみ抜粋して確認）

- C1: OrbStack/Lima/Docker/devcontainer 設定は皆無。greenfield。
- C2: OS 分岐は `.chezmoi.os` と `.chezmoi.kernel.osrelease | contains "microsoft"`（WSL）。パッケージは `home/.chezmoidata/packages.yaml` に OS 別、install は `run_onchange_install-packages-1-{darwin,linux}.sh.tmpl`。
- C3: `~/.claude/settings.json`・`~/.claude.json`・hook deps（bun install）・skills（rsync）・plugins はすべて **その machine の `$HOME` に対する `chezmoi apply` で生成**される。mise/bun のバイナリは OS/arch 固有。
  → 「deploy 済み home の透過参照」は成立しない。共有可能なのは **chezmoi source checkout**（と private-skills 等の非生成物）で、VM 内で `chezmoi apply` が要る。
- C4: `~/.claude.json` の MCP は darwin+shared_mode のとき launchd SSE、それ以外（Linux）は stdio/bunx に自動 fallback → VM では追加対応不要。
- C5: 1Password: `ope()`（`home/dot_shell_common/functions.sh`）が `.env`/`~/.env.1password` を `op inject` / `op run --env-file` で解決。`-i` で claude を PTY 起動するモードあり。`claude-zai` は `op read`。
- C6: SSH agent は darwin のみ 1Password socket を `SSH_AUTH_SOCK` に設定（`home/dot_shell_common/darwin.sh`）。
- C7: git 署名 `home/dot_gitconfig_gpg_ssh.tmpl` は darwin / WSL 分岐のみ。**非 WSL Linux は分岐なし → VM で署名が失敗する**。`home/dot_gitconfig.tmpl` の `allowedSignersFile` が `/home/berlysia/...` にハードコード。
- C8: Codex config は hostname overlay（`home/dot_codex/.config.<hostname>.toml` を `private_dot_merge-config.ts` で deep merge）に対応 → VM 用 profile の自然な拡張点。既に `sandbox_mode='workspace-write'`。
- C9: `run_after_distill-insights.sh` は `~/.claude/projects/**/*.jsonl` を読む → VM 内のセッションログは host 側 digest に載らない（戻り経路が無ければ）。
- C10: claude 本体の install は chezmoi 管理外、codex は mise (`npm:@openai/codex`)。

## 設計上の含意

- 「読み込み限定」は flag ではなく設計性質として実現する必要がある（F1）。候補: host 側で curated staging copy に rsync し、それだけを mount → VM が書き換えても再生成可能なコピーが壊れるだけ。
- isolated machine 以外（通常 machine）は R1/R2 により home 全体 rw + host コマンド実行となり、「安全な範囲」を満たさない。

## ユーザー回答（Round 1）

- 境界: repo ごとの isolated machine
- 同期: 双方向（VM → host のセッションログ回収を含む）
- git: `--forward-ssh-agent` で 1Password SSH agent を転送し、push と署名を行う
- 1Password: 「署名を考えると host 側の op 注入で足りるか」と質問あり → 署名は agent 転送が担うので op 注入とは経路が別、と回答。確認待ち

## mac 実機検証項目（V）

- V1: isolated machine で mount 先に書き込みが host に反映されるか（staging 方式の必要性確認）
- V2: VM 内 user の UID と mount 上のファイル所有権
- V3: `--forward-ssh-agent` + 1Password agent で `ssh -T git@github.com` と `git commit -S` が通るか
- V4: cloud-init `--user-data` で mise / chezmoi / claude / codex が provision できるか
- V5: `--isolate-network` 下で claude / codex の API 疎通
