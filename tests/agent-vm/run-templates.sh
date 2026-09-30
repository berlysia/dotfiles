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
MISE_SHARED="$SRC/dot_config/mise/config.toml"
MISE_HOST_ONLY="$SRC/dot_config/mise/conf.d/host-toolchains.toml"
# Tests run as `( "$t" ) || record ...`, where set -e does not fire, so a missing file would only give an
# empty string and let the negative assertions pass. Each test checks existence first.
require_file() { [[ -s "$1" ]] || { record "FAIL missing or empty ${1#"$SRC"/}"; return 1; }; }
# Renovate's mise manager parses these files as strict TOML, so they must stay free of template markup.
test_mise_files_are_plain_toml() {
  local f
  for f in "$MISE_SHARED" "$MISE_HOST_ONLY"; do
    require_file "$f" || continue
    assert_not_contains "$(cat "$f")" '{{' "no template markup in ${f#"$SRC"/}"
  done
}
test_mise_shared_set_has_no_host_toolchains() {
  require_file "$MISE_SHARED" || return 0
  local out; out=$(cat "$MISE_SHARED")
  assert_not_contains "$out" $'\nrust = ' "rust lives in conf.d/host-toolchains.toml"
  assert_not_contains "$out" $'\ngo = ' "go lives in conf.d/host-toolchains.toml"
  assert_not_contains "$out" '"cargo:' "cargo backend tools live in conf.d/host-toolchains.toml"
  assert_not_contains "$out" '"go:' "go backend tools live in conf.d/host-toolchains.toml"
  assert_contains "$out" $'\nnode = ' "node stays in the shared set"
  assert_contains "$out" '"npm:@openai/codex"' "codex stays in the shared set"
  assert_contains "$out" '"github:microsoft/apm"' "apm stays in the shared set (the VM installs skills)"
  # run_onchange_after_install-safe-chain hashes only config.toml (spec K7)
  assert_contains "$out" '"github:AikidoSec/safe-chain"' "safe-chain stays in config.toml"
}
test_mise_host_only_file_holds_only_toolchain_bound_tools() {
  local keys bad
  require_file "$MISE_HOST_ONLY" || return 0
  keys=$(awk -F' = ' '/^[^#[][^=]* = /{print $1}' "$MISE_HOST_ONLY")
  assert_contains $'\n'"$keys"$'\n' $'\nrust\n' "host-only file declares rust"
  assert_contains $'\n'"$keys"$'\n' $'\ngo\n' "host-only file declares go"
  bad=$(printf '%s\n' "$keys" | grep -vxE 'go|rust|"cargo:[^"]+"|"go:[^"]+"' || true)
  assert_eq "" "$bad" "conf.d/host-toolchains.toml declares only go, rust and cargo:/go: backend tools"
}
test_install_scripts_hash_the_shared_mise_config() {
  assert_contains "$(cat "$SRC/.chezmoiscripts/run_onchange_after_install-safe-chain.sh.tmpl")" \
    'include "dot_config/mise/config.toml" | sha256sum' "safe-chain re-runs when config.toml changes"
}

# .chezmoiignore matches target paths, not source names: `dot_local/bin/executable_agent-vm` would never match.
test_ignore_excludes_launcher_off_darwin_by_target_path() {
  local out; out=$(render .chezmoiignore '{"chezmoi":{"os":"linux"}}')
  out=$'\n'"$out"$'\n' # line-anchor both ends ($(...) strips the final newline)
  assert_contains "$out" $'\n.local/bin/agent-vm\n' "launcher ignored by its target path"
  assert_contains "$out" $'\n.config/agent-vm\n' "launcher config ignored by its target path"
  assert_not_contains "$(render .chezmoiignore '{"chezmoi":{"os":"darwin"}}')" ".local/bin/agent-vm" "deployed on macOS"
}
VM_DATA='{"agent_vm":true,"chezmoi":{"os":"linux","kernel":{"osrelease":"6.8.0-orbstack"}}}'
HOST_LINUX='{"agent_vm":false,"chezmoi":{"os":"linux","kernel":{"osrelease":"6.8.0"}}}'
managed_as() { # override_data_json -> sorted target paths chezmoi would manage (isolated config/state, no fetches)
  chezmoi managed --source "$SRC" --destination "$TMP_BASE/dst" --config "$TMP_BASE/chezmoi.toml" \
    --cache "$TMP_BASE/cache" --persistent-state "$TMP_BASE/state.boltdb" --refresh-externals=never \
    --include all --override-data "$1" | LC_ALL=C sort
}
# Collapses everything under a fixture root written as `<dir>/**` to that one line, so the fixture keeps the
# allowlist's granularity and adding a file under ~/.claude does not require touching it (spec K20).
collapse_to_fixture_roots() { # fixture_path (managed list on stdin)
  awk -v fx="$1" 'BEGIN { while ((getline l < fx) > 0) if (l ~ /\/\*\*$/) roots[substr(l, 1, length(l) - 3)] = 1 }
    { out = $0; for (r in roots) if (index($0, r "/") == 1) out = r "/**"; print out }' | LC_ALL=C sort -u
}
test_host_toolchains_are_host_only() {
  local vm host
  vm=$'\n'"$(managed_as "$VM_DATA")"$'\n'
  host=$'\n'"$(managed_as "$HOST_LINUX")"$'\n'
  assert_contains "$vm" $'\n.config/mise/config.toml\n' "the VM gets the shared mise config"
  assert_not_contains "$vm" '.config/mise/conf.d' "the VM gets no conf.d (no rust/go toolchains)"
  assert_contains "$host" $'\n.config/mise/config.toml\n' "hosts get the shared mise config"
  assert_contains "$host" $'\n.config/mise/conf.d/host-toolchains.toml\n' "hosts get the host toolchains"
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

# chezmoi runs after-band scripts (run_after_*, run_onchange_after_*, ...) after all files, in target-name order.
after_band_targets() { # target names of the after-band scripts in the source, in the order chezmoi runs them
  local f
  for f in "$SRC"/.chezmoiscripts/run_*after_*; do
    f=${f##*/}; f=${f%.tmpl}; f=${f#run_}; f=${f#once_}; f=${f#onchange_}; f=${f#after_}
    printf '%s\n' "$f"
  done | LC_ALL=C sort
}
test_skills_install_runs_after_mise_tools_and_before_sync() {
  local order; order=$(after_band_targets | grep -xE '00-install-mise-tools\.sh|10-install-apm-skills\.sh|sync-skills\.sh' | paste -sd' ' -)
  assert_eq "00-install-mise-tools.sh 10-install-apm-skills.sh sync-skills.sh" "$order" "apm is installed before skills, skills before sync"
}

for t in $(declare -F | awk '{print $3}' | grep '^test_'); do
  ( "$t" ) </dev/null || record "FAIL $t (test aborted)"
done
failed=$(grep -c '^FAIL' "$RESULTS_FILE" || true)
grep '^FAIL' "$RESULTS_FILE" || true
printf '%d run, %d failed\n' "$(wc -l <"$RESULTS_FILE" | tr -d ' ')" "$failed"
[[ "$failed" -eq 0 ]]
