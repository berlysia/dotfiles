<!-- spec-ref: spec.md -->

# Plan 2: VM 側（bootstrap の依存、libgbm、MCP の後処理、自己検査、警告）

spec の K4、K5 と、K6 の bootstrap 部分を実装する。host 側は plan-1、文書と実機検証は plan-3。plan-1 とは独立に実装できる（bootstrap はマウントの中身の有無だけを見る）。

前提: ADR-0019 の変更が master にある（`agent-vm/vm-codex-config.tmpl`、`VM_MCP_KEEP` の export）。

## Files

```
# 編集
agent-vm/bootstrap.sh
tests/agent-vm/run-bootstrap.sh
tests/agent-vm/fixtures/claude.json

# 新規作成
agent-vm/vm-claude-browser.jq
tests/agent-vm/stubs/apt-get
tests/agent-vm/stubs/apt-cache
tests/agent-vm/stubs/dpkg-deb
tests/agent-vm/stubs/ldd
```

## Tasks

全タスク共通の決めごと:

- テストは `tests/agent-vm/run-bootstrap.sh` の流儀に従う（`setup_vm_env` で偽の VM を作り、`bash "$BOOTSTRAP" 1 v1:abc "$SRC"` で走らせる）。新しい fixture は作らず、`tests/agent-vm/fixtures/claude.json` に 2 エントリを足す。
- テストのため、マウント先は `AGENT_VM_BROWSERS_ROOT`（既定 `/opt/agent-vm/browsers`）、libgbm の置き場は `$HOME/.local/lib/agent-vm-browser` とする。既存の `AGENT_VM_MARKER` などと同じ上書きの流儀。
  - `setup_vm_env` で `AGENT_VM_BROWSERS_ROOT="$TMP_ROOT/no-browsers"`（存在しないパス）を export しておく。既存のテストが、実在する `/opt/agent-vm/browsers`（実 VM の上など）に左右されないようにするため。マウントありのテストは、この値を上書きする。
  - 固定パス `/opt/agent-vm/browsers/current/bin/headless_shell` は、plan-1 T3 のマウント先（`--mount ...:/opt/agent-vm/browsers`）と、plan-1 T2 の固定 symlink（`bin/headless_shell`）の組み合わせで決まる。bootstrap の定数のコメントにそう書く。一致は plan-3 の実機検証で確かめる。
- bootstrap は `set -euo pipefail` で動く。新しいコードでは、パイプラインの終了コードが分岐に効かないよう、コマンドの出力をいったん変数に取ってから判定する（`out=$(cmd 2>&1) || true` の後に `grep`）。
- 実行: `bash tests/agent-vm/run-bootstrap.sh`（Linux で chezmoi が要る。CI の ubuntu で走る）。期待: 最終行が `N run, 0 failed`。

### T1: 許可リストを Claude 用と Codex 用に分ける

**Files:**

- 編集: `agent-vm/bootstrap.sh:14-17`（`VM_MCP_KEEP`）、`:86-92`（`filter_vm_configs`）、`:93-115`（`verify_vm_config`）
- テスト: `tests/agent-vm/run-bootstrap.sh`
- 参照: `agent-vm/vm-codex-config.tmpl`（`VM_MCP_KEEP` を `env` で読む。名前は変えない）

- [ ] **Step 1: 失敗するテストを書く**

`tests/agent-vm/fixtures/claude.json` の `mcpServers` にはすでに `"playwright": {}` と `"chrome-devtools": {}` がある。これを、host の生成物（`home/.chezmoiscripts/run_onchange_update-claude-json.sh.tmpl:56-71`）と同じ形に置き換える。キーは足さない。

```json
"playwright": { "type": "stdio", "command": "bunx", "args": ["@playwright/mcp@0.0.75"], "env": {} },
"chrome-devtools": { "command": "bunx", "args": ["chrome-devtools-mcp@0.25.0"] }
```

既存の `test_bootstrap_filters_after_apply_and_before_recording` は、`setup_vm_env` の既定（マウント無し）で走るので、期待値 `["context7","excalidraw","readability"]` のまま PASS する。

```bash
test_claude_keeps_browser_mcp_but_codex_does_not() {
  setup_vm_env; place_generated_configs; mkdir -p "$TMP_ROOT/browsers"; export AGENT_VM_BROWSERS_ROOT="$TMP_ROOT/browsers"
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  assert_eq '["chrome-devtools","context7","excalidraw","playwright","readability"]' "$(jq -c '.mcpServers | keys' "$HOME/.claude.json")" "Claude keeps the browser MCP servers"
  assert_not_contains "$(cat "$HOME/.codex/config.toml")" "playwright" "Codex still drops playwright"
}
test_browser_mcp_dropped_on_a_machine_without_the_mount() {
  setup_vm_env; place_generated_configs; export AGENT_VM_BROWSERS_ROOT="$TMP_ROOT/no-such-mount"
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  assert_eq '["context7","excalidraw","readability"]' "$(jq -c '.mcpServers | keys' "$HOME/.claude.json")" "no mount: browser MCP servers are dropped"
}
```

既存の `test_claude_json_filter_keeps_only_network_mcp`（`KEEP` を直接渡す単体テスト）は、そのままの期待値で PASS し続ける。

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run-bootstrap.sh`
期待: `Claude keeps the browser MCP servers` が FAIL（現行は 3 つだけ残す）。

- [ ] **Step 3: 最小実装を書く**

```bash
# The MCP servers the VM keeps (spec K4). Claude also keeps the browser servers, configured by vm-claude-browser.jq;
# Codex does not (its playwright entry is an unpinned @latest).
readonly VM_CLAUDE_MCP_KEEP="readability context7 excalidraw playwright chrome-devtools"
readonly VM_CODEX_MCP_KEEP="readability context7 excalidraw"
readonly VM_BROWSER_MCP="playwright chrome-devtools"
# Codex only. The name is the contract with vm-codex-config.tmpl, which reads it with `env`.
readonly VM_MCP_KEEP=$VM_CODEX_MCP_KEEP
export VM_MCP_KEEP
# The launcher mounts browsers/<machine> here and publishes current -> gen-*; the store puts the shell at
# bin/headless_shell (agent-vm fetch-browsers / ensure_browsers, spec K2/K3).
BROWSERS_ROOT="${AGENT_VM_BROWSERS_ROOT:-/opt/agent-vm/browsers}"

claude_keep() { # the Claude allowlist for this machine: without the browser mount the browser servers are dropped
  local name keep=""
  for name in $VM_CLAUDE_MCP_KEEP; do
    if [[ ! -d "$BROWSERS_ROOT" && " $VM_BROWSER_MCP " == *" $name "* ]]; then continue; fi
    keep="$keep${keep:+ }$name"
  done
  printf '%s\n' "$keep"
}
```

`filter_vm_configs` の Claude の行を `jq --arg keep "$(claude_keep)" -f "$here/vm-claude-json.jq"` に、`verify_vm_config` の Claude の検査の `--arg keep` も `"$(claude_keep)"` に変える。Codex 側は `VM_MCP_KEEP`（= `VM_CODEX_MCP_KEEP`）のまま。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run-bootstrap.sh`
期待: 全テスト PASS。

- [ ] **Step 5: コミット**

```bash
git add agent-vm/bootstrap.sh tests/agent-vm/run-bootstrap.sh tests/agent-vm/fixtures/claude.json
git commit -m "feat(agent-vm): keep browser MCP servers for Claude in the VM"
```

### T2: `vm-claude-browser.jq`（引数と env の組み直し、冪等）

**Files:**

- 新規: `agent-vm/vm-claude-browser.jq`
- 編集: `agent-vm/bootstrap.sh`（`filter_vm_configs` に 1 行）
- テスト: `tests/agent-vm/run-bootstrap.sh`
- 参照: `agent-vm/vm-claude-json.jq`（同じ jq の流儀）
- 参照: `research.md` F5（playwright は `--executable-path`、chrome-devtools は `--executablePath`）

- [ ] **Step 1: 失敗するテストを書く**

```bash
browser_filter() { # file: the browser args filter as bootstrap runs it
  jq --arg exe /opt/agent-vm/browsers/current/bin/headless_shell --arg lib /home/u/.local/lib/agent-vm-browser \
    -f "$AGENT_VM_DIR/vm-claude-browser.jq" "$1"
}
test_browser_filter_rebuilds_args_from_the_package_pin() {
  local out; out=$(browser_filter "$TEST_DIR/fixtures/claude.json")
  assert_eq '["@playwright/mcp@0.0.75","--headless","--isolated","--executable-path","/opt/agent-vm/browsers/current/bin/headless_shell"]' \
    "$(jq -c '.mcpServers.playwright.args' <<<"$out")" "playwright args"
  assert_eq '["chrome-devtools-mcp@0.25.0","--headless","--isolated","--executablePath","/opt/agent-vm/browsers/current/bin/headless_shell"]' \
    "$(jq -c '.mcpServers["chrome-devtools"].args' <<<"$out")" "chrome-devtools args"
  assert_eq '"/home/u/.local/lib/agent-vm-browser"' "$(jq -c '.mcpServers.playwright.env.LD_LIBRARY_PATH' <<<"$out")" "playwright LD_LIBRARY_PATH"
  assert_eq '"/home/u/.local/lib/agent-vm-browser"' "$(jq -c '.mcpServers["chrome-devtools"].env.LD_LIBRARY_PATH' <<<"$out")" "chrome-devtools LD_LIBRARY_PATH"
  assert_eq '{}' "$(jq -c '.mcpServers.context7' <<<"$out")" "other servers untouched (the fixture's context7 is {})"
}
test_browser_filter_is_idempotent() {
  local once; once=$(browser_filter "$TEST_DIR/fixtures/claude.json")
  printf '%s\n' "$once" >"$TMP_ROOT/once.json"
  assert_eq "$once" "$(browser_filter "$TMP_ROOT/once.json")" "applying twice is byte-identical"
}
test_browser_filter_tolerates_missing_entries() {
  local out; out=$(jq 'del(.mcpServers.playwright, .mcpServers["chrome-devtools"])' "$TEST_DIR/fixtures/claude.json" >"$TMP_ROOT/c.json"; browser_filter "$TMP_ROOT/c.json")
  assert_eq "null" "$(jq -c '.mcpServers.playwright' <<<"$out")" "absent entries are not created"
}
test_browser_filter_leaves_an_entry_without_a_package_pin() {
  local out; out=$(jq '.mcpServers.playwright = {}' "$TEST_DIR/fixtures/claude.json" >"$TMP_ROOT/c.json"; browser_filter "$TMP_ROOT/c.json")
  assert_eq "{}" "$(jq -c '.mcpServers.playwright' <<<"$out")" "an entry without args[0] is left for the self-check"
}
test_browser_filter_keeps_entries_with_non_array_args() {
  local v out
  for v in '"--headless-x"' '3' '{"a":1}'; do
    out=$(jq ".mcpServers.playwright = {args: $v}" "$TEST_DIR/fixtures/claude.json" >"$TMP_ROOT/c.json"; browser_filter "$TMP_ROOT/c.json")
    assert_eq "{\"args\":$v}" "$(jq -c '.mcpServers.playwright' <<<"$out")" "args=$v: the entry is kept as is for the self-check"
  done
}
test_browser_filter_tolerates_no_mcp_servers() {
  local out; out=$(printf '{"oauthAccount":{"id":"x"}}\n' >"$TMP_ROOT/c.json"; browser_filter "$TMP_ROOT/c.json")
  assert_eq '{"oauthAccount":{"id":"x"}}' "$(jq -c . <<<"$out")" "a file without mcpServers is unchanged"
}
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run-bootstrap.sh`
期待: T2 で足したテスト（6 件）が FAIL（`vm-claude-browser.jq` が無い）。

- [ ] **Step 3: 最小実装を書く**

```jq
# VM post-processing of ~/.claude.json (spec K4): point the browser MCP servers at the headless shell the launcher
# mounts at a fixed path, and give them the side-loaded libgbm. Args are rebuilt from the package pin (args[0]),
# never appended, so re-running bootstrap gives the same file; flags the host template may add later after args[0]
# are dropped on purpose. An entry without a string args[0] is left as is, and bootstrap's self-check rejects it.
# $exe and $lib come from bootstrap.sh via --arg.
def browser(flag):
  # Narrow the type first: on a string .args, .args[0]? is empty and would make the whole entry disappear.
  if ((.args // null) | if type == "array" then (.[0] | type) else "none" end) == "string"
  then .args = [.args[0], "--headless", "--isolated", flag, $exe] | .env = ((.env // {}) + {LD_LIBRARY_PATH: $lib})
  else . end;
if .mcpServers then
  .mcpServers |= (
    (if has("playwright") then .playwright |= browser("--executable-path") else . end)
    | (if has("chrome-devtools") then .["chrome-devtools"] |= browser("--executablePath") else . end))
else . end
```

`filter_vm_configs` の Claude の行の直後に足す。許可リストのフィルタが先に走るので、マウントの無い machine では 2 エントリがすでに消えていて、この行は何も変えない（順序に依存していることをコメントに書く）。

```bash
  filter_vm_config "$HOME/.claude.json" jq --arg exe "$BROWSERS_ROOT/current/bin/headless_shell" \
    --arg lib "$HOME/.local/lib/agent-vm-browser" -f "$here/vm-claude-browser.jq"
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run-bootstrap.sh`
期待: 全テスト PASS。

- [ ] **Step 5: コミット**

```bash
git add agent-vm/vm-claude-browser.jq agent-vm/bootstrap.sh tests/agent-vm/run-bootstrap.sh
git commit -m "feat(agent-vm): point the VM browser MCP servers at the mounted headless shell"
```

### T3: 依存の apt と libgbm の取り出し

**Files:**

- 編集: `agent-vm/bootstrap.sh`（定数、新関数 `install_browser_deps`、本体での呼び出し）
- 新規: `tests/agent-vm/stubs/apt-get`、`tests/agent-vm/stubs/apt-cache`、`tests/agent-vm/stubs/dpkg-deb`
- テスト: `tests/agent-vm/run-bootstrap.sh`（`BOOTSTRAP_STUB_DIR` に 3 つの stub のリンクを足す）
- 参照: `agent-vm/bootstrap.sh:45-66`（`install_vm_tools` の、無いものだけ入れる流儀）
- 参照: `research.md` F11（一覧、容量、`libgbm1` の Depends）

一覧の根拠: research F11。明示するのは 44 個（ライブラリ 42、フォント 2）で、apt が依存として足すものを含めると 48 パッケージ、35.1MB になる。plan-3 の実機の測定で数えるのは 48 の方。`libgbm1` の Depends（`libdrm2`、`libexpat1`、`libc6`）は、F11 で一覧と基本の Ubuntu で満たされることを確かめ済み。

stub（`apt-get` が install に使われるのは `sudo` 経由だけで、`sudo` の stub は argv を記録するだけなので、`apt-get` の stub が扱うのは `download` だけでよい）:

`tests/agent-vm/stubs/apt-get`（`chmod +x`）:

```bash
#!/usr/bin/env bash
# Test stub: only `apt-get download <pkg>` reaches this stub (installs go through the sudo stub, which only records).
# shellcheck disable=SC2154 # STUB_LOG is exported by the test runner
{ printf 'apt-get'; printf ' %q' "$@"; printf '\n'; } >>"$STUB_LOG"
[[ "${1:-}" == download ]] || exit 0
[[ -z "${STUB_APT_DOWNLOAD_EXIT:-}" ]] || exit "$STUB_APT_DOWNLOAD_EXIT"
: >"${2}_${STUB_GBM_VERSION:-26.0.8-1ubuntu0.3}_arm64.deb"
```

`tests/agent-vm/stubs/apt-cache`（`chmod +x`）:

```bash
#!/usr/bin/env bash
# Test stub: `apt-cache policy libgbm1` reports STUB_GBM_VERSION as the candidate.
# shellcheck disable=SC2154 # STUB_LOG is exported by the test runner
{ printf 'apt-cache'; printf ' %q' "$@"; printf '\n'; } >>"$STUB_LOG"
printf 'libgbm1:\n  Installed: (none)\n  Candidate: %s\n' "${STUB_GBM_VERSION:-26.0.8-1ubuntu0.3}"
```

`tests/agent-vm/stubs/dpkg-deb`（`chmod +x`）:

```bash
#!/usr/bin/env bash
# Test stub: `dpkg-deb -x <deb> <dir>` lays out what the real arm64 libgbm1 deb holds (research F11).
# shellcheck disable=SC2154 # STUB_LOG is exported by the test runner
{ printf 'dpkg-deb'; printf ' %q' "$@"; printf '\n'; } >>"$STUB_LOG"
d="$3/usr/lib/aarch64-linux-gnu"; mkdir -p "$d/gbm"
printf 'so\n' >"$d/libgbm.so.1.0.0"; ln -sfn libgbm.so.1.0.0 "$d/libgbm.so.1"
```

`tests/agent-vm/stubs/` は `run.sh` と `run-shell.sh` の PATH にも入る。launcher も shell 関数も `apt-get`、`apt-cache`、`dpkg-deb`、`ldd` を呼ばないので、そちらのテストには影響しない。

`ldd` の stub は、それを使う T4 で足す。

- [ ] **Step 1: 失敗するテストを書く**

```bash
test_browser_apt_list_is_exact() {
  # What bootstrap actually asks dpkg about on a machine with the mount, so the test sees behaviour, not source text.
  setup_vm_env; mkdir -p "$TMP_ROOT/browsers"; export AGENT_VM_BROWSERS_ROOT="$TMP_ROOT/browsers"
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  local vm_tools=" jq bat fd-find ripgrep shellcheck "
  local got; got=$(sed -n 's/^dpkg -s //p' "$STUB_LOG" | while read -r p; do [[ "$vm_tools" == *" $p "* ]] || printf '%s\n' "$p"; done | LC_ALL=C sort -u | paste -sd' ' -)
  assert_eq "at-spi2-common fonts-ipafont-gothic fonts-liberation libasound2-data libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libavahi-client3 libavahi-common-data libavahi-common3 libcairo2 libcups2t64 libdatrie1 libdrm-common libdrm2 libfreetype6 libgraphite2-3 libharfbuzz0b libice6 libnspr4 libnss3 libpango-1.0-0 libpixman-1-0 libpng16-16t64 libsm6 libthai-data libthai0 libunwind8 libxaw7 libxcb-render0 libxcomposite1 libxdamage1 libxfixes3 libxi6 libxkbcommon0 libxkbfile1 libxmu6 libxpm4 libxrandr2 libxrender1 libxres1 libxt6t64 x11-common" \
    "$got" "browser apt list is exactly the measured set (research F11; 35.1MB, limit 40MB)"
}
test_browser_deps_installed_only_when_mount_exists_and_missing() {
  setup_vm_env; mkdir -p "$TMP_ROOT/browsers"; export AGENT_VM_BROWSERS_ROOT="$TMP_ROOT/browsers" STUB_DPKG_MISSING="libnss3"
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  local log; log=$(cat "$STUB_LOG")
  assert_contains "$log" "install -y --no-install-recommends libnss3" "missing browser dep installed without recommends"
  assert_eq "0" "$(grep -c '^sudo .*apt-get.* install .*libgbm1' "$STUB_LOG" || true)" "libgbm1 itself is never apt-installed"
  assert_contains "$log" "apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=3 update" "apt lists refreshed before installing browser deps"
}
test_browser_deps_skipped_without_the_mount() {
  setup_vm_env; export AGENT_VM_BROWSERS_ROOT="$TMP_ROOT/no-such-mount" STUB_DPKG_MISSING="libnss3"
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  assert_not_contains "$(cat "$STUB_LOG")" "libnss3" "no browser deps on a machine without the mount"
}
test_libgbm_placed_alone_and_versioned() {
  setup_vm_env; mkdir -p "$TMP_ROOT/browsers"; export AGENT_VM_BROWSERS_ROOT="$TMP_ROOT/browsers"
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  local d="$HOME/.local/lib/agent-vm-browser"
  assert_eq ".version libgbm.so.1 libgbm.so.1.0.0" "$(ls -A "$d" | LC_ALL=C sort | paste -sd' ' -)" "only libgbm.so.1* and the version file are placed"
  assert_eq "26.0.8-1ubuntu0.3" "$(cat "$d/.version")" "deb version recorded"
}
test_libgbm_not_refetched_when_current_but_refetched_when_updated() {
  setup_vm_env; mkdir -p "$TMP_ROOT/browsers"; export AGENT_VM_BROWSERS_ROOT="$TMP_ROOT/browsers"
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1; : >"$STUB_LOG"
  bash "$BOOTSTRAP" 1 v1:def "$SRC" >/dev/null 2>&1
  assert_not_contains "$(cat "$STUB_LOG")" "download libgbm1" "same candidate: no download"
  STUB_GBM_VERSION=26.0.9-1 bash "$BOOTSTRAP" 1 v1:ghi "$SRC" >/dev/null 2>&1
  assert_contains "$(cat "$STUB_LOG")" "download libgbm1" "new candidate: downloaded again"
  assert_eq "26.0.9-1" "$(cat "$HOME/.local/lib/agent-vm-browser/.version")" "new version recorded"
}
test_libgbm_is_refetched_after_a_failed_copy() {
  setup_vm_env; mkdir -p "$TMP_ROOT/browsers"; export AGENT_VM_BROWSERS_ROOT="$TMP_ROOT/browsers"
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  rm -f "$HOME/.local/lib/agent-vm-browser/libgbm.so.1"; : >"$STUB_LOG"
  bash "$BOOTSTRAP" 1 v1:def "$SRC" >/dev/null 2>&1
  assert_contains "$(cat "$STUB_LOG")" "download libgbm1" "a missing libgbm.so.1 is fetched again even with a current .version"
  assert_status 0 "libgbm.so.1 restored" -- test -e "$HOME/.local/lib/agent-vm-browser/libgbm.so.1"
}
test_libgbm_failure_warns_and_still_records_hash() {
  setup_vm_env; mkdir -p "$TMP_ROOT/browsers"; export AGENT_VM_BROWSERS_ROOT="$TMP_ROOT/browsers" STUB_APT_DOWNLOAD_EXIT=100
  local err; err=$(bash "$BOOTSTRAP" 1 v1:abc "$SRC" 2>&1 >/dev/null)
  assert_contains "$err" "libgbm" "the warning names libgbm"
  assert_status 0 "browser problems never block the bootstrap" -- test -e "$HOME/.local/state/agent-vm/applied-hash"
}
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run-bootstrap.sh`
期待: T3 で足したテストのうち 6 件が FAIL（`test_browser_deps_skipped_without_the_mount` は実装前でも PASS する。実装後の回帰を防ぐためのテスト）。

- [ ] **Step 3: 最小実装を書く**

```bash
# Libraries the linux-arm64 headless shell loads, minus mesa (libgbm1 would pull mesa-libgallium and libllvm, ~178MB),
# plus two small fonts (Latin and Japanese). Measured at 35.1MB installed (research F11); the limit is 40MB (spec K5).
# Derived from `playwright install-deps --dry-run chromium-headless-shell` with the spec K5 exclusion regex.
readonly VM_BROWSER_APT_PKGS=(at-spi2-common libasound2-data libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64
  libatspi2.0-0t64 libavahi-client3 libavahi-common-data libavahi-common3 libcairo2 libcups2t64 libdatrie1
  libdrm-common libdrm2 libfreetype6 libgraphite2-3 libharfbuzz0b libice6 libnspr4 libnss3 libpango-1.0-0
  libpixman-1-0 libpng16-16t64 libsm6 libthai-data libthai0 libunwind8 libxaw7 libxcb-render0 libxcomposite1
  libxdamage1 libxfixes3 libxi6 libxkbcommon0 libxkbfile1 libxmu6 libxpm4 libxrandr2 libxrender1 libxres1
  libxt6t64 x11-common fonts-liberation fonts-ipafont-gothic)
GBM_DIR="$HOME/.local/lib/agent-vm-browser"
# agent-vm machines are arm64 (OrbStack on Apple Silicon, spec R4); the libgbm1 deb keeps its library here.
readonly GBM_DEB_LIBDIR=usr/lib/aarch64-linux-gnu

warn() { printf 'agent-vm bootstrap: warning: %s\n' "$1" >&2; }

install_browser_deps() { # spec K5; never fails the bootstrap: the browser is optional, everything else is not
  local pkg missing=() candidate tmp
  [[ -d "$BROWSERS_ROOT" ]] || return 0
  for pkg in "${VM_BROWSER_APT_PKGS[@]}"; do dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg"); done
  # Refresh the lists here rather than rely on install_vm_tools, which skips `update` when its own packages are
  # present: a fresh machine can have empty lists, and the libgbm candidate below must come from current lists.
  sudo apt-get "${APT_OPTS[@]}" update >/dev/null 2>&1 || warn "apt-get update failed; browser libraries may be stale or missing"
  if [[ ${#missing[@]} -gt 0 ]]; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get "${APT_OPTS[@]}" install -y --no-install-recommends "${missing[@]}" ||
      warn "could not install the browser libraries; browser MCP servers will fail to start"
  fi
  candidate=$(apt-cache policy libgbm1 2>/dev/null) || candidate=""
  candidate=$(printf '%s\n' "$candidate" | sed -n 's/^ *Candidate: *//p')
  if [[ -z "$candidate" || "$candidate" == "(none)" ]]; then warn "no libgbm1 candidate in the apt lists"; return 0; fi
  if [[ -e "$GBM_DIR/libgbm.so.1" && "$(cat "$GBM_DIR/.version" 2>/dev/null || true)" == "$candidate" ]]; then return 0; fi
  tmp=$(mktemp -d) || { warn "no temp dir for libgbm"; return 0; }
  # .version goes with the old files, so a copy that fails half way is retried on the next bootstrap.
  if (cd "$tmp" && apt-get download libgbm1 >/dev/null && dpkg-deb -x libgbm1_*.deb x) &&
     mkdir -p "$GBM_DIR" && rm -f "$GBM_DIR"/libgbm.so.1* "$GBM_DIR/.version" &&
     cp -P "$tmp/x/$GBM_DEB_LIBDIR"/libgbm.so.1* "$GBM_DIR/"; then
    printf '%s\n' "$candidate" >"$GBM_DIR/.version"
  else
    warn "could not fetch libgbm (apt-get download libgbm1); the headless shell will not start until the next bootstrap"
  fi
  rm -rf "$tmp"
}
```

本体の `install_vm_tools` の直後に `install_browser_deps` を呼ぶ。`apt-get update` は、マウントのある machine では bootstrap のたびに走る（bootstrap は staging が変わったときにしか走らないので、起動のたびではない）。

spec との差分: spec K5 は「apt lists の更新は `install_vm_tools` の `apt-get update` に依存する」と書いているが、この plan はそれを上書きし、`install_browser_deps` の中で自前で update する。`install_vm_tools` は自分のパッケージがそろっていると update を省くので、新しい machine では apt lists が空のまま install と候補版の比較に進んでしまう（Round 1 の logic、architecture、security の指摘）。spec は承認済みの hash を保つため書き換えず、plan-3 で ADR に正しい挙動を書く。

`tests/agent-vm/run-bootstrap.sh` の冒頭の `ln -s` 群に、3 つの stub のリンクを足す。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run-bootstrap.sh`
期待: 全テスト PASS。

- [ ] **Step 5: コミット**

```bash
git add agent-vm/bootstrap.sh tests/agent-vm/run-bootstrap.sh tests/agent-vm/stubs/apt-get tests/agent-vm/stubs/apt-cache tests/agent-vm/stubs/dpkg-deb
git commit -m "feat(agent-vm): install the headless shell libraries and side-load libgbm in the VM"
```

### T4: 自己検査と K6 の警告

**Files:**

- 編集: `agent-vm/bootstrap.sh`（`verify_vm_config`、新関数 `report_browser_state`）
- テスト: `tests/agent-vm/run-bootstrap.sh`
- 参照: `agent-vm/bootstrap.sh:93-115`（`verify_vm_config`。フィルタより緩い条件で見て、fail-closed にする流儀）
- 参照: spec K6 の警告一覧（bootstrap の 3 行）

自己検査（fail-closed）と警告（失敗させない）を分ける。

- 自己検査: Claude に 2 エントリが残っているなら、`args` に `--headless` と `current/bin/headless_shell` が、`env` に `LD_LIBRARY_PATH` があること。Codex に `playwright` と `chrome-devtools` が無いこと（既存の Codex の検査が `VM_MCP_KEEP` で担う）。
- 警告: マウントが無い / `current/bin/headless_shell` が無い / ldd の欠け / `args[0]` の版と `current/.meta` の `mcp_version` の違い。

- [ ] **Step 1: 失敗するテストを書く**

```bash
test_self_check_catches_a_browser_entry_without_headless() {
  setup_vm_env; mkdir -p "$TMP_ROOT/browsers"; export AGENT_VM_BROWSERS_ROOT="$TMP_ROOT/browsers"
  place_generated_configs
  # Make the browser filter a no-op so the self-check sees the raw entry.
  cp "$REPO_ROOT/agent-vm/bootstrap.sh" "$TMP_ROOT/bootstrap.sh"; cp "$REPO_ROOT/agent-vm/"*.jq "$REPO_ROOT/agent-vm/"*.tmpl "$TMP_ROOT/"
  printf '.\n' >"$TMP_ROOT/vm-claude-browser.jq"
  local err; err=$(bash "$TMP_ROOT/bootstrap.sh" 1 v1:abc "$SRC" 2>&1 >/dev/null) || true
  assert_contains "$err" "browser MCP" "the self-check names the unconfigured browser entry"
  assert_status 1 "no hash recorded" -- test -e "$HOME/.local/state/agent-vm/applied-hash"
}
self_check_with_entry() { # jq expression applied after the browser filter; stderr goes to $TMP_ROOT/err. Called directly
  # (not inside $(...)) so setup_vm_env's HOME stays set for the caller's assertions.
  setup_vm_env; mkdir -p "$TMP_ROOT/browsers"; export AGENT_VM_BROWSERS_ROOT="$TMP_ROOT/browsers"; place_generated_configs
  cp "$REPO_ROOT/agent-vm/bootstrap.sh" "$TMP_ROOT/bootstrap.sh"; cp "$REPO_ROOT/agent-vm/"*.jq "$REPO_ROOT/agent-vm/"*.tmpl "$TMP_ROOT/"
  { cat "$REPO_ROOT/agent-vm/vm-claude-browser.jq"; printf '| %s\n' "$1"; } >"$TMP_ROOT/vm-claude-browser.jq"
  bash "$TMP_ROOT/bootstrap.sh" 1 v1:abc "$SRC" 2>"$TMP_ROOT/err" >/dev/null || true
}
test_self_check_catches_a_missing_ld_library_path() {
  self_check_with_entry 'del(.mcpServers.playwright.env.LD_LIBRARY_PATH)'
  assert_contains "$(cat "$TMP_ROOT/err")" "browser MCP" "missing LD_LIBRARY_PATH is caught"
  assert_status 1 "no hash recorded" -- test -e "$HOME/.local/state/agent-vm/applied-hash"
}
test_self_check_catches_a_wrong_executable_path() {
  self_check_with_entry '.mcpServers["chrome-devtools"].args[4] = "/usr/bin/chromium"'
  assert_contains "$(cat "$TMP_ROOT/err")" "browser MCP" "wrong executable path is caught"
  assert_status 1 "no hash recorded" -- test -e "$HOME/.local/state/agent-vm/applied-hash"
}
test_warns_on_missing_libraries() {
  setup_vm_env; mkdir -p "$TMP_ROOT/browsers/gen-x/bin"; export AGENT_VM_BROWSERS_ROOT="$TMP_ROOT/browsers"
  ln -s gen-x "$TMP_ROOT/browsers/current"; printf '#!/bin/sh\n' >"$TMP_ROOT/browsers/gen-x/bin/headless_shell"; chmod +x "$TMP_ROOT/browsers/gen-x/bin/headless_shell"
  local err; err=$(STUB_LDD_MISSING="libnss3.so" bash "$BOOTSTRAP" 1 v1:abc "$SRC" 2>&1 >/dev/null)
  assert_contains "$err" "missing libraries: libnss3.so" "a missing library is named"
}
test_warning_text_from_the_mount_is_sanitized() {
  setup_vm_env; place_generated_configs; export AGENT_VM_BROWSERS_ROOT="$TMP_ROOT/browsers"
  mkdir -p "$TMP_ROOT/browsers/gen-x/bin"; ln -s gen-x "$TMP_ROOT/browsers/current"
  printf '#!/bin/sh\n' >"$TMP_ROOT/browsers/gen-x/bin/headless_shell"; chmod +x "$TMP_ROOT/browsers/gen-x/bin/headless_shell"
  printf 'mcp_version=0.0.74\033[2J\n' >"$TMP_ROOT/browsers/gen-x/.meta"
  local err; err=$(bash "$BOOTSTRAP" 1 v1:abc "$SRC" 2>&1 >/dev/null)
  assert_not_contains "$err" $'\033' "no escape sequence from the VM-writable .meta reaches the terminal"
  assert_contains "$err" "(unreadable)" "an unsafe value is replaced"
}
test_warns_on_a_machine_without_the_mount() {
  setup_vm_env; export AGENT_VM_BROWSERS_ROOT="$TMP_ROOT/no-such-mount"
  local err; err=$(bash "$BOOTSTRAP" 1 v1:abc "$SRC" 2>&1 >/dev/null)
  assert_contains "$err" "agent-vm rm" "old machine: recovery is agent-vm rm"
  assert_contains "$err" "you lose" "the warning says what agent-vm rm loses"
}
test_warns_when_the_headless_shell_is_missing() {
  setup_vm_env; mkdir -p "$TMP_ROOT/browsers"; export AGENT_VM_BROWSERS_ROOT="$TMP_ROOT/browsers"
  local err; err=$(bash "$BOOTSTRAP" 1 v1:abc "$SRC" 2>&1 >/dev/null)
  assert_contains "$err" "agent-vm fetch-browsers" "no headless shell: recovery is fetch-browsers"
}
test_warns_when_mcp_version_and_store_differ() {
  setup_vm_env; place_generated_configs; export AGENT_VM_BROWSERS_ROOT="$TMP_ROOT/browsers"
  mkdir -p "$TMP_ROOT/browsers/gen-x/bin"; ln -s gen-x "$TMP_ROOT/browsers/current"
  printf '#!/bin/sh\n' >"$TMP_ROOT/browsers/gen-x/bin/headless_shell"; chmod +x "$TMP_ROOT/browsers/gen-x/bin/headless_shell"
  printf 'mcp_version=0.0.74\n' >"$TMP_ROOT/browsers/gen-x/.meta"
  local err; err=$(bash "$BOOTSTRAP" 1 v1:abc "$SRC" 2>&1 >/dev/null)
  assert_contains "$err" "0.0.75" "the warning names the MCP version"
  assert_contains "$err" "0.0.74" "the warning names the store version"
  assert_status 0 "an advisory warning does not block" -- test -e "$HOME/.local/state/agent-vm/applied-hash"
}
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run-bootstrap.sh`
期待: T4 で足したテスト（自己検査 3 件、警告 4 件、無害化 1 件）が FAIL。

- [ ] **Step 3: 最小実装を書く**

`verify_vm_config` の Claude の検査の後に足す。

```bash
    verdict=$(jq --arg exe "$BROWSERS_ROOT/current/bin/headless_shell" '[(.mcpServers // {}) | to_entries[]
      | select(.key == "playwright" or .key == "chrome-devtools")
      | select((.value.args | type) != "array" or (.value.args | index("--headless")) == null
               or (.value.args | index($exe)) == null or (.value.env.LD_LIBRARY_PATH // "") == "")]
      | length == 0' "$HOME/.claude.json") || verdict=""
    [[ "$verdict" == true ]] || fail "a browser MCP entry in ~/.claude.json is not configured for the VM headless shell; $recover"
```

```bash
safe_word() { # text from the VM-writable mount (ldd output, .meta) is shown only if it is a plain token
  if [[ "$1" =~ ^[0-9A-Za-z._+-]{1,64}$ ]]; then printf '%s' "$1"; else printf '(unreadable)'; fi
}
missing_libs() { # binary -> space-separated sonames ldd cannot resolve; captured first so pipefail cannot flip the test
  local out name list=""
  # ldd may run code from the binary; acceptable here: the binary sits in this VM's own copy, inside the VM boundary.
  out=$(LD_LIBRARY_PATH="$GBM_DIR" ldd "$1" 2>/dev/null) || true
  while read -r name _ rest; do
    [[ "$rest" == *"not found"* ]] && list="$list${list:+ }$(safe_word "$name")"
  done <<<"$out"
  printf '%s\n' "$list"
}
report_browser_state() { # spec K6: advisory only; .meta lives in a VM-writable mount, so it never drives a decision
  local exe="$BROWSERS_ROOT/current/bin/headless_shell" lib want have missing
  if [[ ! -d "$BROWSERS_ROOT" ]]; then
    warn "this machine has no browser mount (created before VM browser support); browser MCP servers are off."
    warn "to enable them: agent-vm rm, then launch again. you lose the VM-side logins (Claude, Codex) and tools installed inside the VM; the repo, session logs and env files stay."
    return 0
  fi
  if [[ ! -x "$exe" ]]; then
    warn "no headless shell at $exe; recover: agent-vm fetch-browsers on the host, then launch again"
    return 0
  fi
  for lib in "$exe" "$GBM_DIR/libgbm.so.1"; do
    [[ -e "$lib" ]] || continue
    missing=$(missing_libs "$lib")
    if [[ -n "$missing" ]]; then warn "$(basename "$lib") is missing libraries: $missing"; fi
  done
  want=$(jq -r '.mcpServers.playwright.args[0] // "" | sub("^@playwright/mcp@"; "")' "$HOME/.claude.json" 2>/dev/null) || want=""
  have=$(sed -n 's/^mcp_version=//p' "$BROWSERS_ROOT/current/.meta" 2>/dev/null | head -1) || have=""
  if [[ -n "$want" && -n "$have" && "$want" != "$have" ]]; then
    warn "playwright MCP is $(safe_word "$want") but the mounted browser is for $(safe_word "$have"); recover: chezmoi apply, agent-vm fetch-browsers"
  fi
}
```

`tests/agent-vm/stubs/ldd`（`chmod +x`。`run-bootstrap.sh` の `BOOTSTRAP_STUB_DIR` にリンクする）:

```bash
#!/usr/bin/env bash
# Test stub: reports each name in STUB_LDD_MISSING as unresolved, like ldd does; nothing else.
for n in ${STUB_LDD_MISSING:-}; do printf '\t%s => not found\n' "$n"; done
```

警告の文言は `safe_word` を通した値だけを含む。`test_warns_when_mcp_version_and_store_differ` の期待（`0.0.75` と `0.0.74` を含む）は、そのまま成り立つ。

本体の `verify_vm_config` の後、`applied-hash` を書く前に `report_browser_state` を呼ぶ。`fail` ではないので、`applied-hash` は書かれる。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run-bootstrap.sh`
期待: 全テスト PASS。

- [ ] **Step 5: コミット**

```bash
git add agent-vm/bootstrap.sh tests/agent-vm/run-bootstrap.sh tests/agent-vm/stubs/ldd
git commit -m "feat(agent-vm): self-check the VM browser MCP entries and report browser problems"
```

## ISO 25010 具体テストケース

### 機能適合性

- **入力**: マウントあり、fixture の `~/.claude.json`（`@playwright/mcp@0.0.75`、`chrome-devtools-mcp@0.25.0`） → **期待**: playwright の `args` が `["@playwright/mcp@0.0.75","--headless","--isolated","--executable-path","<root>/current/bin/headless_shell"]`、`env.LD_LIBRARY_PATH` が `$HOME/.local/lib/agent-vm-browser`（T2）。

### 互換性

- **入力**: 同じ `~/.claude.json` にフィルタを 2 回かける → **期待**: 1 回目とバイト単位で一致（T2）。
- **入力**: bootstrap の後の `~/.codex/config.toml` → **期待**: `playwright` の文字列を含まない（T1）。
- **入力**: マウントの無い machine → **期待**: Claude の `mcpServers` の keys が `["context7","excalidraw","readability"]`（T1）。

### 信頼性

- **入力**: `apt-get download libgbm1` が 100 で失敗 → **期待**: 警告に `libgbm` を含み、`applied-hash` は書かれる（T3）。
- **入力**: `current/.meta` の `mcp_version=0.0.74` と `args[0]` の `0.0.75` → **期待**: 両方の版を含む警告が出て、`applied-hash` は書かれる（T4）。
- **入力**: 2 エントリの一方に `--headless` が無い → **期待**: bootstrap は失敗し、`applied-hash` は書かれない（T4）。

### 性能効率（資源効率）

- **入力**: `VM_BROWSER_APT_PKGS` の内容 → **期待**: research F11 の 44 個（42 + フォント 2）と完全一致（T3）。実際の容量（35.1MB、上限 40MB）は plan-3 の実機検証で測る。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘:
  - 一覧を完全一致で確かめるテストが、複数行の配列を取り出せない。
  - `libgbm1` の assert が空振りしている。
  - fixture のキーが重複する。
  - context7 の期待値が実際の fixture と合わない。
  - `apt-get update` が無い。
  - libgbm に ldd をかけていない。
  - テストが実在の `/opt/agent-vm/browsers` に左右される。
- 対応: 反映した。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘:
  - libgbm に ldd をかけていない。
  - Depends を確かめた根拠を書いていない。
  - 44 と 48 の数の違いを説明していない。
  - `AGENT_VM_BROWSERS_ROOT` が後続のテストに漏れる。
  - spec R7 の開始条件が書かれていない。
- 対応: 反映した。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘:
  - `apt-get update` が走らない経路がある。
  - libgbm に ldd をかけていない。
  - `VM_MCP_KEEP` が Codex 専用であることを明記していない。
  - `args[0]` が null のとき、jq がごみを作る。
  - assert が空振りしている。
  - テストの既定のパス。
- 対応: 反映した。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘:
  - `ldd | grep` が pipefail で誤判定する。
  - マウントの文字列が警告に入り込む。
  - `candidate=$(...)` が失敗すると `set -e` で止まる。
  - update が無い。
  - `cp -P` が既存のファイルに上書きできない。
  - 一覧のテストの抽出が誤っている。
- 対応:
  - 出力を変数に取ってから判定する。
  - `safe_word` を通す。
  - `|| candidate=""` を足した。
  - 古い libgbm を消してから cp する。
  - 一覧は実際の挙動（dpkg の stub のログ）で比べる。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘:
  - fixture にすでに空のエントリがある。
  - `args[0]` が null の場合。
  - テストの既定のパス。
  - 自己検査のテストが 1 件しかない。
- 対応:
  - 空のエントリを置き換える。
  - jq でガードする。
  - `setup_vm_env` で既定を存在しないパスにする。
  - `LD_LIBRARY_PATH` の欠落と、パスの食い違いのテストを足した。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: needs-work
- 主指摘:
  - 自己検査のテストは、`$()` の中の `HOME` が親に届かないので空振りしている。
  - jq は、`args` が文字列のときにエントリを消す。
  - 自己検査の `index` が文字列の args を通してしまう。
  - 無害化を肯定の assert で確かめていない。
- 対応:
  - stderr をファイルに書き出す形にした。
  - 型を先に絞るようにした。
  - 配列であることを条件に足した。
  - `(unreadable)` の assert を足した。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘:
  - `apt-get update` を自前で走らせる点が spec K5 と食い違う。
  - ldd の stub がコミットに含まれていない。
  - テスト数の記述が合っていない。
- 対応:
  - spec との差分であることを明記した。
  - ldd の stub を T4 のコミットに加えた。
  - テスト数を直した。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: low のみ。
  - `libgbm.so.1` の存在も判定に入れる。
  - stub の数の記述。
  - fail-closed で止める条件を明記する。
  - 判定の存在確認は反映した。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘:
  - 自己検査のテストの `HOME`。
  - テスト数の記述。
  - aarch64 が固定であること。
  - stub のブロックが分かれていない。
- 対応:
  - 自己検査のテストを書き直した。
  - aarch64 を定数とコメントにした。
  - stub をファイルごとのブロックに分け、ldd の実体を書いた。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘:
  - 自己検査のテストで `HOME` を正しく扱えていない。
  - libgbm の差し替えが途中で失敗すると、`.version` が残ったまま固まる。
  - テスト数の記述が実態と合っていない。
- 対応:
  - `.version` も一緒に消すようにした。
  - ファイルの存在の判定を足した。
  - 取り直しのテストを足した。

<!-- auto-review: verdict=needs-work; hash=e0f263e2bc859c97950ed8c0ae818c58befb074cba0cb7d37d4bb7a230da57b0; design-hash=7b4dac226f3e6e06f8eecbabe7450d5d508286eed607bfe0b8c2820a7717c11c; round=1; parent-spec-hash=369753b259efd4af68a6cd5c35a37403650a06f3b5b674095f0604ad41711fa3; at=2026-10-01T13:56:24.432Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=30; excluded=0; at=2026-10-01T13:56:24.487Z -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: pass
- 主指摘: low のみ。
  - T3 で FAIL するのは 6 件（記述を直した）。
  - 自己検査は `LD_LIBRARY_PATH` の値までは見ない（T2 のテストが値を確かめている）。
  - stub が `run.sh` の PATH にも入るが、launcher は呼ばないので影響しない。

### scope-justification-reviewer
- verdict: pass
- 主指摘: low のみ。
  - 警告のテストの件数（4 件に直した）。
  - spec K5 との差分は、plan-3 で ADR に書く。
  - libgbm の Depends は、plan-3 の実機の ldd で閉じる。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: low のみ。
  - apt の失敗の警告に `recover:` が無い。
  - ldd の警告が 2 行出る。
  - stub の数の説明。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: low のみ。
  - ldd は VM の境界の内側で動く。
  - libgbm1 の Depends は実機で確かめる。
  - `.version` には候補版を記録する。

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: low のみ。
  - 帳簿の状態。
  - 一覧の完全一致テストは成立している。
  - 自己検査のテストは空振りしていない。

<!-- auto-review: verdict=needs-work; hash=5f905b920a558032ab795b84e472cadd85749b1d7050125cb2d3440d651c04ea; design-hash=539dfaaec6801a5834815991e1fa2bce25ce086759f2ef192e8e86d9ef27166b; round=2; parent-spec-hash=369753b259efd4af68a6cd5c35a37403650a06f3b5b674095f0604ad41711fa3; at=2026-10-01T14:01:30.596Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=16; excluded=0; at=2026-10-01T14:01:30.650Z -->

<!-- auto-review: verdict=pass; hash=da2ebe700e429c87300636075b51c0630cf18b13555bac1d9c6d8f56a4825a91; design-hash=a87dc2408782f77b03e1a48185770f36ff0b26b3c16f17892ae24b06495d4217; round=3; parent-spec-hash=369753b259efd4af68a6cd5c35a37403650a06f3b5b674095f0604ad41711fa3; at=2026-10-01T14:22:56.371Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=5; excluded=0; at=2026-10-01T14:22:56.411Z -->
