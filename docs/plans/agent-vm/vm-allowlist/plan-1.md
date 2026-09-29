<!-- spec-ref: spec.md -->

# Plan: agent-vm に配る dotfiles を allowlist にする (Execution layer)

## Files

```
# 編集
home/.chezmoiignore
agent-vm/bootstrap.sh
.github/workflows/ci-agent-vm.yml
docs/decisions/0018-agent-vm-orbstack.md
docs/agent-vm.md

# 新規
agent-vm/vm-settings.jq
agent-vm/vm-claude-json.jq
agent-vm/vm-codex-config.awk

# 改名（K22）
home/.chezmoiscripts/run_onchange_install-claude-skills-11.sh.tmpl
home/.chezmoiscripts/run_onchange_after_install-claude-skills-11.sh.tmpl

# テスト
tests/agent-vm/run-templates.sh
tests/agent-vm/run-bootstrap.sh
tests/agent-vm/fixtures/vm-managed.txt
tests/agent-vm/fixtures/settings.json
tests/agent-vm/fixtures/claude.json
tests/agent-vm/fixtures/codex-config.toml
tests/agent-vm/stubs/curl
tests/agent-vm/stubs/dpkg
tests/agent-vm/stubs/sudo
```

## Tasks

テストは `tests/agent-vm/` の既存の流儀（`lib.sh` の `record` / `assert_eq` / `assert_contains` / `assert_not_contains` / `assert_status`、`test_` で始まる関数を自動で実行）に合わせる。`run-templates.sh` と `run-bootstrap.sh` は CI では Linux でだけ走る（`.github/workflows/ci-agent-vm.yml:58-69`）。手元の mac では `run-templates.sh` は動く（`chezmoi execute-template` と `chezmoi managed` は `--override-data` で OS を差し替えられることを確認済み）。`run-bootstrap.sh` は Linux 前提（`stat -f -c %T`、GNU の `chmod --reference` と `sed -i`、mawk）なので、手元では OrbStack の使い捨ての通常マシンで回す: `orb create ubuntu avm-test`（通常マシンは mac のホームを同じパスで読める）→ `orb -m avm-test bash -lc 'cd <worktree> && bash tests/agent-vm/run-bootstrap.sh'` → `orb delete -f avm-test`。Ubuntu の既定の awk は mawk なので、awk のテストもここで mawk を相手に走る。

### T1: `.chezmoiignore` の VM allowlist と、その検査（K17、K20）

**Files:**

- 編集: `home/.chezmoiignore`（末尾に VM ブロックを追加）
- 新規: `tests/agent-vm/fixtures/vm-managed.txt`
- テスト: `tests/agent-vm/run-templates.sh`
- 参照: `tests/agent-vm/run-templates.sh:12-14`（既存の `render`）、`:48-54`（mise の host 不変テストの形）

- [ ] **Step 1: 失敗するテストを書く**

```bash
VM_DATA='{"agent_vm":true,"chezmoi":{"os":"linux","kernel":{"osrelease":"6.8.0-orbstack"}}}'
HOST_LINUX='{"agent_vm":false,"chezmoi":{"os":"linux","kernel":{"osrelease":"6.8.0"}}}'
managed_as() { # override_data_json -> sorted target paths chezmoi would manage (isolated config/state, no fetches)
  chezmoi managed --source "$SRC" --destination "$TMP_BASE/dst" --config "$TMP_BASE/chezmoi.toml" \
    --cache "$TMP_BASE/cache" --persistent-state "$TMP_BASE/state.boltdb" --refresh-externals never \
    --include all --override-data "$1" | LC_ALL=C sort
}
# Collapses everything under a fixture root written as `<dir>/**` to that one line, so the fixture keeps the
# allowlist's granularity and adding a file under ~/.claude does not require touching it (spec K20).
collapse_to_fixture_roots() { # fixture_path (managed list on stdin)
  awk -v fx="$1" 'BEGIN { while ((getline l < fx) > 0) if (l ~ /\/\*\*$/) roots[substr(l, 1, length(l) - 3)] = 1 }
    { out = $0; for (r in roots) if (index($0, r "/") == 1) out = r "/**"; print out }' | LC_ALL=C sort -u
}
test_vm_manages_exactly_the_allowlist() {
  local fx="$TEST_DIR/fixtures/vm-managed.txt"
  assert_eq "$(LC_ALL=C sort -u "$fx")" "$(managed_as "$VM_DATA" | collapse_to_fixture_roots "$fx")" "VM manages exactly the reviewed allowlist (targets and scripts)"
}
test_host_still_manages_host_only_targets() {
  local out; out=$(managed_as "$HOST_LINUX")
  assert_contains "$out" ".chezmoiscripts/gc.sh" "hosts keep host-only scripts"
  assert_contains "$out" ".config/emacs" "hosts keep host-only files"
}
test_ignore_vm_block_leaves_host_render_unchanged() {
  local t=.chezmoiignore stripped data
  stripped=$(sed '/^{{- if dig "agent_vm" false \. }}$/,/^{{- end }}$/d' "$SRC/$t")
  for data in "$HOST_LINUX" '{"agent_vm":false,"chezmoi":{"os":"darwin"}}' '{"chezmoi":{"os":"linux","kernel":{"osrelease":"6.8.0"}}}'; do
    assert_eq "$(chezmoi execute-template --source "$SRC" --override-data "$data" <<<"$stripped")" "$(render "$t" "$data")" "VM block renders nothing on hosts ($data)"
  done
}
```

`test_host_still_manages_host_only_targets` と `test_ignore_vm_block_leaves_host_render_unchanged` は、VM ブロックを足す前から通る（足した後に壊れないことを確かめるテストである）。Step 2 で失敗を確かめるのは `test_vm_manages_exactly_the_allowlist` だけである。

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run-templates.sh`
期待: `fixtures/vm-managed.txt` が無いので `FAIL VM manages exactly the reviewed allowlist`、終了コード 1

- [ ] **Step 3: 最小実装を書く**

`home/.chezmoiignore` の末尾（最後の `{{ end }}` の次の行）に追加する。

```
# agent-vm machines: bring in only what the VM needs, by target path (docs/decisions/0018-agent-vm-orbstack.md K17).
{{- if dig "agent_vm" false . }}
**
!.bashrc
!.bash_profile
!.zshenv
!.zsh
!.zsh/**
!.shell_common
!.shell_common/**
!.gitconfig
!.gitconfig_gpg_ssh
!.config
!.config/git
!.config/git/**
!.config/mise
!.config/mise/**
!.config/starship.toml
!.config/ccstatusline
!.config/ccstatusline/**
!.config/uv
!.config/uv/**
!.config/pnpm
!.config/pnpm/**
!.npmrc
!.yarnrc.yml
!.aikido
!.aikido/**
!.apm
!.apm/**
!.claude
!.claude/**
!.codex
!.codex/**
!.local
!.local/bin
!.local/bin/hook-timing
!.local/bin/workflow-cli
!.local/bin/git-worktree-create
!.local/bin/git-worktree-cleanup
!.local/bin/claude-task-list-id
!.local/share
!.local/share/private-skills
!.local/share/private-skills/**
!.chezmoiscripts/install-packages-0-prepare.sh
!.chezmoiscripts/00-install-mise-tools.sh
!.chezmoiscripts/10-install-hook-deps.sh
!.chezmoiscripts/zz-verify-provisioning.sh
!.chezmoiscripts/update-settings-json.sh
!.chezmoiscripts/update-claude-json.sh
!.chezmoiscripts/install-claude-plugins-8.sh
!.chezmoiscripts/install-claude-skills-11.sh
!.chezmoiscripts/sync-skills.sh
!.chezmoiscripts/install-safe-chain.sh
{{- end }}
```

期待リストを作る: まず上の `!` 行から `!` を取った一覧を `tests/agent-vm/fixtures/vm-managed.txt` として書く（`**` 付きのものは `<dir>/**` のまま）。テストを走らせ、差分が出たら 1 行ずつ判断する。(a) chezmoi が実際に管理するのに一覧に無い: 戻したディレクトリの中なら collapse で吸収されるはずなので、吸収されないものは allowlist の外から来ている。allowlist を直す。(b) 一覧にあるのに管理されない: script 名の書き間違いなど。allowlist を直す。(c) 外部（`.local/share/private-skills` などの `.chezmoiexternal`）の出方が一覧と違う: `managed` が外部をどう列挙するかに合わせて fixture の書き方（根元だけか、`/**` か）を直す。これは (a)(b) と違い、列挙の形式の問題なので fixture 側を直してよい。それ以外で fixture を実際の出力に合わせて書き換えることはしない。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run-templates.sh`
期待: `PASS VM manages exactly the reviewed allowlist`、`PASS hosts keep host-only scripts`、`PASS hosts keep host-only files`、`PASS VM block renders nothing on hosts` が 3 件、既存テストもすべて PASS、`0 failed`

- [ ] **Step 5: コミット**

```bash
git add home/.chezmoiignore tests/agent-vm/fixtures/vm-managed.txt tests/agent-vm/run-templates.sh
git commit -m "feat(agent-vm): apply only an allowlist of targets and scripts inside VMs"
```

### T2: VM 用ツールを bootstrap が入れる（K18）

**Files:**

- 編集: `agent-vm/bootstrap.sh`（定数を先頭の `SUPPORTED_CONTRACT` の近くに、関数を `fail` の定義（12 行目）の直後、contract の検査より前に置く。呼び出しは PATH の export の後、claude 導入の前。`link_outbox` は claude 導入より後で定義されているので、その近くに置くと呼び出し時点で未定義になる）
- 編集: `tests/agent-vm/stubs/curl`（`-o <file>` を受けたらそのファイルに書く）
- 新規: `tests/agent-vm/stubs/dpkg`、`tests/agent-vm/stubs/sudo`
- テスト: `tests/agent-vm/run-bootstrap.sh:13-15`（stub の symlink）、`:21-29`（`setup_vm_env`）
- 参照: `home/.chezmoiscripts/run_onchange_install-packages-1-linux.sh.tmpl:8-39`（対応する host の処理）、`tests/agent-vm/stubs/curl`（stub の書き方）

- [ ] **Step 1: 失敗するテストを書く**

stub の変更と追加（既存の `stubs/curl` と同じ形）。`stubs/curl` は、今は標準出力に小さな installer（自分の実行を `STUB_LOG` に書く）を出すだけなので、`-o <file>` が与えられたときはそのファイルに同じ内容を書くようにする:

```bash
#!/usr/bin/env bash
# Test stub: records argv; emits a tiny installer script that logs its own execution, to stdout or to `-o <file>`.
# shellcheck disable=SC2154 # STUB_LOG is exported by tests/agent-vm/run-bootstrap.sh
{ printf 'curl'; printf ' %q' "$@"; printf '\n'; } >>"$STUB_LOG"
if [[ "${STUB_CURL_EXIT:-0}" -ne 0 ]]; then exit "$STUB_CURL_EXIT"; fi
out=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then out=$2; shift; fi
  shift
done
script=$(printf 'echo installer-ran >>%q\n' "$STUB_LOG")
if [[ -n "$out" ]]; then printf '%s\n' "$script" >"$out"; else printf '%s\n' "$script"; fi
```

```bash
#!/usr/bin/env bash
# Test stub: records argv; `dpkg -s <pkg>` reports installed unless the package is listed in STUB_DPKG_MISSING.
# Assumes the only call shape is `dpkg -s <pkg>`, which is all bootstrap.sh uses.
# shellcheck disable=SC2154 # STUB_LOG is exported by the test runner
{ printf 'dpkg'; printf ' %q' "$@"; printf '\n'; } >>"$STUB_LOG"
case " ${STUB_DPKG_MISSING:-} " in *" ${2:-} "*) exit 1 ;; esac
exit 0
```

```bash
#!/usr/bin/env bash
# Test stub: records argv instead of escalating; fails with STUB_SUDO_EXIT when set.
# shellcheck disable=SC2154 # STUB_LOG is exported by the test runner
{ printf 'sudo'; printf ' %q' "$@"; printf '\n'; } >>"$STUB_LOG"
exit "${STUB_SUDO_EXIT:-0}"
```

`run-bootstrap.sh` の 13〜15 行目の symlink に `dpkg` と `sudo` を足す。`setup_vm_env` の中で `mkdir -p "$HOME/.local/bin"` し、`$HOME/.local/bin/mise` と、`$TMP_ROOT/bin` の `starship`・`bat`・`fd` に、`--version` に 0 を返す実行ファイル（`#!/bin/sh` と `exit 0`）を置き、既存のテストでは「すべて入っている」状態にする。追加するテスト:

```bash
test_vm_tools_skipped_when_present() {
  setup_vm_env
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  assert_contains "$(cat "$STUB_LOG")" "dpkg -s jq" "checks apt packages"
  assert_not_contains "$(cat "$STUB_LOG")" "apt-get" "no apt when every package is present"
  assert_not_contains "$(cat "$STUB_LOG")" "mise.run" "no mise installer when mise is present"
}
test_missing_apt_packages_installed_noninteractively_before_apply() {
  setup_vm_env
  STUB_DPKG_MISSING="jq ripgrep" bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  local log; log=$(cat "$STUB_LOG")
  assert_contains "$log" "sudo apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=3 update" "refreshes package lists, waiting for a held dpkg lock"
  assert_contains "$log" "sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=3 install -y --no-install-recommends jq ripgrep" "installs only the missing packages, without prompts or recommends"
  assert_eq "sudo" "$(grep -m1 -oE '^(sudo|chezmoi)' <<<"$log")" "packages come before chezmoi apply"
}
test_mise_installed_before_apply_when_missing() {
  setup_vm_env; rm "$HOME/.local/bin/mise"
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  local log; log=$(cat "$STUB_LOG")
  assert_contains "$log" "https://mise.run" "fetches the mise installer"
  assert_contains "$log" " -o " "downloads to a file instead of piping into sh"
  assert_contains "$log" "--max-time" "downloads are time-bounded"
  assert_contains "$log" "--proto =https" "downloads refuse non-https redirects"
  assert_contains "$log" "installer-ran" "runs the downloaded installer"
}
test_installer_download_failure_leaves_no_temp_file() {
  setup_vm_env; rm "$HOME/.local/bin/mise"
  export TMPDIR="$TMP_ROOT/tmp"; mkdir -p "$TMPDIR"
  local status=0
  STUB_CURL_EXIT=22 bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1 || status=$?
  if [[ "$status" -ne 0 ]]; then record "PASS download failure aborts bootstrap"; else record "FAIL download failure aborts bootstrap"; fi
  assert_eq "" "$(ls -A "$TMPDIR")" "no installer temp file left behind"
  assert_status 1 "no applied hash after a failed download" -- test -e "$HOME/.local/state/agent-vm/applied-hash"
}
test_dangling_bat_link_is_replaced() {
  setup_vm_env; rm "$TMP_ROOT/bin/bat"
  printf '#!/bin/sh\nexit 0\n' >"$TMP_ROOT/bin/batcat"; chmod +x "$TMP_ROOT/bin/batcat"
  ln -s /nonexistent/batcat "$HOME/.local/bin/bat" # left by an earlier failed run
  assert_status 0 "bootstrap recovers from a dangling bat link" -- bash "$BOOTSTRAP" 1 v1:abc "$SRC"
  assert_eq "$TMP_ROOT/bin/batcat" "$(readlink "$HOME/.local/bin/bat")" "bat points at batcat"
}
test_missing_debian_binary_fails_with_its_name() {
  # Needs a runner without fd / fdfind in the system dirs of the fixed PATH; skip visibly where they exist.
  if command -v fdfind >/dev/null 2>&1 || [[ -x /usr/bin/fd ]]; then record "PASS missing fdfind case skipped (fd-find is installed on this runner)"; return 0; fi
  setup_vm_env; rm "$TMP_ROOT/bin/fd" # and no fdfind anywhere on the fixed PATH
  local err status=0; err=$(bash "$BOOTSTRAP" 1 v1:abc "$SRC" 2>&1) || status=$?
  assert_eq 1 "$status" "missing fdfind fails the bootstrap"
  assert_contains "$err" "fdfind is missing" "names the missing command"
}
test_failed_tool_install_does_not_record_hash() {
  setup_vm_env
  local status=0
  STUB_DPKG_MISSING=jq STUB_SUDO_EXIT=100 bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1 || status=$?
  if [[ "$status" -ne 0 ]]; then record "PASS tool install failure aborts bootstrap"; else record "FAIL tool install failure aborts bootstrap"; fi
  assert_status 1 "no applied hash after a failed tool install" -- test -e "$HOME/.local/state/agent-vm/applied-hash"
}
# bootstrap mirrors part of the host apt script (spec K18). The package names come from what bootstrap actually
# checks (the dpkg stub's log), not from its source text.
test_vm_apt_packages_are_a_subset_of_the_host_list() {
  setup_vm_env
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  local vm host pkg missing=""
  vm=$(sed -n 's/^dpkg -s //p' "$STUB_LOG")
  assert_contains "$vm" "jq" "bootstrap checks its apt packages"
  host=$(awk '/^  linux:/{l=1;next} /^  [a-z_]+:/{l=0} l && /^    apt:/{a=1;next} l && /^    [a-z_]+:/{a=0} l && a && /^      - /{gsub(/[" -]/,""); print}' "$REPO_ROOT/home/.chezmoidata/packages.yaml")
  for pkg in $vm; do grep -qxF "$pkg" <<<"$host" || missing="$missing $pkg"; done
  assert_eq "" "$missing" "VM apt packages are a subset of the host list"
}
test_vm_installers_come_from_the_host_sources() {
  # A text check on purpose: both files must name the same installer origin.
  local host_script="$REPO_ROOT/home/.chezmoiscripts/run_onchange_install-packages-1-linux.sh.tmpl"
  local url; for url in https://mise.run https://starship.rs/install.sh; do
    assert_contains "$(cat "$host_script")" "$url" "host script installs from $url"
    assert_contains "$(cat "$BOOTSTRAP")" "$url" "bootstrap installs from $url"
  done
}
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: 使い捨てマシンで `bash tests/agent-vm/run-bootstrap.sh`
期待: `FAIL checks apt packages`、`FAIL installs only the missing packages ...`、`FAIL fetches the mise installer`、`FAIL bootstrap checks its apt packages`、`FAIL bootstrap installs from https://mise.run` を含み、終了コード 1。既存の claude 導入のテスト（`curl -fsSL https://claude.ai/install.sh` と `installer-ran`）は、curl の stub が `-o` の無い呼び出しで今までどおり標準出力に書くので PASS のまま。

- [ ] **Step 3: 最小実装を書く**

`bootstrap.sh` の先頭の定数（`readonly SUPPORTED_CONTRACT=1` の後）に追加する。

```bash
# VM counterpart of the host's run_onchange_install-packages-1-linux, which the VM does not run (spec K17/K18).
# Constants on purpose: the VM controls both its environment and the staging copy.
readonly VM_APT_PKGS=(jq bat fd-find ripgrep shellcheck)
# A fresh machine can still hold the dpkg lock (cloud-init, unattended-upgrades); wait for it instead of failing,
# and bound every download so a stalled network fails the bootstrap (retried next launch) instead of hanging it.
readonly APT_OPTS=(-o DPkg::Lock::Timeout=120 -o Acquire::Retries=3)
readonly CURL_OPTS=(-fsSL --proto =https --tlsv1.2 --retry 3 --retry-connrefused --connect-timeout 15 --max-time 300)
```

`fail` の定義の直後に関数を追加する。

```bash
# bootstrap.sh owns no global EXIT trap: run_installer and filter_vm_config each set one for their own temp file
# and clear it on success. A future global cleanup must be folded into those, not added as a separate trap.
run_installer() { # url, installer args...: download first so a truncated fetch is never executed
  local url=$1 script
  shift
  script=$(mktemp)
  # shellcheck disable=SC2064 # expand now: remove this call's file even when fail() exits the script
  trap "rm -f '$script'" EXIT
  curl "${CURL_OPTS[@]}" -o "$script" "$url" || fail "could not download $url"
  # The installer downloads its own binary with its own curl; bound the whole run so a stall cannot hang bootstrap.
  timeout 600 sh "$script" "$@" || fail "installer from $url failed or timed out"
  rm -f "$script"
  trap - EXIT
}
link_debian_name() { # debian_command usual_name: Ubuntu ships bat / fd as batcat / fdfind
  local src
  command -v "$2" >/dev/null 2>&1 && return 0
  src=$(command -v "$1") || fail "$1 is missing after the apt install"
  ln -sfn "$src" "$HOME/.local/bin/$2" # -f replaces a dangling link left by an earlier failed run
}
install_vm_tools() { # only what the VM needs, before apply: 00-install-mise-tools needs mise, the plugin and
  # update-*-json scripts need jq. tests/agent-vm/run-bootstrap.sh checks the list stays a subset of the host's.
  local pkg missing=()
  for pkg in "${VM_APT_PKGS[@]}"; do
    dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    # sudo resets the environment, so DEBIAN_FRONTEND goes after it; no recommends keeps MTAs (postfix) out.
    sudo apt-get "${APT_OPTS[@]}" update
    sudo DEBIAN_FRONTEND=noninteractive apt-get "${APT_OPTS[@]}" install -y --no-install-recommends "${missing[@]}"
  fi
  mkdir -p "$HOME/.local/bin"
  # `--version` rather than -x: a zero-byte file from an interrupted install must not count as installed.
  if ! "$HOME/.local/bin/mise" --version >/dev/null 2>&1; then
    run_installer https://mise.run
  fi
  if ! starship --version >/dev/null 2>&1; then
    run_installer https://starship.rs/install.sh --yes --bin-dir "$HOME/.local/bin"
  fi
  link_debian_name batcat bat
  link_debian_name fdfind fd
}
```

`export PATH=...` の行の後、claude の導入の前に `install_vm_tools` を呼ぶ。claude の導入（既存の `curl -fsSL https://claude.ai/install.sh | bash`）は K16 のとおり host と同じ形のまま変えない。

- [ ] **Step 4: テストを実行して通過を確認**

実行: Step 2 と同じ
期待: `run-bootstrap.sh` が `0 failed`（既存 24 件と追加分）

- [ ] **Step 5: コミット**

```bash
git add agent-vm/bootstrap.sh tests/agent-vm/stubs/curl tests/agent-vm/stubs/dpkg tests/agent-vm/stubs/sudo tests/agent-vm/run-bootstrap.sh
git commit -m "fix(agent-vm): install the VM's own tools before applying dotfiles"
```

### T3: apply の後の VM 用後処理と自己検査（K19）

**Files:**

- 新規: `agent-vm/vm-settings.jq`、`agent-vm/vm-claude-json.jq`、`agent-vm/vm-codex-config.awk`
- 新規: `tests/agent-vm/fixtures/settings.json`、`tests/agent-vm/fixtures/claude.json`、`tests/agent-vm/fixtures/codex-config.toml`
- 編集: `agent-vm/bootstrap.sh`（定数を先頭に、関数は T2 の `install_vm_tools` の後（`fail` より後、どの呼び出しよりも前）に、呼び出しは apply の後・`applied-hash` を書く前）
- テスト: `tests/agent-vm/run-bootstrap.sh`
- 参照: `home/.chezmoiscripts/run_onchange_update-settings-json.sh.tmpl:36-41`（hook-timer による包み方）、`home/dot_codex/.config.toml:9-20`（codex の MCP 定義）、`agent-vm/bootstrap.sh:54-57`（apply と `applied-hash`）

- [ ] **Step 1: 失敗するテストを書く**

fixture `settings.json`（実際の形に合わせる。`/home/u` はテストの `$HOME` とは無関係でよい）。`speak-notification-extra.ts` は「名前が似た別の hook は後処理が残す」ことを確かめるためのもので、jq プログラムの単体テストだけで使う（自己検査は `speak-notification` を部分文字列で探すので、bootstrap のテストではこの hook を取り除いた版を使う）:

```json
{
  "enabledPlugins": { "x@y": true },
  "permissions": { "allow": ["Bash(ls:*)"] },
  "hooks": {
    "Stop": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "sh '/home/u/.claude/hooks/hook-timer.sh' 'Stop' 0 'bun /home/u/.claude/hooks/implementations/completion-gate.ts'" },
        { "type": "command", "command": "sh '/home/u/.claude/hooks/hook-timer.sh' 'Stop' 1 'bun /home/u/.claude/hooks/implementations/speak-notification.ts Stop'", "async": true }
      ] }
    ],
    "Notification": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "sh '/home/u/.claude/hooks/hook-timer.sh' 'Notification' 1 'bun /home/u/.claude/hooks/implementations/speak-notification.ts Notification'", "async": true }
      ] }
    ],
    "SessionStart": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "sh '/home/u/.claude/hooks/hook-timer.sh' 'SessionStart' 0 'bun /home/u/.claude/hooks/implementations/speak-notification-extra.ts'" }
      ] }
    ]
  }
}
```

fixture `claude.json`:

```json
{ "installMethod": "native", "oauthAccount": { "id": "keep-me" }, "projects": { "/r": { "mcpServers": { "local-one": {} } } },
  "mcpServers": { "readability": {}, "context7": {}, "drawio": {}, "chrome-devtools": {}, "playwright": {}, "excalidraw": {}, "context7-foo": {} } }
```

fixture `codex-config.toml`（部分一致の名前、下位の表、引用符付きの名前、前後の空白、`[[…]]` の見出し、ファイル末尾の表を含める）:

```toml
approval_policy = 'on-request'

[mcp_servers]
[mcp_servers.context7]
args = ['@upstash/context7-mcp@latest']
command = 'npx'

[mcp_servers.playwright]
args = ['@playwright/mcp@latest']
command = 'npx'

[mcp_servers.playwright.env]
DEBUG = '1'

[mcp_servers.context7-foo]
command = 'npx'

[ mcp_servers."drawio" ]
command = 'npx'

[[profiles]]
name = 'kept'

[sandbox_workspace_write]
writable_roots = ['/home/u/.cache/mise']

[mcp_servers."readability"]
args = ['@mizchi/readability@latest', '--mcp']
command = 'npx'

[mcp_servers.trailing]
command = 'npx'
```

テスト:

```bash
AGENT_VM_DIR="$REPO_ROOT/agent-vm"
KEEP="readability context7 excalidraw"
test_settings_filter_drops_only_the_audio_hook() {
  local out; out=$(jq -f "$AGENT_VM_DIR/vm-settings.jq" "$TEST_DIR/fixtures/settings.json")
  assert_eq '["SessionStart","Stop"]' "$(jq -c '.hooks | keys' <<<"$out")" "empty Notification event is removed"
  assert_eq 1 "$(jq '.hooks.Stop[0].hooks | length' <<<"$out")" "only the audio hook is dropped from a mixed group"
  assert_contains "$out" "speak-notification-extra.ts" "a similarly named hook survives"
  assert_eq '{"x@y":true}' "$(jq -c '.enabledPlugins' <<<"$out")" "other keys are untouched"
}
test_settings_filter_is_idempotent() {
  local once; once=$(jq -f "$AGENT_VM_DIR/vm-settings.jq" "$TEST_DIR/fixtures/settings.json")
  assert_eq "$once" "$(jq -f "$AGENT_VM_DIR/vm-settings.jq" <<<"$once")" "filtering twice changes nothing"
}
test_claude_json_filter_keeps_only_network_mcp() {
  local out; out=$(jq --arg keep "$KEEP" -f "$AGENT_VM_DIR/vm-claude-json.jq" "$TEST_DIR/fixtures/claude.json")
  assert_eq '["context7","excalidraw","readability"]' "$(jq -c '.mcpServers | keys' <<<"$out")" "top-level MCP servers are exactly the allowlist (no prefix matches)"
  assert_eq '{"local-one":{}}' "$(jq -c '.projects["/r"].mcpServers' <<<"$out")" "project-scoped MCP servers are untouched"
  assert_eq '{"id":"keep-me"}' "$(jq -c '.oauthAccount' <<<"$out")" "other keys are untouched"
}
test_codex_filter_keeps_only_allowlisted_tables() {
  local out; out=$(awk -v keep_list="$KEEP" -f "$AGENT_VM_DIR/vm-codex-config.awk" "$TEST_DIR/fixtures/codex-config.toml")
  assert_eq '[mcp_servers] [mcp_servers.context7] [[profiles]] [sandbox_workspace_write] [mcp_servers."readability"]' \
    "$(grep -E '^[[:space:]]*\[' <<<"$out" | paste -sd' ' -)" "codex keeps the allowlisted MCP tables and every other table"
  assert_not_contains "$out" "DEBUG" "sub-tables of a dropped server go too"
  assert_contains "$out" "name = 'kept'" "an array-of-tables header ends a dropped table"
  assert_eq "approval_policy = 'on-request'" "$(head -1 <<<"$out")" "top-level keys are untouched"
}
test_codex_filter_runs_under_the_system_awk() {
  # Ubuntu's default awk is mawk; the filter must not rely on gawk extensions.
  assert_status 0 "system awk runs the codex filter" -- awk -v keep_list="$KEEP" -f "$AGENT_VM_DIR/vm-codex-config.awk" "$TEST_DIR/fixtures/codex-config.toml"
}
place_generated_configs() { # simulate what apply leaves behind (the settings fixture minus the look-alike hook)
  mkdir -p "$HOME/.claude" "$HOME/.codex"
  jq 'del(.hooks.SessionStart)' "$TEST_DIR/fixtures/settings.json" >"$HOME/.claude/settings.json"
  cp "$TEST_DIR/fixtures/claude.json" "$HOME/.claude.json"; chmod 600 "$HOME/.claude.json"
  cp "$TEST_DIR/fixtures/codex-config.toml" "$HOME/.codex/config.toml"; chmod 600 "$HOME/.codex/config.toml"
}
test_bootstrap_filters_after_apply_and_before_recording() {
  setup_vm_env; place_generated_configs
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  assert_not_contains "$(cat "$HOME/.claude/settings.json")" "speak-notification" "settings filtered after apply"
  assert_eq '["context7","excalidraw","readability"]' "$(jq -c '.mcpServers | keys' "$HOME/.claude.json")" "Claude MCP filtered after apply"
  assert_eq '{"id":"keep-me"}' "$(jq -c '.oauthAccount' "$HOME/.claude.json")" "Claude login state survives"
  assert_not_contains "$(cat "$HOME/.codex/config.toml")" "playwright" "codex MCP filtered after apply"
  assert_eq 600 "$(stat -c %a "$HOME/.claude.json")" ".claude.json keeps mode 600"
  assert_status 0 "applied hash recorded after filtering" -- test -e "$HOME/.local/state/agent-vm/applied-hash"
}
test_bootstrap_tolerates_missing_config_files() {
  setup_vm_env
  assert_status 0 "no generated configs yet is fine" -- bash "$BOOTSTRAP" 1 v1:abc "$SRC"
}
test_failed_filter_leaves_files_and_hash_untouched() {
  setup_vm_env; place_generated_configs
  printf '{ not json\n' >"$HOME/.claude.json"
  local before status=0; before=$(cat "$HOME/.claude.json")
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1 || status=$?
  if [[ "$status" -ne 0 ]]; then record "PASS a filter failure aborts bootstrap"; else record "FAIL a filter failure aborts bootstrap"; fi
  assert_eq "$before" "$(cat "$HOME/.claude.json")" "the unfilterable file is left as it was"
  assert_eq "" "$(find "$HOME" -maxdepth 1 -name '.claude.json.*')" "no temp file left behind"
  assert_status 1 "no applied hash after a filter failure" -- test -e "$HOME/.local/state/agent-vm/applied-hash"
}
expect_self_check_failure() { # label: bootstrap must exit non-zero and record nothing
  local status=0
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1 || status=$?
  if [[ "$status" -ne 0 ]]; then record "PASS self-check catches $1"; else record "FAIL self-check catches $1"; fi
  assert_status 1 "no applied hash when the self-check catches $1" -- test -e "$HOME/.local/state/agent-vm/applied-hash"
}
test_self_check_catches_an_audio_hook_the_filter_missed() {
  # A wrapper change (here ';' instead of a space after .ts) makes the exact filter miss; the loose check must not.
  setup_vm_env; place_generated_configs
  sed -i 's#speak-notification\.ts Stop#speak-notification.ts;Stop#' "$HOME/.claude/settings.json"
  jq empty "$HOME/.claude/settings.json" # the fixture stays valid JSON, so the failure comes from the self-check
  expect_self_check_failure "a surviving audio hook"
}
test_self_check_catches_codex_mcp_in_unfiltered_forms() {
  setup_vm_env; place_generated_configs
  printf '\n[profiles.x]\nmcp_servers.playwright.command = "npx"\n' >>"$HOME/.codex/config.toml"
  expect_self_check_failure "a dotted-key codex MCP server"
}
test_self_check_does_not_accept_a_kept_name_in_a_value() {
  setup_vm_env; place_generated_configs
  printf '\n[profiles.y]\nmcp_servers.other.command = "context7"\n' >>"$HOME/.codex/config.toml"
  expect_self_check_failure "a kept name that only appears in a value"
}
```

`setup_vm_env` の `$SRC` は偽の staging なので、`bootstrap.sh` は後処理のプログラムを自分の置き場所（`${BASH_SOURCE[0]}` のディレクトリ）から読む。テストは実物の `agent-vm/bootstrap.sh` を実行するので、実物の `agent-vm/vm-*` が使われる。chezmoi の stub は何も書かないので、`place_generated_configs` が置いたファイルがそのまま「apply の結果」として後処理にかかる。

fixture は `update-settings-json` などが実際に書く形を手で写したもので、自動では突き合わせない。実際の形との一致は T7 の実機検証（後処理の後の `settings.json`、`~/.claude.json`、codex の設定の確認）で確かめる。

- [ ] **Step 2: テストを実行して失敗を確認**

実行: 使い捨てマシンで `bash tests/agent-vm/run-bootstrap.sh`
期待: 後処理のファイルが無いので `FAIL empty Notification event is removed` ほか、bootstrap の後処理のテストも FAIL、終了コード 1

- [ ] **Step 3: 最小実装を書く**

`agent-vm/vm-settings.jq`:

```jq
# VM post-processing of ~/.claude/settings.json (spec K19): drop hooks that only make sense on the host.
# Matches the audio notifier's script path exactly (followed by a space or quote, as hook-timer.sh wraps it),
# then prunes matcher groups and events left empty so the shape stays what update-settings-json writes.
def host_only: test("/\\.claude/hooks/implementations/speak-notification\\.ts[ '\"]");
if .hooks then
  .hooks |= (
    with_entries(.value |= (map(.hooks |= map(select((.command // "") | host_only | not)))
                            | map(select(.hooks | length > 0))))
    | with_entries(select(.value | length > 0)))
else . end
```

`agent-vm/vm-claude-json.jq`（残す一覧は bootstrap から `--arg keep "<空白区切り>"` で受け取る。`--args` は後ろに置いた入力ファイルまで位置引数として取り込み、jq が標準入力を読んで空の結果を返すので使わない）:

```jq
# VM post-processing of ~/.claude.json (spec K19): keep only MCP servers that work with network access alone.
# An allowlist ($keep, space-separated, passed by bootstrap.sh), so MCP servers added to the host template later
# do not reach the VM. Project-scoped servers (projects[...].mcpServers) are the user's own and are left alone.
($keep | split(" ")) as $names
| if .mcpServers then .mcpServers |= with_entries(select(.key | IN($names[]))) else . end
```

`agent-vm/vm-codex-config.awk`（残す一覧は bootstrap から `-v keep_list="<空白区切り>"` で受け取る）:

```awk
# VM post-processing of ~/.codex/config.toml (spec K19): drop [mcp_servers.<name>] tables, and their sub-tables,
# unless <name> is in keep_list (space-separated, passed by bootstrap.sh). Handles quoted names, surrounding
# whitespace and [[...]] headers; dotted keys and inline tables are not produced by the template and are caught
# by bootstrap's self-check instead. Any line starting with `[` counts as a header, so a multi-line array whose
# continuation line starts with `[` would end a dropped table early; the template writes single-line arrays.
# Plain POSIX awk: Ubuntu's default awk is mawk (`]` first in a bracket expression is a literal).
BEGIN { n = split(keep_list, names, " "); for (i = 1; i <= n; i++) keep[names[i]] = 1 }
/^[ \t]*\[/ {
  drop = 0
  header = $0
  sub(/^[ \t]*\[+[ \t]*/, "", header)
  if (index(header, "mcp_servers.") == 1) {
    name = substr(header, 13)
    sub(/^"/, "", name)
    sub(/[]". \t].*$/, "", name)
    drop = !(name in keep)
  }
}
!drop
```

`bootstrap.sh` の先頭の定数に追加する。

```bash
# The one list of MCP servers the VM keeps; the jq filter, the awk filter and the self-check all take it from here.
readonly VM_MCP_KEEP="readability context7 excalidraw"
```

`install_vm_tools` の後に関数を追加する。

```bash
filter_vm_config() { # target file, command... (the target is appended last): rewrite through a same-directory temp
  local target=$1 tmp
  shift
  [[ -f "$target" ]] || return 0
  tmp=$(mktemp "$target.XXXXXX") || fail "cannot create a temp file next to $target"
  # shellcheck disable=SC2064 # expand now: remove this call's file even when fail() exits the script
  trap "rm -f '$tmp'" EXIT
  "$@" "$target" >"$tmp" || fail "could not post-process $target for the VM"
  # An empty result is never a valid config; refuse it rather than wipe the file (and, for .claude.json, the login).
  [[ -s "$tmp" ]] || fail "post-processing $target produced nothing"
  chmod --reference="$target" "$tmp"
  mv "$tmp" "$target"
  trap - EXIT
}
filter_vm_configs() { # every bootstrap, after apply (spec K19)
  local here
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  filter_vm_config "$HOME/.claude/settings.json" jq -f "$here/vm-settings.jq"
  filter_vm_config "$HOME/.claude.json" jq --arg keep "$VM_MCP_KEEP" -f "$here/vm-claude-json.jq"
  filter_vm_config "$HOME/.codex/config.toml" awk -v keep_list="$VM_MCP_KEEP" -f "$here/vm-codex-config.awk"
}
verify_vm_config() { # deliberately looser than the filters, and fail-closed: a filter that removed nothing must stop here
  local keep_alt bad verdict
  # A mismatch here repeats on every launch until the dotfiles or the filters change; say how to get unstuck.
  local recover="fix the filter in agent-vm/ (or the template that changed), then run: agent-vm rm (the next launch recreates the machine)"
  keep_alt=${VM_MCP_KEEP// /|}
  if [[ -f "$HOME/.claude/settings.json" ]] && grep -q 'speak-notification' "$HOME/.claude/settings.json"; then
    fail "the audio notification hook is still registered after post-processing; $recover"
  fi
  if [[ -f "$HOME/.claude.json" ]]; then
    verdict=$(jq --arg keep "$VM_MCP_KEEP" '(.mcpServers // {}) | keys - ($keep | split(" ")) | length == 0' "$HOME/.claude.json") || verdict=""
    [[ "$verdict" == true ]] || fail "MCP servers outside the VM allowlist remain in ~/.claude.json; $recover"
  fi
  if [[ -f "$HOME/.codex/config.toml" ]]; then
    # Any line starting with mcp_servers (table header, dotted key or inline table) must name a kept server right
    # after `mcp_servers.`; the bare [mcp_servers] parent header is the only exception.
    bad=$(grep -E '^[[:space:]]*\[*[[:space:]]*mcp_servers' "$HOME/.codex/config.toml" |
      grep -vE '^[[:space:]]*\[[[:space:]]*mcp_servers[[:space:]]*\][[:space:]]*$' |
      grep -vE "^[[:space:]]*\[*[[:space:]]*mcp_servers\.\"?(${keep_alt})\"?([].[:space:]=]|$)") || true
    [[ -z "$bad" ]] || fail "MCP servers outside the VM allowlist remain in ~/.codex/config.toml: $bad; $recover"
  fi
}
```

`chezmoi init ... --apply` の行の後、`applied-hash` を書く前に呼ぶ。

```bash
# Every bootstrap, after apply: update-settings-json rewrites hooks wholesale, update-claude-json merges MCP
# servers additively and the codex config is regenerated from its template, so anything removed here comes
# back whenever those scripts re-run (spec K19). Nothing records applied-hash unless both succeed.
filter_vm_configs
verify_vm_config
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: Step 2 と同じ。加えて `./scripts/lint-shell.sh`
期待: `run-bootstrap.sh` が `0 failed`、shellcheck が通る

- [ ] **Step 5: コミット**

```bash
git add agent-vm/vm-settings.jq agent-vm/vm-claude-json.jq agent-vm/vm-codex-config.awk agent-vm/bootstrap.sh tests/agent-vm/fixtures/settings.json tests/agent-vm/fixtures/claude.json tests/agent-vm/fixtures/codex-config.toml tests/agent-vm/run-bootstrap.sh
git commit -m "feat(agent-vm): strip host-only hooks and non-network MCP servers after each VM apply"
```

### T4: APM skills の導入を配置後の帯へ移す（K22）

**Files:**

- 改名: `home/.chezmoiscripts/run_onchange_install-claude-skills-11.sh.tmpl` → `home/.chezmoiscripts/run_onchange_after_install-claude-skills-11.sh.tmpl`
- テスト: `tests/agent-vm/run-templates.sh`
- 参照: `home/.chezmoiscripts/run_onchange_after_install-safe-chain.sh.tmpl:4-8`（同じ移動の前例）

- [ ] **Step 1: 失敗するテストを書く**

```bash
# chezmoi runs after-band scripts (run_after_*, run_onchange_after_*, ...) after all files, in target-name order.
after_band_targets() { # target names of the after-band scripts in the source, in the order chezmoi runs them
  local f
  for f in "$SRC"/.chezmoiscripts/run_*after_*; do
    f=${f##*/}; f=${f%.tmpl}; f=${f#run_}; f=${f#once_}; f=${f#onchange_}; f=${f#after_}
    printf '%s\n' "$f"
  done | LC_ALL=C sort
}
test_skills_install_runs_after_mise_tools_and_before_sync() {
  local order; order=$(after_band_targets | grep -xE '00-install-mise-tools\.sh|install-claude-skills-11\.sh|sync-skills\.sh' | paste -sd' ' -)
  assert_eq "00-install-mise-tools.sh install-claude-skills-11.sh sync-skills.sh" "$order" "apm is installed before skills, skills before sync"
}
```

改名前は `install-claude-skills-11` が after 帯に無いので、`order` が `00-install-mise-tools.sh sync-skills.sh` になって FAIL する。

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run-templates.sh`
期待: `FAIL apm is installed before skills, skills before sync`

- [ ] **Step 3: 最小実装を書く**

```bash
git mv home/.chezmoiscripts/run_onchange_install-claude-skills-11.sh.tmpl home/.chezmoiscripts/run_onchange_after_install-claude-skills-11.sh.tmpl
```

中身は変えない（ターゲット名と内容が同じなので既存の host では再実行されない: spec K22）。`git grep -n 'run_onchange_install-claude-skills-11'` で旧ソース名の参照を探し、あれば新しい名前に直す。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run-templates.sh`
期待: `PASS apm is installed before skills, skills before sync`、`VM manages exactly the reviewed allowlist` も PASS のまま（ターゲット名は同じ）

- [ ] **Step 5: コミット**

```bash
git add -A home/.chezmoiscripts tests/agent-vm/run-templates.sh
git commit -m "fix(chezmoi): install APM skills after mise has installed apm"
```

### T5: agent-vm の CI の起動条件を直す（R16）

**Files:**

- 編集: `.github/workflows/ci-agent-vm.yml:6-16,19-29`

- [ ] **Step 1: 変更する**

push と pull_request の両方の `paths` で、`home/.chezmoiscripts/run_onchange_install-packages-7.sh.tmpl` と `home/.chezmoiscripts/run_onchange_install-safe-chain.sh.tmpl` の 2 行を `home/.chezmoiscripts/**` に置き換え、`home/.chezmoiignore` と `home/.chezmoidata/**` を足す（spec R16 の 3 つ）。`agent-vm/**`（後処理のプログラム）と `tests/agent-vm/**`（fixture）は既存の行でカバー済みなので足さない。

- [ ] **Step 2: 確認とコミット**

実行: `bun run check`（actionlint を含む）
期待: 成功

```bash
git add .github/workflows/ci-agent-vm.yml
git commit -m "ci(agent-vm): run the VM tests when chezmoi scripts, ignore rules or data change"
```

### T6: ADR と利用ガイドの更新（成果物）

**Files:**

- 編集: `docs/decisions/0018-agent-vm-orbstack.md:19-35`（「境界と機構」の節の後に追記）
- 編集: `docs/agent-vm.md:3-14,16-21,59-80`（1 節、2 節、6 節。9 節は T7 で更新する）
- 参照: `.tmp/sessions/115e2d54/spec.md`（K17〜K22 の本文）

- [ ] **Step 1: ADR に追記する**

「### VM に配るもの（K17〜K22、2026-09-30 追記）」の小節を足す。原則（host と共有するテンプレートに VM 分岐を入れず、差分は allowlist と bootstrap だけで表す）を先頭に書き、各 K を 1〜2 文で書く。Consequences に「VM でブラウザを操作する MCP と音声通知は提供しない」「VM で手で apply すると、次の bootstrap まで音声 hook と MCP が戻る」「codex の設定の自己検査は、`[mcp_servers]` の直下に `playwright.command = …` のようにネストした書き方を対象にしない（今のテンプレートは出力しない）」「VM の mise と starship の installer は host と同じくチェックサムで検証しない」を足す。

- [ ] **Step 2: ガイドを更新する**

1 節に「VM に入るのは `.chezmoiignore` の VM ブロックに載ったものだけ。VM 用のツールと、VM 向けの設定の絞り込み（Claude と Codex の MCP、音声通知の hook）は bootstrap が行う」を足す。2 節に「agent forwarding は、承認済みの間 VM に agent のすべての鍵を使わせる（private-skills の clone もこれで行う）」を足す。6 節の復旧コマンドに「初回の準備が途中で止まったマシンは `agent-vm rm` で消し、次の起動で作り直す」「VM の中で手で `chezmoi apply` すると、次の bootstrap まで音声通知の hook と除外した MCP が戻る。戻したくなければ `agent-vm rm` で作り直す」「VM の中で user スコープや codex の設定に足した MCP は、dotfiles の変更後の bootstrap で取り除かれる（Claude の project スコープは残る）」を足す。

- [ ] **Step 3: 確認とコミット**

実行: `bun run check`
期待: 成功

```bash
git add docs/decisions/0018-agent-vm-orbstack.md docs/agent-vm.md
git commit -m "docs(agent-vm): record the VM allowlist and the bootstrap-side VM deltas"
```

### T8: 再 bootstrap のために dasel を入れる（K18 の追加分、2026-09-30 の実機検証で発見）

T1〜T6 は実装・push 済み（`a1d34ff`〜`d62524c`）。T7 Step 4 の R20 の確認で、dotfiles を変えた後の再 bootstrap が codex の設定のマージ（`merge-config.ts` → dasel）で必ず失敗することがわかったので、このタスクで直す。

**Files:**

- 編集: `agent-vm/bootstrap.sh`（関数は他の関数の近く、呼び出しはソースの rsync（`rsync -a --delete ... "$src/" "$cz/"`）の直後、`chezmoi init ... --apply` の前）
- テスト: `tests/agent-vm/run-bootstrap.sh`
- 参照: `home/dot_codex/private_config.toml.tmpl`（working tree に移動してから `bun run merge-config.ts`）、`home/dot_codex/private_dot_merge-config.ts:16-38`（dasel を `which` → `mise which` → mise のインストール先の順に探す）、`.mise.toml:9`（`dasel = "latest"`）

2026-09-30 に実機で確かめた順序: dasel を mise のインストール先に入れるだけでは、`which dasel` が mise の shim を返し、shim が working tree の未信頼の `.mise.toml` を読んでエラーになる。`mise trust <ソース>/.mise.toml` の後にそのディレクトリで `mise install dasel` すると、codex の設定の apply が rc=0 で通る。

- [ ] **Step 1: 失敗するテストを書く**

```bash
logging_mise_stub() { # replaces setup_vm_env's silent mise with one that records its calls and cwd
  printf '#!/bin/sh\necho "mise $* @$PWD" >>"$STUB_LOG"\nexit 0\n' >"$HOME/.local/bin/mise"
  chmod +x "$HOME/.local/bin/mise"
}
test_source_mise_config_trusted_and_dasel_installed_before_apply() {
  setup_vm_env; logging_mise_stub; touch "$SRC/.mise.toml"
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  local cz="$HOME/.local/share/chezmoi" log; log=$(cat "$STUB_LOG")
  assert_contains "$log" "mise trust $cz/.mise.toml" "trusts the VM's own copy of the source's mise config"
  assert_contains "$log" "mise install dasel @$cz" "installs dasel from the source's mise config, in the source dir"
  assert_eq "mise" "$(grep -m1 -oE '^(mise install dasel|chezmoi)' "$STUB_LOG" | cut -d' ' -f1)" "dasel comes before chezmoi apply"
}
```

`test_mise_installed_before_apply_when_missing`（T2）は mise を消し、curl の stub の installer は mise を作らないので、T8 の後はこの手順（`mise trust`）で bootstrap が止まる。このテストは curl の呼び出しだけを確かめているので結果は変わらない。runner は各テストを `( "$t" ) </dev/null || record ...` で呼ぶので、`||` の左側では `set -e` が効かず、bootstrap の失敗でテストや runner が中断することもない（bash の挙動を確認済み）。

テストの `setup_vm_env` の偽の staging には `.mise.toml` が無いので、このテストでは `touch "$SRC/.mise.toml"` を足し、rsync 後に信頼の対象のファイルが実在する形にする。

- [ ] **Step 2: テストを実行して失敗を確認**

実行: 使い捨てマシン（`avm-test`）で `bash tests/agent-vm/run-bootstrap.sh`
期待: `FAIL trusts the VM's own copy of the source's mise config`、`FAIL installs dasel from the source's mise config, in the source dir`、`FAIL dasel comes before chezmoi apply`

- [ ] **Step 3: 最小実装を書く**

関数を追加する。

```bash
prepare_source_tools() { # chezmoi source dir
  # home/dot_codex/private_config.toml.tmpl merges through home/dot_codex/private_dot_merge-config.ts on every
  # apply after the first, from the working tree, so mise must resolve dasel from the source's own .mise.toml
  # there, as on the host (spec K18). Installing dasel into mise's install dir alone is not enough: the merge
  # script finds the mise shim first, and the shim refuses an untrusted .mise.toml. The trusted file is this VM's
  # own copy of the source. Only dasel is installed. Runs on every bootstrap (idempotent) so re-applies never
  # meet a missing dasel.
  "$HOME/.local/bin/mise" trust "$1/.mise.toml"
  (cd "$1" && "$HOME/.local/bin/mise" install dasel)
}
```

`rsync -a --delete ... "$src/" "$cz/"` の行の直後、`chezmoi init ... --apply` の前に `prepare_source_tools "$cz"` を呼ぶ。

- [ ] **Step 4: テストを実行して通過を確認**

実行: Step 2 と同じ。加えて `./scripts/lint-shell.sh`
期待: `run-bootstrap.sh` が `0 failed`、shellcheck が通る

- [ ] **Step 5: コミット**

```bash
git add agent-vm/bootstrap.sh tests/agent-vm/run-bootstrap.sh
git commit -m "fix(agent-vm): install dasel so re-applies can merge the codex config"
```

### T9: 実機で見つかった既知の制約をガイドと ADR に書く（R21、R22）

**Files:**

- 編集: `docs/agent-vm.md`（7 節「気をつけること」）
- 編集: `docs/decisions/0018-agent-vm-orbstack.md`（Consequences）

- [ ] **Step 1: 書く**

`docs/agent-vm.md` 7 節に 2 つ足す。「VM では APM の skills のうち、既定ブランチの解決が要る GitHub のリポジトリの分が入らない（VM の `~/.gitconfig` の SSH への書き換えと、VM に GitHub のトークンを置かない設計の組み合わせ。原因の一部は推測。別の課題）」「VM の mise では `npm:@mizchi/readability` がサプライチェーン対策の閾値で入らない（host と共有する設定の問題。別の課題）」。ADR の Consequences にも 1 行ずつ足す。あわせて ADR の Consequences に「VM は codex の設定のマージのために、ソースの `.mise.toml` を信頼して dasel を入れる。マージを dasel や mise に依存させない作り替えは別の課題」を足す。

- [ ] **Step 2: 確認とコミット**

実行: `bun run check`
期待: 成功

```bash
git add docs/agent-vm.md docs/decisions/0018-agent-vm-orbstack.md
git commit -m "docs(agent-vm): note the APM and readability limits seen on a real VM"
```

### T7: 全体の検査、push、実機検証、PR 本文の更新

T8・T9 の後に行う。T8 は bootstrap の本流（rsync と apply の間）に手順を足すので、2026-09-30 に済んだ Step 4 はやり直す。Step 1（検査一式）と Step 3（push と CI）もやり直す。Step 4 は、失敗した状態の既存マシン（`agent-e2e-repo-6bb049`）と `avm-test` を `orb delete -f` で消してから、**新しいマシン**で初回の prewarm から行う（初回に dasel を取得する経路を通すため）。Step 4 の確認に、`orb -m <machine> bash -lc 'cd ~/.local/share/chezmoi && mise which dasel'` がパスを返すことを足す。R20 の確認は、同じ新しいマシンで初回の prewarm の後に行う。

**Files:**

- 編集: `docs/agent-vm.md:101-123`（9 節、実機検証の結果）
- 参照: `.tmp/agent-vm-e2e/env.sh`（PR ブランチの launcher を host の設定に触れずに動かすための PATH シム）

- [ ] **Step 1: 手元で全部を回す**

実行: `bun run typecheck && bun run test && bun run check && bun run smoke:chezmoi && bun run smoke:provisioning && ./scripts/lint-shell.sh && /bin/bash tests/agent-vm/run.sh && /bin/bash tests/agent-vm/run-shell.sh && bash tests/agent-vm/run-templates.sh`、加えて使い捨てマシンで `bash tests/agent-vm/run-bootstrap.sh`
期待: すべて終了コード 0、agent-vm の各ランナーが `0 failed`（`run.sh` の `test_bootstrap_failure_prints_the_host_hint` を含む。bootstrap が失敗したら launcher が claude を起動しないことの保証として、変更後も通ることを確かめる）

- [ ] **Step 2: host で変わらないことを実地で確かめる**

実行: `mkdir -p .tmp/agent-vm-e2e && cp ~/.config/chezmoi/chezmoistate.boltdb .tmp/agent-vm-e2e/state-copy.boltdb` の後、`chezmoi --source "$PWD/home" --persistent-state .tmp/agent-vm-e2e/state-copy.boltdb diff --exclude externals 2>&1 | grep -E '^diff --git' | sed 's#^diff --git a/##; s# b/.*##' | LC_ALL=C sort -u`（この mac の実際の設定に対して、状態はコピーを使って読み取りだけで比べる。テンプレートの一部は `output` でコマンドを実行するが、どれも読み取りだけのコマンドである）
期待: 出力に `.chezmoiscripts/install-claude-skills-11.sh`、`.chezmoiscripts/update-settings-json.sh`、`.chezmoiscripts/update-claude-json.sh`、`.config/mise/config.toml`、`.codex/config.toml` が**含まれない**（K22 と、host と共有するテンプレートを変えていないことの確認）。PR がもともと足すもの（`.local/bin/agent-vm` など）は含まれてよい。

- [ ] **Step 3: push して CI を確認**

実行: `git push origin feat/agent-vm`、続けて `gh pr checks 191 --watch`
期待: 全チェックが SUCCESS（`agent-vm tests (ubuntu-latest)` の bootstrap / templates を含む）

- [ ] **Step 4: 新しいマシンで実機検証**

実行（host）: `source .tmp/agent-vm-e2e/env.sh` の後、scratchpad のテスト用 repo で `agent-vm prewarm 2>&1 | tee .tmp/agent-vm-e2e/prewarm-fresh.log` を実行し、所要時間を計る（launcher は `/bin/bash` 3.2 で動く）。
期待: 終了コード 0。

VM 内（`orb -m <machine> bash -lc '...'`）で確かめることと期待:

- `dpkg -s postfix` → 非 0（未導入）、`dpkg --audit` → 出力なし。postfix が入っていた場合は `apt-cache rdepends --installed postfix` で持ち込んだパッケージを特定し、実装を止めて spec に戻る（R14）
- `command -v jq mise starship bat fd rg shellcheck` → すべて見つかる（K18）
- `mise ls --missing` → 出力なし（R15）
- `command -v apm` → パスを表示、`ls ~/.apm/apm.lock.yaml` → 存在する（K22）
- `grep -c speak-notification ~/.claude/settings.json` → `0`
- `jq -r '.mcpServers|keys|join(" ")' ~/.claude.json` → `context7 excalidraw readability`、`stat -c %a ~/.claude.json` → `600`
- `grep -E '^\[mcp_servers\.' ~/.codex/config.toml` → `context7` と `readability` だけ
- `claude mcp list` → 3 つが接続済み（自己検査が保証しない「3 つが残っている」ことの確認）
- `chezmoi managed --include all` を `collapse_to_fixture_roots` と同じ規則でまとめた結果 → `tests/agent-vm/fixtures/vm-managed.txt` と一致（R12）
- `prewarm-fresh.log` → apply で実行された script が K17 の 10 本だけ
- `claude --version`、`codex --version` → どちらもバージョンを表示

冪等性: もう一度 `agent-vm prewarm` → 再 bootstrap されず（`applying dotfiles` の行が出ない）数秒で終わる。

R20（後処理済みのファイルの強制上書きと、K19 の「bootstrap のたびに」の不変条件）: VM で再実行される `run_onchange_` の script のテンプレートに、コメントを 1 行だけ一時的に足す（`printf '# probe\n' >> home/.chezmoiscripts/run_onchange_update-claude-json.sh.tmpl`）。コメントでも描画結果の SHA256 が変わるので、VM では `update-claude-json` が再実行されて MCP を追記し直し、codex の設定もテンプレートから作り直される。→ `agent-vm prewarm` → 出力に `applying dotfiles` の行が出る（staging のハッシュが未コミットの変更も含めて変わったことの確認）、終了コード 0 → VM 内で上の codex・settings・`~/.claude.json` の確認が再び期待どおり（取り除いた MCP が戻っていない）→ `git checkout -- home/.chezmoiscripts/run_onchange_update-claude-json.sh.tmpl` で戻す。

- [ ] **Step 5: 対話が要る確認をユーザーに依頼する**

元のオーダーは PR #191 の実機検証なので、PR が未確認として残している対話の項目も確かめる。V3（launcher 経由の署名コミット）、V6（TTY）、V7（初回ログイン）、V11（生体認証の頻度）は、ユーザーのターミナルで `agent-vm claude` を起動してもらって確かめる。

- [ ] **Step 6: 実機結果をガイドに書いてコミットする**

`docs/agent-vm.md` 9 節の表に、Step 4・5 の結果（V1〜V17 のうち確認できたもの、所要時間）を書く。

```bash
git add docs/agent-vm.md
git commit -m "docs(agent-vm): record the macOS real-machine verification results"
```

- [ ] **Step 7: 片付けと PR 本文の更新**

実行: `orb delete -f <machine>`。PR #191 の本文を `pr-description` の規範に沿って更新する（ADR のパスを 0018 に、実機検証の結果、今回の変更）。本文の更新はユーザーに内容を見せてから行う。

戻し方: host 側は `git revert` で戻せる（host と共有するテンプレートの中身を変えておらず、K22 の改名も内容とターゲット名が同じなので、戻しても host で再実行される script は無い）。VM 側は `agent-vm rm` で作り直す。

## ISO 25010 具体テストケース

### 機能適合性（機能完全性）

- **入力**: `chezmoi managed --include all` を `agent_vm=true`、linux で実行し、根元にまとめる → **期待**: `tests/agent-vm/fixtures/vm-managed.txt` と完全一致（script は 10 本ちょうど）
- **入力**: fixture の `settings.json` に `vm-settings.jq` → **期待**: speak-notification の 2 件だけが消え、Notification イベントが消え、`speak-notification-extra.ts` と `enabledPlugins` は残る
- **入力**: fixture の `claude.json` に `vm-claude-json.jq`（`--arg keep "readability context7 excalidraw"`）→ **期待**: top-level の `mcpServers` のキーが `context7`、`excalidraw`、`readability` の 3 つちょうど（`context7-foo` は消える）、`projects` の下と `oauthAccount` は変わらない
- **入力**: fixture の `codex-config.toml` に `vm-codex-config.awk`（mawk）→ **期待**: 表見出しが `[mcp_servers]`、`[mcp_servers.context7]`、`[[profiles]]`、`[sandbox_workspace_write]`、`[mcp_servers."readability"]` の 5 つ、`[mcp_servers.playwright.env]`・`[ mcp_servers."drawio" ]`・末尾の `[mcp_servers.trailing]` は消える
- **入力**: 実機の新しいマシンで初回 bootstrap → **期待**: `command -v apm` が見つかり、`~/.apm/apm.lock.yaml` がある

### 信頼性（回復性・可用性）

- **入力**: `STUB_DPKG_MISSING="jq ripgrep"` で bootstrap → **期待**: dpkg のロック待ち付きの `sudo apt-get ... update` と、`sudo DEBIAN_FRONTEND=noninteractive apt-get ... install -y --no-install-recommends jq ripgrep` が chezmoi より先に呼ばれる
- **入力**: `STUB_DPKG_MISSING=jq STUB_SUDO_EXIT=100` で bootstrap → **期待**: 非 0 で終わり、`applied-hash` が存在しない
- **入力**: `STUB_CURL_EXIT=22` で mise の導入が必要な bootstrap → **期待**: 非 0 で終わり、`$TMPDIR` に一時ファイルが残らず、`applied-hash` が存在しない
- **入力**: `~/.local/bin/bat` が壊れたリンクの状態で bootstrap → **期待**: 終了コード 0、`bat` が `batcat` を指す
- **入力**: `fdfind` が無い状態で bootstrap → **期待**: 終了コード 1、エラーに `fdfind is missing` を含む
- **入力**: `~/.claude.json` が壊れた JSON の状態で bootstrap → **期待**: 非 0 で終わり、ファイルは元のまま、一時ファイルが残らず、`applied-hash` が存在しない
- **入力**: speak-notification の登録を後処理の正規表現に当たらない形（`.ts;Stop`、JSON としては正しい）にして bootstrap → **期待**: 自己検査で非 0、`applied-hash` が存在しない
- **入力**: codex の設定にドット区切りのキー `mcp_servers.playwright.command = "npx"` を足して bootstrap → **期待**: 自己検査で非 0
- **入力**: codex の設定に `mcp_servers.other.command = "context7"`（残す名前が値にだけ現れる）を足して bootstrap → **期待**: 自己検査で非 0
- **入力**: `settings.json` と `.claude.json` と codex の設定が無い状態で bootstrap → **期待**: 終了コード 0
- **入力**: `vm-settings.jq` を 2 回かける → **期待**: 1 回目と同じ出力
- **入力**: 実機の新しいマシンで `agent-vm prewarm`（stdin は `/dev/null`）→ **期待**: 終了コード 0、`dpkg -s postfix` が非 0、`dpkg --audit` が空、2 回目の prewarm は再 bootstrap しない、追跡ファイルを変えた後の prewarm は再 bootstrap して終了コード 0

### 互換性（共存性）

- **入力**: `.chezmoiignore` を `agent_vm=false`（linux / darwin）とキー無しで描画 → **期待**: VM ブロックを取り除いたテンプレートの描画とバイト単位で一致
- **入力**: host（linux）の `chezmoi managed` → **期待**: `.chezmoiscripts/gc.sh` と `.config/emacs` を含む
- **入力**: この mac で PR の source に対して `chezmoi diff`（状態はコピー）→ **期待**: `install-claude-skills-11.sh`、`update-settings-json.sh`、`update-claude-json.sh`、`.config/mise/config.toml`、`.codex/config.toml` が差分に出ない

### 保守性（試験性）

- **入力**: allowlist の script 名をソース名（`run_onchange_...`）で書く → **期待**: `VM manages exactly the reviewed allowlist` が FAIL
- **入力**: `~/.claude/hooks/implementations` にファイルを 1 つ足す → **期待**: `VM manages exactly the reviewed allowlist` は PASS のまま（根元にまとめるため）
- **入力**: bootstrap の `VM_APT_PKGS` に host の一覧に無い名前を足す → **期待**: `VM apt packages are a subset of the host list` が FAIL
- **入力**: `install-claude-skills-11` を file フェーズ（`run_onchange_`）に戻す → **期待**: `apm is installed before skills, skills before sync` が FAIL

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: blocker
- 主指摘: `filter_vm_config` が `jq -f prog --args a b c <file>` の形になり、`--args` が入力ファイルまで位置引数として取り込むので、jq は標準入力を読んで空を出し、`~/.claude.json` を空のファイルで上書きする（手元で再現。→ `--arg keep` に変え、空の結果を拒否、自己検査を fail-closed に）。自己検査の部分文字列 `speak-notification` が fixture の `speak-notification-extra.ts` に当たって bootstrap のテストが必ず落ちる（→ bootstrap のテストではその hook を除いた版を使う）。自己検査のテストの TAB は JSON を壊して別の理由で落ちる（→ `.ts;Stop` に）。R20 の実機確認が無い、K22 の順序テストが repo を見ていない（→ どちらも追加・修正）。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘: R20 の実機確認の欠落、awk の fixture が spec の要求（引用符、`[[…]]`、空白、扱わない書き方）より薄い、K22 の順序テストが空回り、T5 の `home/dot_codex/**` は R16 に無い（→ 外す）、V3/V6/V7/V11 の根拠（→ 元のオーダーが PR の実機検証であることを明記）、実機結果の記録のコミットと `stubs/curl` が Files に無い（→ すべて反映）。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: 定数を先頭に集め、後処理と自己検査を関数（`filter_vm_configs`、`verify_vm_config`）にすること。apt の一覧をソースの文字列から sed で取り出すテストは書き方に依存する（→ dpkg の stub の記録から取る形に）。`packages.yaml` の awk は `apt:` に絞ること（→ 反映）。fixture と実際に書かれる形の一致は自動で確かめない（→ 実機検証で確かめると明記）。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: S1（`--args` による `~/.claude.json` の消失）は high（→ 反映）。一時ファイルは `chmod` や `mv` の失敗でも残さないこと（→ EXIT の trap）。curl に `--proto =https --tlsv1.2` を付けること（→ 反映）。host での `chezmoi diff` は状態ファイルのコピーを使うこと（→ 反映）。

### resilience-analyzer
- verdict: needs-work
- 主指摘: `ln -s "$(command -v batcat)"` は batcat が無いと壊れたリンクを残し、以後毎回「File exists」で止まる（→ 参照先を先に解決して失敗させ、`ln -sfn` に）。apt に dpkg のロック待ちが無く、curl にタイムアウトが無い（→ `DPkg::Lock::Timeout`、`--max-time` などを追加）。installer の一時ファイルの後始末（→ EXIT の trap）。壊れた 0 バイトの mise を導入済みと誤認しない（→ `--version` で判定）。claude の導入（`curl | bash`）も同じ危険があるが、既存の K16 の形なので今回は変えない。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: needs-work
- 主指摘: Round 1 の修正（`--arg`、空の結果の拒否、fail-closed、fixture の分離、`.ts;Stop`、順序テスト）は正しい。新しい関数を「`link_outbox` の近く」に置くと、claude の導入より後で定義され、呼び出し時点で未定義になる（→ `fail` の直後に置くと明記）。`fdfind` が CI の `/usr/bin` にあるとテストが前提を崩す（→ その場合は明示的に飛ばす）。awk の角括弧の中のエスケープは POSIX で未定義（→ `]` を先頭に置く書き方に）。

### scope-justification-reviewer
- verdict: pass
- 主指摘: Round 1 の指摘はすべて解消し、追加分（apt のロック待ち、curl の時間制限、壊れたリンクの回復、fail-closed の自己検査）はどれも K18・K19 の範囲内。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: 定数の集約、関数の分割、dpkg の stub の記録を使う一覧のテストは解消。EXIT trap を他に持たないこと、awk が `[` で始まる行をすべて見出しとみなすことをコメントに書くこと（→ 反映）。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: S1 の修正、一時ファイルの後始末、curl の `--proto`、状態ファイルのコピーを確認。`[mcp_servers]` の直下にネストした書き方は自己検査の対象外であること、installer にチェックサムが無いのは host と同じであることを ADR に書くこと（→ T6 で反映）。

### resilience-analyzer
- verdict: pass
- 主指摘: P0/P1 は無し。installer の本体にも時間の上限を付けること、自己検査の失敗メッセージに復旧手順を入れること（→ `timeout 600` と `agent-vm rm` の案内を反映）。

<!-- auto-review: verdict=blocker; hash=94b42dfb21132bfe01e1ae3c896efef782efa66b50a967ac55eb92b90a3362b0; design-hash=0087dadd65d9bbd6f70a4fa3030a358be69cda2af50d154316e2b203c6c30ccc; round=1; parent-spec-hash=2c6415d31631369762ab6156634434ef3bdf69a2f654dc3d6ff29cee67e20561; at=2026-09-29T15:27:28.448Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: pass
- 主指摘: Round 2 の修正（関数の配置、fdfind のテストの前提、TMPDIR はサブシェルで閉じる、awk の角括弧、trap の扱い、`timeout` は coreutils にある）はすべて妥当。軽微な点: T3 の配置の文言が T2 と食い違う、R20 の確認用の変更（starship.toml）では `run_onchange_` の script が再実行されない、T6 に ADR の注記 2 つが無い（→ 文言の修正、確認用の変更を `update-claude-json` のテンプレートのコメントに変更、注記を追加）。

### scope-justification-reviewer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### resilience-analyzer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=b63bb6ecd24870de103ae03543843d7a8b28cec671d59b13e32a662684fd4cf1; design-hash=0a4409890c80bf8cad66ddd591a9222c9421b191701425bf6b68f2a5ba574ade; round=2; parent-spec-hash=2c6415d31631369762ab6156634434ef3bdf69a2f654dc3d6ff29cee67e20561; at=2026-09-29T15:29:41.666Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->

## Reviewer Outputs (Round 4)

### logic-validator
- verdict: needs-work
- 主指摘: T8 の配置とテストは妥当だが、実機では cwd の `.mise.toml` の信頼が問題になりうると指摘（→ 実機で確認したところ、そのとおり shim が未信頼の設定でエラーになった。T8 を「ソースの `.mise.toml` を信頼し、rsync の後にそのディレクトリで dasel を入れる」に改訂）。mise を消す既存テストが T8 の手順で止まることを明記すべき（→ 反映）。

### scope-justification-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### resilience-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=pass; hash=16a880f01d30951e9cbed69f85baf4a9dc8a6cfacf3549753813354b069120cc; design-hash=31c54d65395feb67c5b18b51662d9746baa675e618643910c986ebc54d98e2c0; round=3; parent-spec-hash=2c6415d31631369762ab6156634434ef3bdf69a2f654dc3d6ff29cee67e20561; at=2026-09-29T15:31:22.343Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->
<!-- intent-triage: adopted=29; excluded=0; at=2026-09-29T15:31:29.718Z -->

## Reviewer Outputs (Round 5)

### logic-validator
- verdict: pass
- 主指摘: 配置（rsync の後・apply の前）、`@$cz` の一致、順序の検査は妥当。mise を消す既存テストが runner ごと止まるという指摘は、`( "$t" ) || ...` の左側では `set -e` が効かないので当たらない（手元で確認し、plan に根拠を追記）。T7 の「T8 の変更は `install_vm_tools` だけ」は古い（→ 修正）。偽の staging に `.mise.toml` を置くこと（→ 反映）。

### scope-justification-reviewer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### resilience-analyzer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=c2f051cf409f4005dff6f5d63e630468f4979dbca66b6604e879c60ea2164ff8; design-hash=79b5eed409acfe0c407230d965e02bb2d0f9e0555351866a74bbe30eac3e4b1f; round=4; parent-spec-hash=101450a553b1969344c25fe302bbd850f0eb7057eb126eec5bddb5a015f1fccf; at=2026-09-29T16:15:25.138Z; reviewers=logic-validator -->

<!-- auto-review: verdict=pass; hash=09915d34f8a88d7d5ef834891ccf63ed1fd71089c420efb7f7f20c4b8022e982; design-hash=23e6480ddf492cce95bfa53459488ab38e64612d8a32031cd235b455c81c3a8d; round=5; parent-spec-hash=692c1cf55cde37b98f871d38882b4d9da53b34241f35d1a200b06db3ae4eccee; at=2026-09-29T16:17:33.255Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->
<!-- intent-triage: adopted=5; excluded=0; at=2026-09-29T16:17:33.292Z -->
