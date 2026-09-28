<!-- spec-ref: spec.md -->

# Plan 3: VM 側のプロビジョニング（cloud-init・bootstrap・chezmoi 分岐）

spec の K3（bootstrap 契約）・K4（`agent_vm` フラグ）・K5（VM の mise 軽量化）・K9（outbox への symlink は bootstrap が所有）・K10（exclude 設定の書式）・K11（cloud-init と bootstrap は repo root の `agent-vm/`）・K12（OrbStack cask）・K16（claude は未導入時だけ bootstrap が公式 installer で入れる）と、K6 の「秘密の置き場が tmpfs であることを bootstrap が確認する」を実装する。launcher 側の呼び出し契約は plan-1 で固定済み: `orb -m <m> bash /opt/agent-vm/src/<gen>/agent-vm/bootstrap.sh <contract> <hash> <src dir>`（`BOOTSTRAP_CONTRACT=1`）。

共通制約:
- bootstrap.sh は VM（Ubuntu）の bash で動くが、テストは Linux CI 上で HOME を一時ディレクトリにして実行する。VM 固有のパスは環境変数で上書きできる: `AGENT_VM_MARKER`（既定 `/etc/agent-vm`）、`AGENT_VM_OUTBOX_ROOT`（既定 `/opt/agent-vm/outbox`）、`AGENT_VM_SECRETS_DIR`（既定 `${XDG_RUNTIME_DIR:-/dev/shm}`）。本番コードにテスト専用の分岐は置かない。
- テストの合否は `N run, 0 failed` の「0 failed」で判定する（`N` は assert の数で、タスクを足すたびに増える）。
- bootstrap 実行中も VM は転送された SSH agent を使えるが、これはセッション全体を通じた既存の露出（spec K1・K8・R3）の一部で、本 plan で新たに増えるものではない。
- VM の git は host の gitconfig（`home/dot_gitconfig.tmpl:65-68` の `url "git@github.com:" insteadOf https://github.com/`）を引き継ぐので、GitHub への clone は SSH になる。非対話の bootstrap で host key の確認が止まらないよう、cloud-init が GitHub の公開 host key を `/etc/ssh/ssh_known_hosts` に固定で書く（初回接続時に鍵を信用する方式は採らない）。

## Files

```
# 新規作成
agent-vm/cloud-init.yaml
agent-vm/bootstrap.sh
tests/agent-vm/run-bootstrap.sh
tests/agent-vm/run-templates.sh
tests/agent-vm/stubs/curl
home/dot_config/agent-vm/create_config

# 編集
home/.chezmoi.toml.tmpl
home/dot_config/mise/config.toml.tmpl
home/dot_config/mise/config.toml
home/.chezmoiscripts/run_onchange_install-packages-7.sh.tmpl
home/.chezmoiscripts/run_onchange_install-safe-chain.sh.tmpl
home/.chezmoidata/packages.yaml
.github/workflows/ci-agent-vm.yml
```

（`home/dot_config/mise/config.toml` は `git mv` で `config.toml.tmpl` に改名するため、両方を列挙している。）

## Tasks

### T1: bootstrap.sh の契約と前提確認（K3・K6）

**Files:**

- 新規: `agent-vm/bootstrap.sh`, `tests/agent-vm/run-bootstrap.sh`
- 参照: `home/dot_local/bin/executable_agent-vm` の `maybe_bootstrap`（呼び出し契約 `<contract> <hash> <src>`、`BOOTSTRAP_CONTRACT=1`、applied-hash を `$HOME/.local/state/agent-vm/applied-hash` から読む）
- 参照: `tests/agent-vm/lib.sh`（assert 群と結果ファイル方式をそのまま使う）

- [ ] **Step 1: 失敗するテスト**

`tests/agent-vm/run-bootstrap.sh`（Linux 専用。`run.sh` と同じく各テストを subshell で走らせる）:

```bash
#!/usr/bin/env bash
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
BOOTSTRAP="$REPO_ROOT/agent-vm/bootstrap.sh"
TMP_BASE=$(mktemp -d -t agent-vm-bootstrap-XXXXXX)
trap 'rm -rf "$TMP_BASE"' EXIT
export PATH="$TEST_DIR/stubs:$PATH" RESULTS_FILE="$TMP_BASE/results"
: >"$RESULTS_FILE"
# shellcheck source=tests/agent-vm/lib.sh
. "$TEST_DIR/lib.sh"

setup_vm_env() { # fake VM layout under TMP_ROOT; secrets dir on tmpfs (/dev/shm on Linux CI)
  export HOME="$TMP_ROOT/home" AGENT_VM_MARKER="$TMP_ROOT/etc-agent-vm"
  export AGENT_VM_OUTBOX_ROOT="$TMP_ROOT/outbox" AGENT_VM_SECRETS_DIR=/dev/shm
  mkdir -p "$HOME" "$AGENT_VM_OUTBOX_ROOT"; printf '1\n' >"$AGENT_VM_MARKER"
  SRC="$TMP_ROOT/src"; mkdir -p "$SRC/home" "$SRC/node_modules/x"
  printf 'home\n' >"$SRC/.chezmoiroot"; printf 'a\n' >"$SRC/home/dot_a"; printf 'junk\n' >"$SRC/node_modules/x/f"
  mkdir -p "$TMP_ROOT/bin"; printf '#!/bin/sh\nexit 0\n' >"$TMP_ROOT/bin/claude"; chmod +x "$TMP_ROOT/bin/claude"
  export PATH="$TMP_ROOT/bin:$PATH"
}

test_unknown_contract_exits_3_with_guidance() {
  setup_vm_env
  local status=0 err; err=$(bash "$BOOTSTRAP" 2 v1:h "$SRC" 2>&1) || status=$?
  assert_eq 3 "$status" "contract mismatch exits 3"
  assert_contains "$err" "chezmoi apply" "tells the user to update the launcher on the host"
}
test_refuses_outside_an_agent_vm_machine() {
  setup_vm_env; rm "$AGENT_VM_MARKER"
  assert_status 1 "no marker -> refuse" -- bash "$BOOTSTRAP" 1 v1:h "$SRC"
}
test_refuses_when_secrets_dir_is_not_tmpfs() {
  setup_vm_env; export AGENT_VM_SECRETS_DIR="$TMP_ROOT/disk"; mkdir -p "$AGENT_VM_SECRETS_DIR"
  # The fixture must itself be on a non-tmpfs filesystem; on systems with a tmpfs /tmp this cannot be tested.
  if [[ "$(stat -f -c %T "$AGENT_VM_SECRETS_DIR")" == tmpfs ]]; then record "PASS non-tmpfs refusal (skipped: fixture is on tmpfs)"; return 0; fi
  assert_status 1 "non-tmpfs secrets dir -> refuse" -- bash "$BOOTSTRAP" 1 v1:h "$SRC"
}

for t in $(declare -F | awk '{print $3}' | grep '^test_'); do
  (
    TMP_ROOT="$TMP_BASE/$t"; mkdir -p "$TMP_ROOT"
    export TMP_ROOT STUB_LOG="$TMP_ROOT/stub.log"; : >"$STUB_LOG"
    "$t"
  ) </dev/null || record "FAIL $t (test aborted)"
done
failed=$(grep -c '^FAIL' "$RESULTS_FILE" || true)
grep '^FAIL' "$RESULTS_FILE" || true
printf '%d run, %d failed\n' "$(wc -l <"$RESULTS_FILE" | tr -d ' ')" "$failed"
[[ "$failed" -eq 0 ]]
```

- [ ] **Step 2: 失敗を確認** — 実行: `bash tests/agent-vm/run-bootstrap.sh` / 期待: bootstrap.sh が無いので 3 件 FAIL。

- [ ] **Step 3: 最小実装**

```bash
#!/usr/bin/env bash
# agent-vm bootstrap: runs inside the per-repo OrbStack machine, from the staging generation.
# Contract with the host launcher (home/dot_local/bin/executable_agent-vm, maybe_bootstrap):
#   bootstrap.sh <contract version> <staging hash> <staging generation dir>
set -euo pipefail

readonly SUPPORTED_CONTRACT=1
MARKER="${AGENT_VM_MARKER:-/etc/agent-vm}"
OUTBOX_ROOT="${AGENT_VM_OUTBOX_ROOT:-/opt/agent-vm/outbox}"
SECRETS_DIR="${AGENT_VM_SECRETS_DIR:-${XDG_RUNTIME_DIR:-/dev/shm}}"

fail() { printf 'agent-vm bootstrap: %s\n' "$1" >&2; exit "${2:-1}"; }

contract=${1:-}
hash=${2:-}
src=${3:-}
if [[ "$contract" != "$SUPPORTED_CONTRACT" ]]; then
  fail "launcher and bootstrap contract versions differ (got '$contract', need '$SUPPORTED_CONTRACT'); run chezmoi apply on the host to update the launcher" 3
fi
[[ -n "$hash" && -d "$src" ]] || fail "usage: bootstrap.sh <contract> <hash> <src dir>"
[[ -f "$MARKER" ]] || fail "not an agent-vm machine ($MARKER missing)"
# Secrets are handed over as files here (spec K6); they must never land on a persistent disk.
[[ "$(stat -f -c %T "$SECRETS_DIR" 2>/dev/null)" == tmpfs ]] || fail "$SECRETS_DIR is not tmpfs; refusing to continue"
```

`chmod +x agent-vm/bootstrap.sh tests/agent-vm/run-bootstrap.sh`。

- [ ] **Step 4: 通過を確認** — 期待: `0 failed`。
- [ ] **Step 5: コミット** — `feat(agent-vm): add VM bootstrap entry with contract and environment checks`

### T2: dotfiles の同期・apply・outbox symlink・applied-hash（K2・K3・K9）

**Files:**

- 編集: `agent-vm/bootstrap.sh`、テスト: `tests/agent-vm/run-bootstrap.sh`、stub: `tests/agent-vm/stubs/chezmoi`（既存。引数を `$STUB_LOG` に記録）
- 参照: spec K2（`rsync -a --delete --exclude node_modules --exclude .git` で VM ローカルの `~/.local/share/chezmoi` へ同期し `chezmoi init -W … --apply`）
- 参照: spec K9（`~/.claude/projects` と `~/.codex/sessions` を outbox への symlink にする。bootstrap が所有）

- [ ] **Step 1: 失敗するテスト**（`run-bootstrap.sh` に追加）

```bash
test_syncs_source_applies_and_records_hash() {
  setup_vm_env
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  local cz="$HOME/.local/share/chezmoi"
  assert_eq "a" "$(cat "$cz/home/dot_a")" "source synced"
  assert_status 1 "node_modules not synced" -- test -e "$cz/node_modules"
  assert_contains "$(cat "$STUB_LOG")" "chezmoi init --force --no-tty -W $cz --apply" "chezmoi applied non-interactively"
  assert_eq "v1:abc" "$(cat "$HOME/.local/state/agent-vm/applied-hash")" "applied hash recorded"
}
test_resync_deletes_stale_files_but_keeps_git_dir() {
  setup_vm_env
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  local cz="$HOME/.local/share/chezmoi"
  mkdir -p "$cz/.git"; printf 'ref\n' >"$cz/.git/HEAD"; printf 'old\n' >"$cz/home/dot_stale"
  bash "$BOOTSTRAP" 1 v1:def "$SRC" >/dev/null 2>&1
  assert_status 1 "stale file removed" -- test -e "$cz/home/dot_stale"
  assert_eq "ref" "$(cat "$cz/.git/HEAD")" ".git created by chezmoi init survives"
}
test_outbox_links_move_existing_logs() {
  setup_vm_env
  mkdir -p "$HOME/.claude/projects/-r"; printf 'x\n' >"$HOME/.claude/projects/-r/s.jsonl"
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  assert_eq "$AGENT_VM_OUTBOX_ROOT/claude-projects" "$(readlink "$HOME/.claude/projects")" "claude projects linked to outbox"
  assert_eq "$AGENT_VM_OUTBOX_ROOT/codex-sessions" "$(readlink "$HOME/.codex/sessions")" "codex sessions linked to outbox"
  assert_eq "x" "$(cat "$AGENT_VM_OUTBOX_ROOT/claude-projects/-r/s.jsonl")" "existing log moved into the outbox"
}
test_failed_apply_does_not_record_hash() {
  setup_vm_env
  local status=0
  STUB_CHEZMOI_EXIT=1 bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1 || status=$?
  assert_eq 1 "$status" "apply failure propagates"
  assert_status 1 "no applied hash on failure" -- test -e "$HOME/.local/state/agent-vm/applied-hash"
}
test_installs_claude_only_when_missing() {
  setup_vm_env
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  assert_not_contains "$(cat "$STUB_LOG")" "claude.ai/install.sh" "no install when claude exists"
  rm "$TMP_ROOT/bin/claude"
  bash "$BOOTSTRAP" 1 v1:def "$SRC" >/dev/null 2>&1
  assert_contains "$(cat "$STUB_LOG")" "curl -fsSL https://claude.ai/install.sh" "installer fetched when claude is missing"
  assert_contains "$(cat "$STUB_LOG")" "installer-ran" "installer script executed"
}
test_finds_claude_in_local_bin_without_profile() {
  setup_vm_env
  rm "$TMP_ROOT/bin/claude"
  mkdir -p "$HOME/.local/bin"; printf '#!/bin/sh\nexit 0\n' >"$HOME/.local/bin/claude"; chmod +x "$HOME/.local/bin/claude"
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  assert_not_contains "$(cat "$STUB_LOG")" "claude.ai/install.sh" "claude under ~/.local/bin found without a login shell"
}
test_planted_local_bin_does_not_shadow_system_commands() {
  setup_vm_env
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\necho planted-rsync >>"$STUB_LOG"\nexit 0\n' >"$HOME/.local/bin/rsync"; chmod +x "$HOME/.local/bin/rsync"
  printf '#!/bin/sh\necho planted-curl >>"$STUB_LOG"\nexit 0\n' >"$HOME/.local/bin/curl"; chmod +x "$HOME/.local/bin/curl"
  rm "$TMP_ROOT/bin/claude" # force the installer path so curl is actually invoked
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  assert_not_contains "$(cat "$STUB_LOG")" "planted-rsync" "system rsync used, not the planted one"
  assert_not_contains "$(cat "$STUB_LOG")" "planted-curl" "curl earlier on PATH used, not the planted one"
  assert_eq "a" "$(cat "$HOME/.local/share/chezmoi/home/dot_a")" "real rsync synced the source"
}
test_failed_claude_install_does_not_record_hash() {
  setup_vm_env
  rm "$TMP_ROOT/bin/claude"
  local status=0
  STUB_CURL_EXIT=22 bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1 || status=$?
  if [[ "$status" -ne 0 ]]; then record "PASS install failure aborts bootstrap"; else record "FAIL install failure aborts bootstrap"; fi
  assert_status 1 "no applied hash after a failed install" -- test -e "$HOME/.local/state/agent-vm/applied-hash"
}
```

`tests/agent-vm/stubs/curl`（引数を記録し、`STUB_CURL_EXIT` が非 0 ならその値で終わる。成功時は、実行されたことを記録する 1 行のスクリプトを出力する）:

```bash
#!/usr/bin/env bash
# Test stub: records argv; prints a tiny installer script that logs its own execution.
{ printf 'curl'; printf ' %q' "$@"; printf '\n'; } >>"$STUB_LOG"
if [[ "${STUB_CURL_EXIT:-0}" -ne 0 ]]; then exit "$STUB_CURL_EXIT"; fi
printf 'echo installer-ran >>%q\n' "$STUB_LOG"
```

- [ ] **Step 2: 失敗を確認** — 期待: 追加した 8 件のテストがすべて FAIL を含む。

- [ ] **Step 3: 最小実装**（T1 の末尾に追記）

```bash
# This shell is non-interactive and reads no profile: add the installers' target dirs so the claude check
# below and later chezmoi scripts (mise, and what mise installs) see what earlier runs installed.
# Appended, not prepended: files a session planted in ~/.local/bin cannot shadow system commands
# (curl, bash, rsync, git, chezmoi) that bootstrap itself runs. User-only tools (mise, claude) can still be
# replaced from inside the VM, exactly as for the next interactive session; that stays within the VM boundary.
export PATH="$PATH:$HOME/.local/bin:$HOME/.local/share/mise/shims"

# Claude Code is not managed by chezmoi on any host; the VM installs it the same way as the host (spec K16).
# Under pipefail a failed download aborts here, before applied-hash is written, so the next launch retries.
if ! command -v claude >/dev/null 2>&1; then
  curl -fsSL https://claude.ai/install.sh | bash
fi

link_outbox() { # outbox subdir, target path (bootstrap owns these VM-only symlinks; chezmoi does not manage them)
  local out="$OUTBOX_ROOT/$1" target=$2
  mkdir -p "$out" "$(dirname "$target")"
  if [[ -d "$target" && ! -L "$target" ]]; then
    cp -a "$target/." "$out/"
    rm -rf "$target"
  fi
  ln -sfn "$out" "$target"
}
link_outbox claude-projects "$HOME/.claude/projects"
link_outbox codex-sessions "$HOME/.codex/sessions"

cz="$HOME/.local/share/chezmoi"
mkdir -p "$cz"
# .git is excluded so the empty repository chezmoi init creates in a .git-less source survives resyncs.
rsync -a --delete --exclude node_modules --exclude .git "$src/" "$cz/"
chezmoi init --force --no-tty -W "$cz" --apply

mkdir -p "$HOME/.local/state/agent-vm"
printf '%s\n' "$hash" >"$HOME/.local/state/agent-vm/applied-hash"
```

- [ ] **Step 4: 通過を確認** — 期待: `0 failed`。
- [ ] **Step 5: コミット** — `feat(agent-vm): sync dotfiles into the VM, apply them and link session logs to the outbox`

### T3: chezmoi の `agent_vm` フラグと mise の軽量化（K4・K5）

**Files:**

- 編集: `home/.chezmoi.toml.tmpl:8-9`、`home/dot_config/mise/config.toml` → `config.toml.tmpl`（`git mv`）、`home/.chezmoiscripts/run_onchange_install-packages-7.sh.tmpl:5`（include するパスの更新）
- 新規: `tests/agent-vm/run-templates.sh`
- 参照: `home/.chezmoiignore:24`（`dig "only_private" false .` のガード付き参照の前例）
- 参照: `home/.chezmoiscripts/run_onchange_install-packages-7.sh.tmpl:5`（`include "dot_config/mise/config.toml" | sha256sum` で変更検知している）

- [ ] **Step 1: 失敗するテスト**

`tests/agent-vm/run-templates.sh`（chezmoi が必要。CI は既存の `./.github/actions/install-chezmoi` で入れる）:

```bash
#!/usr/bin/env bash
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
SRC="$REPO_ROOT/home"
TMP_BASE=$(mktemp -d -t agent-vm-templates-XXXXXX)
trap 'rm -rf "$TMP_BASE"' EXIT
export RESULTS_FILE="$TMP_BASE/results"; : >"$RESULTS_FILE"
# shellcheck source=tests/agent-vm/lib.sh
. "$TEST_DIR/lib.sh"

render() { # template_relpath override_data_json
  chezmoi execute-template --source "$SRC" --override-data "$2" <"$SRC/$1"
}

test_config_template_derives_agent_vm_false_on_ordinary_hosts() {
  assert_contains "$(chezmoi execute-template --source "$SRC" --init <"$SRC/.chezmoi.toml.tmpl")" "agent_vm = false" "not a VM here"
}
test_mise_full_set_outside_vm() {
  local out; out=$(render dot_config/mise/config.toml.tmpl '{"agent_vm":false}')
  assert_contains "$out" 'rust = ' "rust kept on hosts"
  assert_contains "$out" '"cargo:similarity-ts"' "cargo tools kept on hosts"
  assert_contains "$out" 'node = ' "node kept on hosts"
}
test_mise_light_set_in_vm() {
  local out; out=$(render dot_config/mise/config.toml.tmpl '{"agent_vm":true}')
  assert_not_contains "$out" 'rust = ' "rust dropped in the VM"
  assert_not_contains "$out" 'go = ' "go dropped in the VM"
  assert_not_contains "$out" '"cargo:' "cargo backend tools dropped in the VM"
  assert_not_contains "$out" '"go:' "go backend tools dropped in the VM"
  assert_contains "$out" 'node = ' "node kept in the VM"
  assert_contains "$out" '"npm:@openai/codex"' "codex kept in the VM"
}
test_mise_template_works_without_agent_vm_key() {
  local out; out=$(render dot_config/mise/config.toml.tmpl '{}')
  assert_contains "$out" 'rust = ' "missing key behaves like a host (dig default false)"
}
hash_line() { render "$1" "$2" | grep 'mise config hash:'; }
test_install_scripts_hash_the_rendered_template() {
  local s
  for s in .chezmoiscripts/run_onchange_install-packages-7.sh.tmpl .chezmoiscripts/run_onchange_install-safe-chain.sh.tmpl; do
    if [[ "$(hash_line "$s" '{"agent_vm":true}')" != "$(hash_line "$s" '{"agent_vm":false}')" ]]; then
      record "PASS $s re-runs when the rendered mise config differs"
    else
      record "FAIL $s re-runs when the rendered mise config differs"
    fi
  done
}
test_host_render_equals_template_without_vm_guards() {
  # The VM-only guards must be the template's only markup: removing their lines has to give exactly the
  # host render. This needs no git history (CI checkouts are shallow) and keeps holding as the list evolves.
  local stripped
  stripped=$(grep -v -E '^\{\{-? (if not \(dig "agent_vm" false \.\)|end) -?\}\}$' "$SRC/dot_config/mise/config.toml.tmpl")
  assert_eq "$stripped" "$(render dot_config/mise/config.toml.tmpl '{"agent_vm":false}')" "hosts see no change"
}

for t in $(declare -F | awk '{print $3}' | grep '^test_'); do
  ( "$t" ) </dev/null || record "FAIL $t (test aborted)"
done
failed=$(grep -c '^FAIL' "$RESULTS_FILE" || true)
grep '^FAIL' "$RESULTS_FILE" || true
printf '%d run, %d failed\n' "$(wc -l <"$RESULTS_FILE" | tr -d ' ')" "$failed"
[[ "$failed" -eq 0 ]]
```

- [ ] **Step 2: 失敗を確認** — 期待: config.toml.tmpl が無く `agent_vm` キーも無いので、6 件のテストがすべて FAIL を含む（install script のテストは、変更前の `include` が render 前の同じ内容を hash するため true/false で同じ値になり FAIL する）。

- [ ] **Step 3: 最小実装**

`home/.chezmoi.toml.tmpl` の `[data]` に 1 行追加:

```
agent_vm = {{ stat "/etc/agent-vm" | not | not }}
```

`git mv home/dot_config/mise/config.toml home/dot_config/mise/config.toml.tmpl` のうえで、VM で除外する 6 行（`go`、`rust`、`"cargo:similarity-ts"`、`"cargo:zizmor"`、`"go:github.com/syou6162/git-sequential-stage"`、`"cargo:octorus"`）を、**それぞれ今ある位置のまま** 1 行ずつ囲む。行は移動しない（host の render 結果を変更前と 1 バイトも変えないため。変わると全 host で hash が変わり mise install と safe-chain が 1 回ずつ再実行される）。1 行の囲み方:

```
gitleaks = "8.30.1"
{{- if not (dig "agent_vm" false .) }}
go = "1.26.3"
{{- end }}
node = "24.15.0"
```

`{{-` は直前の改行を削るので、false 側（host）の出力は元の 3 行と同一、true 側（VM）は `go` の行だけが消える。

`home/.chezmoiscripts/run_onchange_install-packages-7.sh.tmpl:5` と `home/.chezmoiscripts/run_onchange_install-safe-chain.sh.tmpl:5` の 2 箇所を、次の形に置き換える（render 後の内容で hash を取るので VM と host で別の値になり、それぞれの変更で再実行される。host では render 結果が変更前と同じなので hash も変わらない）:

```
# mise config hash: {{ includeTemplate "dot_config/mise/config.toml.tmpl" . | sha256sum }}
```

実装後に `git grep -n 'include "dot_config/mise/config.toml"' home/` の結果が 0 件であることを確かめる（テンプレートとして評価される参照はこの 2 箇所だけ。`.github/actions/setup-node-bun/action.yml` のコメントと `home/dot_claude/hooks/` の docstring・テストの例示パスは評価されないので触らない）。

- [ ] **Step 4: 通過を確認** — 実行: `bash tests/agent-vm/run-templates.sh` / 期待: `0 failed`（`test_host_render_equals_template_without_vm_guards` が host で差分が出ないことを検証する）。
- [ ] **Step 5: コミット** — `feat(agent-vm): add the agent_vm data flag and a lighter mise tool set inside VMs`

### T4: cloud-init・OrbStack cask・host 側設定の雛形・CI（K11・K12・K10）

**Files:**

- 新規: `agent-vm/cloud-init.yaml`、`home/dot_config/agent-vm/create_config`
- 編集: `home/.chezmoidata/packages.yaml:37` 付近（`darwin.casks`）、`.github/workflows/ci-agent-vm.yml`
- 参照: https://docs.orbstack.dev/machines/cloud-init（`-c/--user-data` に cloud-config を渡せる、research R4）
- 参照: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints（GitHub の公開 host key）
- 参照: spec K10（exclude の書式: 1 行 1 絶対パス、`#` 以降はコメント）

- [ ] **Step 1: 失敗するテスト** — 検証コマンド:
  - `python3 -c 'import yaml,sys; d=yaml.safe_load(open("agent-vm/cloud-init.yaml")); assert d["write_files"][0]["path"]=="/etc/agent-vm"'` が通ること（変更前はファイルが無く失敗）。
  - `grep -c '"orbstack"' home/.chezmoidata/packages.yaml` が 1。
  - `chezmoi execute-template < home/.chezmoiignore`（Linux）の出力に `dot_config/agent-vm` が含まれ、`create_config` が非 darwin に deploy されないこと（plan-1 T11 の gating がそのまま効く）。

- [ ] **Step 2: 最小実装**

`agent-vm/cloud-init.yaml`:

```yaml
#cloud-config
# First-boot provisioning for agent-vm machines (see agent-vm/bootstrap.sh for the per-launch part).
package_update: true
packages:
  - git
  - curl
  - rsync
  - ca-certificates
  - build-essential
  - unzip
  - zsh
write_files:
  - path: /etc/agent-vm
    content: "1\n"
    permissions: "0644"
  # Pinned GitHub host keys so non-interactive SSH clones (private-skills, insteadOf rewrites) do not stop on a prompt.
  - path: /etc/ssh/ssh_known_hosts
    append: true
    content: |
      github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
runcmd:
  - [sh, -c, "curl -fsLS https://get.chezmoi.io | sh -s -- -b /usr/local/bin"]
```

GitHub の host key は実装時に上記の公式ページの値と照合し、違えば公式ページの値を使う（spec V17 として mac 実機検証にも入る）。

`home/dot_config/agent-vm/create_config`（`create_` なので、既にある host の設定は上書きしない）。launcher は設定ファイルが無くても動くが、K10 の書式（1 行 1 絶対パス・配下も対象・`#` はコメント）を置き場所ごと見つけられるようにするため、コメントだけの雛形を置く:

```
# agent-vm: repositories listed here run claude/codex on the host instead of in a VM.
# One absolute path per line; a path also covers everything below it. '#' starts a comment.
# Example:
# /Users/you/src/trusted-repo
```

`home/.chezmoidata/packages.yaml` の `darwin.casks` に `- "orbstack"` を追加する。

`.github/workflows/ci-agent-vm.yml` の `push` と `pull_request` の **両方の** paths に `agent-vm/**`・`home/.chezmoi.toml.tmpl`・`home/dot_config/mise/**`・`home/.chezmoiscripts/run_onchange_install-packages-7.sh.tmpl`・`home/.chezmoiscripts/run_onchange_install-safe-chain.sh.tmpl` を追加し、job を次の形にする（bootstrap と template のテストは Linux の ubuntu job だけで走らせる）:

```yaml
    steps:
      - name: Checkout repository
        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with:
          persist-credentials: false
      # /bin/bash is 3.2 on macOS: the launcher must run on the stock shell.
      - name: Run launcher tests
        run: /bin/bash tests/agent-vm/run.sh
      - name: Run VM bootstrap tests
        if: runner.os == 'Linux'
        run: bash tests/agent-vm/run-bootstrap.sh
      - name: Install chezmoi
        if: runner.os == 'Linux'
        uses: ./.github/actions/install-chezmoi
        with:
          install-dir: "$HOME/.local/bin"
          add-to-path: "true"
      - name: Run template tests
        if: runner.os == 'Linux'
        run: bash tests/agent-vm/run-templates.sh
```

- [ ] **Step 3: 通過を確認** — Step 1 の 3 つが期待どおり。`npm run lint:actions` と `npm run lint:shell` が警告 0。`bash tests/agent-vm/run.sh`・`run-bootstrap.sh`・`run-templates.sh` がすべて `0 failed`。
- [ ] **Step 4: コミット** — `feat(agent-vm): add cloud-init, OrbStack cask, host config stub and CI for VM provisioning`

## ISO 25010 具体テストケース

### セキュリティ（機密性）

- **入力**: 秘密の受け渡し先を通常のディスク上のディレクトリにして bootstrap → **期待**: 終了コード 1 で何もしない（T1）
- **入力**: `/etc/agent-vm` が無い環境で bootstrap → **期待**: 終了コード 1（T1）

### 機能適合性（機能正確性）

- **入力**: contract `2` → **期待**: 終了コード 3、stderr に `chezmoi apply`（T1）
- **入力**: staging に `node_modules/` を含む → **期待**: VM の chezmoi source に `node_modules` が無い（T2）
- **入力**: 2 回目の bootstrap で source から消えたファイル、既存の `.git/HEAD` → **期待**: 前者は削除、後者は残る（T2）
- **入力**: `~/.claude/projects/-r/s.jsonl` が既にある状態で bootstrap → **期待**: `~/.claude/projects` は outbox への symlink になり、中身は outbox に移っている（T2）
- **入力**: `chezmoi` が失敗 → **期待**: 終了コード 1、applied-hash は書かれない（T2）
- **入力**: `agent_vm=true` で mise 設定を render → **期待**: `rust`・`go`・`cargo:`・`go:` の行が無く、`node` と `npm:@openai/codex` はある（T3）

### 移植性（設置性）

- **入力**: `agent_vm` キーの無い data で mise 設定を render → **期待**: host と同じ全セット（T3）
- **入力**: この host（WSL）で `chezmoi diff` → **期待**: `~/.config/mise/config.toml` に差分なし（T3）

対象外: 性能効率（初回 provisioning 時間は spec V4 を mac 実機で計測）。cloud-init の実適用・SSH agent 経由の clone（V13）・claude の実導入（V16）・GitHub host key（V17）は OrbStack 実機が要るため mac 実機検証に渡す。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘: go/rust の移動で host の render 結果が変わり「差分なし」の判定と矛盾。install script のテストが変更前から通る（Red にならない）。「N run」は assert 数で数えるので件数が誤り。curl を stub していないため claude 導入のテストが失敗し得ない。tmpfs の `/tmp` がある環境では非 tmpfs テストが誤作動。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘: VM への claude 導入方法が spec に無いまま plan が curl|bash を追加している（→ spec K16 として決定）。cloud-init が mise を入れない点が spec の記述とずれる（→ spec を訂正）。create_config の根拠が無い。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: `run_onchange_install-safe-chain.sh.tmpl` も `config.toml` を include しており改名で壊れる。go/rust は移動せずその場で囲むべき。CI の paths は push と pull_request の両方に足す必要がある。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: 新規の脆弱性なし。bootstrap 中の agent 転送は K1/K8 で受け入れ済みの常時露出の一部。curl|sh の追加は既存の mise 導入と同じ信頼モデル。

### data-contract-evolution-evaluator
- verdict: blocker
- 主指摘: safe-chain の include が改名で壊れ、全 host と VM で apply が失敗し applied-hash が書かれず bootstrap が毎回走る。go/rust の移動で全 host の render hash が変わり mise install と safe-chain が再実行される。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: needs-work
- 主指摘: 行ごとの囲み方は chezmoi v2.72.2 で実測し、host 側は byte 単位で同一・VM 側は対象行だけ消えることを確認。ただし host 側の同一性テストが `git show master:…` を使い、CI の浅い checkout に `master` が無く失敗する（→ テンプレートから VM 用の囲み行を除いたものと host の render 結果を比べる方式に変更、git 履歴に依存しない）。

### scope-justification-reviewer
- verdict: pass
- 主指摘: Round 1 は解消（K16・cloud-init の訂正・create_config の根拠）。cloud-init のパッケージ一覧に個別の理由が無いのは軽微。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: 3 件とも解消。CI の paths 差分がコード例でなく文章のみなのは軽微。

### security-vulnerability-analyzer
- verdict: needs-work（1 件、不採用）
- 主指摘: bootstrap が `~/.local/bin` を PATH の先頭に置くため、侵害されたセッションが偽のコマンドを置けば次の bootstrap で実行される。→ 不採用: bootstrap は agent のセッションと同じ VM・同じユーザーで動き、偽のコマンドが得られるのは VM が既に持つ権限だけ。host 側の処理は VM の PATH を使わない。VM は信頼しない側という前提の範囲内。

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: `include` と `includeTemplate`（agent_vm=false）の出力と hash が一致することを実測。host では run_onchange が再実行されない。Round 1 の blocker は解消。

<!-- auto-review: verdict=blocker; hash=5c9fba720ac7bd2d9d14a27665de39440d58a04ddb5b99678aa2738382c18fde; design-hash=0c6bf3d01a210c4ef3d554af4afdf060b9ae7e84fd332f35832096cf6ecda043; round=1; parent-spec-hash=840d2b7827747b0c6eebdcf4d637b18a8ddf3bcc66d1e6369653dff236e907d0; at=2026-09-28T16:17:35.956Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=13; excluded=0; at=2026-09-28T16:17:35.975Z -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: pass
- 主指摘: 囲み行を除いたテンプレートと host の render 結果が byte 単位で一致すること、正規表現が囲み行だけに当たることを chezmoi v2.72.2 で実測。浅い clone でも動く。

### security-vulnerability-analyzer
- verdict: needs-work（non-blocking、一部採用）
- 主指摘: 権限は増えないが、bootstrap は agent の承認・sandbox を通らずに次回起動で実行されるため、`~/.local/bin` に仕込んだものが「ゲートを通らず・セッション終了後に」走る持続経路になる。→ 採用: PATH は末尾追加にし、system のコマンド（curl・bash・rsync・git・chezmoi）を横取りできなくした（テスト追加）。受容: mise・claude など user 領域にしか無いツールの差し替えは、次回の対話セッション起動（`bash -lc` で `~/.local/bin/claude` を実行）でも同じく成立する既存の性質で、VM 境界の内側に留まる。

### scope-justification-reviewer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=9746dd967a1233d608f33a0367541a48877b1af9ade8e92b1aa1c54b391b2232; design-hash=a18968b0e22e09fd4038fa1279b31aaf982fb4e26a33b3d7e68b9852e7425286; round=2; parent-spec-hash=34a1ddc3b9669296fa9387fc587f25c25cffe7efcb918cbc6fc5ab05da33a858; at=2026-09-28T16:27:15.580Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=1; excluded=1; at=2026-09-28T16:27:15.597Z -->

## Reviewer Outputs (Round 4)

### logic-validator
- verdict: pass
- 主指摘: PATH を末尾追加にしても、stub（chezmoi・curl）と claude の探索はどのテストでも期待どおりに解決される。T2 の件数も一致。

### security-vulnerability-analyzer
- verdict: pass（minor 1 件、反映済み）
- 主指摘: 末尾追加で system のコマンドは横取りできず、user 領域のツールの差し替えは対話セッション起動（path.sh が `~/.local/bin` を前置、`bash -lc` で claude を実行）でも成立する既存の性質であることをソースで確認。テストが rsync しか見ていない → curl も同じテストで確認するよう追加。 

### scope-justification-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=24a9ce65f4d9dacb1cb9c3a644a3d0b043c5135afb1e7d68868d89fdc7eba276; design-hash=39d2973b8d90d64829aa15b9af23a3df0ae68ab24eb761d420cdb2efe772e5c3; round=3; parent-spec-hash=34a1ddc3b9669296fa9387fc587f25c25cffe7efcb918cbc6fc5ab05da33a858; at=2026-09-28T16:28:51.158Z; reviewers=logic-validator+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=1; excluded=0; at=2026-09-28T16:28:51.173Z -->

<!-- auto-review: verdict=pass; hash=f833412278be348f0d1ae82fcf494287b118f3e12470befd436dbc9a5b2f2491; design-hash=28812542dc391d30e5fed0c2f76411877cbea3e11cc67d9f95179311cfd9b656; round=4; parent-spec-hash=34a1ddc3b9669296fa9387fc587f25c25cffe7efcb918cbc6fc5ab05da33a858; at=2026-09-28T16:42:04.809Z; reviewers=logic-validator+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=1; excluded=0; at=2026-09-28T16:42:04.824Z -->
