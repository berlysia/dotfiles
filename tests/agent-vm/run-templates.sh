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
# run_after_00-install-mise-tools runs on every apply, so safe-chain is the only mise-hash-gated script.
test_install_scripts_hash_the_rendered_template() {
  local s=.chezmoiscripts/run_onchange_after_install-safe-chain.sh.tmpl
  if [[ "$(hash_line "$s" '{"agent_vm":true}')" != "$(hash_line "$s" '{"agent_vm":false}')" ]]; then
    record "PASS $s re-runs when the rendered mise config differs"
  else
    record "FAIL $s re-runs when the rendered mise config differs"
  fi
}
test_host_render_equals_template_without_vm_guards() {
  # The VM-only guards must be the template's only markup: removing their lines has to give exactly the
  # host render. This needs no git history (CI checkouts are shallow) and keeps holding as the list evolves.
  local stripped
  stripped=$(grep -v -E '^\{\{-? (if not \(dig "agent_vm" false \.\)|end) -?\}\}$' "$SRC/dot_config/mise/config.toml.tmpl")
  assert_eq "$stripped" "$(render dot_config/mise/config.toml.tmpl '{"agent_vm":false}')" "hosts see no change"
}

# .chezmoiignore matches target paths, not source names: `dot_local/bin/executable_agent-vm` would never match.
test_ignore_excludes_launcher_off_darwin_by_target_path() {
  local out; out=$(render .chezmoiignore '{"chezmoi":{"os":"linux"}}')
  out=$'\n'"$out"$'\n' # line-anchor both ends ($(...) strips the final newline)
  assert_contains "$out" $'\n.local/bin/agent-vm\n' "launcher ignored by its target path"
  assert_contains "$out" $'\n.config/agent-vm\n' "launcher config ignored by its target path"
  assert_not_contains "$(render .chezmoiignore '{"chezmoi":{"os":"darwin"}}')" ".local/bin/agent-vm" "deployed on macOS"
}
for t in $(declare -F | awk '{print $3}' | grep '^test_'); do
  ( "$t" ) </dev/null || record "FAIL $t (test aborted)"
done
failed=$(grep -c '^FAIL' "$RESULTS_FILE" || true)
grep '^FAIL' "$RESULTS_FILE" || true
printf '%d run, %d failed\n' "$(wc -l <"$RESULTS_FILE" | tr -d ' ')" "$failed"
[[ "$failed" -eq 0 ]]
