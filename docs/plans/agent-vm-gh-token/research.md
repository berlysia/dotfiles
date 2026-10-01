# Research: agent-vm で gh を repo 単位の fine-grained PAT で認証する

## 発端

- `2cabf6f` で VM に `gh` を入れた（`agent-vm/bootstrap.sh:10` の `VM_APT_PKGS`）。VM 内の `gh` には認証が無い。
- ユーザーは「案 B: repo ごとの fine-grained PAT を `GH_TOKEN` で渡す」を選び、PAT の作成・更新をスクリプト化したいと依頼した。

## 既存の秘密受け渡し（launcher）

- `home/dot_local/bin/executable_agent-vm:500-506` `env_files_for`: `~/.config/agent-vm/env.1password`（全 repo 共通）と `~/.config/agent-vm/repos/<machine>.env.1password`（repo 別）を対象にする。
- `:508-527` `inject_secrets`: host 側で `op inject -i <file>` を実行し、結果を stdin 経由で VM の tmpfs（`$XDG_RUNTIME_DIR` か `/dev/shm`）の `agent-vm.env.XXXXXX` に書く。秘密は argv に乗らない（`tests/agent-vm/run.sh` の `test_secret_values_never_appear_in_argv`）。
- `:529-539` `build_launch_script`: `set -a; . envf; set +a; rm -f envf` の後に tool を exec する。env ファイルの `GH_TOKEN=…` はそのまま tool（claude / codex / bash）の環境変数になり、そこから呼ばれた `gh` に届く。
- `:678-697` `main`: `shell) run_tool bash`。`agent-vm shell` も `run_tool` → `inject_secrets` を通るので、手で開いたシェルにも `GH_TOKEN` が入る。
- `:780-786` `cmd_env_edit`: repo 別 env ファイルを umask 077 で作成し、`$EDITOR` で開く。
- `docs/agent-vm.md:40-49`: env ファイルには `op://` 参照だけを書く。repo 内の `.env` は解決しない（VM から書き換えられる領域なので）。
- `docs/decisions/0018-agent-vm-orbstack.md:25-26,54`: K6（`op://` 参照ファイルを host で解決して tmpfs で渡す）、K7（Claude / Codex は machine ごとに初回ログインする。全 VM 共通の長期 token は注入しない。1 台の侵害で全 repo 分の資格情報が漏れるため）。
- launcher は macOS の `/bin/bash` 3.2 で動く（`docs/plans/agent-vm/plan-1.md:12`）。日付計算などで GNU 拡張は使えない。既に `perl` を使っている（`:83-85` `run_with_timeout`）。
- `x=$(f)` の中では errexit が効かないので、各ステップに `|| die` を付ける規約がある（`:5-8`）。

## GitHub 側の事実（github/docs の source を `gh api` で取得して確認）

- fine-grained PAT を作成・ローテーションする REST / GraphQL API は docs に無い。作成手順は Web UI だけが記載されている（`content/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens.md`）。
- template URL `https://github.com/settings/personal-access-tokens/new` は `name`（40 文字以下）、`description`（1024 文字以下）、`target_name`、`expires_in`（1-366 または `none`、省略時は 30）、`<permission>=read|write|admin` を受け付ける。**repo を選ぶパラメータは無い**。
- 権限パラメータの実名（同 docs の Repository permissions 表）: `contents`（read/write）、`pull_requests`（read/write）、`issues`（read/write）、`actions`（read/write）、`metadata`（read）、`statuses`（read/write）、`workflows`（write のみ）。
- community discussion #188111: `target_name` に org を指定すると画面上は org が選ばれて見えるが、実際は個人アカウントの token が作られるという報告がある。
- GitHub App の installation access token は 1 時間で失効する（`authenticating-as-a-github-app-installation.md:33`）。user access token は 8 時間、refresh token は 6 か月で失効する（`refreshing-user-access-tokens.md:22`）。
- `github-authentication-token-expiration` レスポンスヘッダは、上記 docs 3 ファイルを grep しても見つからなかった。文書化された挙動としては扱えない。

## 1Password CLI（WSL の `op` 2.31.1 の `--help` で確認）

- `op item create --vault <v> -` は stdin から item の JSON template を受け取る。秘密を argv に乗せずに item を作れる。
- `op item edit` は template を `--template <file>` でしか受け取らず、stdin からは受け取らない。秘密を書き換えるには一時ファイルが要る。
- 既存 env ファイルの書式は `NAME=op://vault/item/field`（テストの fixture は `A=op://v/a/x`）。

## テスト基盤

- `tests/agent-vm/run.sh`: launcher を `AGENT_VM_LIB=1` で source し、関数単位でテストする。`stubs/` の `op` / `orb` / `curl` などが argv を `$STUB_LOG` に記録し、`STUB_<NAME>_STDOUT` / `_EXIT` で応答し、`STUB_CAPTURE_STDIN=1` で stdin を記録する。
- `test_main_dispatches_commands`（run.sh:353-366）が `main` の振り分けを検査している。

## T0: mac 実機での確認結果（2026-10-01、ユーザーが実施）

| 項目 | 結果 |
| --- | --- |
| API Credential の秘密のフィールドの `id` | `credential` |
| 作成・`op read`・`op inject` | `Formal` と `Personal` の両方で通った |
| item の id | 26 文字の小文字英数字 |
| 失敗時の出力への値の漏れ | 0 件 |
| curl / jq | curl 8.7.1、jq は `/usr/bin/jq` |
| `github-authentication-token-expiration` ヘッダ | あり（docs には無いが、実際の応答には含まれる） |
| auto-merge（GraphQL の `enablePullRequestAutoMerge`） | 拒否された（`FORBIDDEN`）。spec K2 は変えない |
| 同じ名前の PAT | 拒否された（`The token name has already been taken.`） |

補足:

- 個人用の vault の名前は `Private` ではなく `Personal` だった（1Password はアカウントの種類によって名前が変わる）。spec と plan の vault 名を `Personal` / `Formal` に直した。
- `op` には my.1password.com と tskaigi.1password.com の 2 つのアカウントがサインインしている。`--account` を付けなければ my.1password.com が使われ、上の確認もその状態で行った。
- auto-merge の確認には blog.berlysia.net を使った（dotfiles には open な PR が無かった）。branch protection の無い repo では、`gh pr merge --auto` が予約ではなく即時の merge に進むおそれがあるため、GraphQL で試した。
- GitHub 上の検証用 PAT は削除済み（ユーザーの申告）。1Password の検証用 item は残っていないことを確認済み。
