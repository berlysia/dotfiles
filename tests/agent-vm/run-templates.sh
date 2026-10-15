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
  # Line-anchored: ".local/bin/agent-vm-node-modules" is legitimately ignored on every non-VM host.
  assert_not_contains $'\n'"$(render .chezmoiignore '{"chezmoi":{"os":"darwin"}}')"$'\n' $'\n.local/bin/agent-vm\n' "deployed on macOS"
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
test_node_modules_helper_is_vm_only() {
  local vm host
  vm=$'\n'"$(managed_as "$VM_DATA")"$'\n'
  host=$'\n'"$(managed_as "$HOST_LINUX")"$'\n'
  assert_contains "$vm" $'\n.local/bin/agent-vm-node-modules\n' "the VM gets the node_modules helper"
  assert_not_contains "$host" $'\n.local/bin/agent-vm-node-modules\n' "hosts do not get the node_modules helper"
}
test_host_still_manages_host_only_targets() {
  local out; out=$(managed_as "$HOST_LINUX")
  assert_contains "$out" ".chezmoiscripts/gc.sh" "hosts keep host-only scripts"
  assert_contains "$out" ".config/emacs" "hosts keep host-only files"
}
test_vm_removes_the_old_codex_merge_script() {
  local dst="$TMP_BASE/dst-remove"
  mkdir -p "$dst/.codex"; touch "$dst/.codex/.merge-config.ts"
  local out; out=$(chezmoi managed --source "$SRC" --destination "$dst" --config "$TMP_BASE/chezmoi.toml" \
    --cache "$TMP_BASE/cache" --persistent-state "$TMP_BASE/state-remove.boltdb" --refresh-externals=never \
    --include remove --override-data "$VM_DATA")
  assert_contains "$out" ".codex/.merge-config.ts" "the VM removes the old codex merge script (not ignored)"
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

test_fetch_browsers_script_is_darwin_only() {
  local t=.chezmoiscripts/run_after_50-agent-vm-fetch-browsers.sh.tmpl
  assert_eq "" "$(render "$t" '{"chezmoi":{"os":"linux"}}' | tr -d '[:space:]')" "renders empty on linux"
  assert_contains "$(render "$t" '{"chezmoi":{"os":"darwin"}}')" "agent-vm\" fetch-browsers" "renders the fetch on darwin"
}

# claude-recall plugin pin: Renovate's customManager rewrites the version and sha256 lines of the external, and
# the checks below keep that wiring, the pinned tarball and the merge gate from drifting apart silently.
RENOVATE_JSON="$REPO_ROOT/renovate.json"
EXTERNAL_TMPL="$SRC/.chezmoiexternal.toml.tmpl"
# Applies the customManager's matchString to the template source the way Renovate does (a RegExp here, RE2 there;
# lookaround and backreferences are rejected so the two agree). Prints `ERR <reason>` lines, or `PIN <version> <sha256>`.
recall_pin_probe() { # renovate_json external_tmpl mise_config
  node - "$1" "$2" "$3" <<'JS'
const fs = require("node:fs");
const [renovatePath, tmplPath, misePath] = process.argv.slice(2);
const err = (m) => console.log(`ERR ${m}`);
const cfg = JSON.parse(fs.readFileSync(renovatePath, "utf8"));
const mgrs = (cfg.customManagers || []).filter((m) => m.depNameTemplate === "claude-recall-plugin");
if (mgrs.length !== 1) { err(`expected exactly 1 customManager for claude-recall-plugin, found ${mgrs.length}`); process.exit(0); }
const m = mgrs[0];
const target = "home/.chezmoiexternal.toml.tmpl";
const patternHits = (m.managerFilePatterns || []).some((p) => {
  const body = /^\/(.*)\/$/.exec(p);
  return body ? new RegExp(body[1]).test(target) : p === target;
});
if (!patternHits) err(`managerFilePatterns does not match ${target}`);
if (m.packageNameTemplate !== "babarot/claude-recall") err(`packageNameTemplate is ${m.packageNameTemplate}`);
if (m.datasourceTemplate !== "github-release-attachments") err(`datasourceTemplate is ${m.datasourceTemplate}`);
if (!Array.isArray(m.matchStrings) || m.matchStrings.length !== 1) { err("expected exactly 1 matchString"); process.exit(0); }
const source = m.matchStrings[0];
if (/\(\?[=!]|\(\?<[=!]|\\[1-9]/.test(source)) err("matchString uses lookaround or a backreference (RE2 differs from RegExp)");
const matches = [...fs.readFileSync(tmplPath, "utf8").matchAll(new RegExp(source, "gm"))];
if (matches.length !== 1) { err(`matchString matched ${matches.length} times in the template, expected 1`); process.exit(0); }
const { currentValue, currentDigest } = matches[0].groups || {};
if (!/^[0-9a-f]{64}$/.test(currentDigest || "")) err(`currentDigest is not 64 lowercase hex: ${currentDigest}`);
const mise = /"github:babarot\/claude-recall"\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/.exec(fs.readFileSync(misePath, "utf8"));
if (!mise) err("mise entry for github:babarot/claude-recall not found");
else if (mise[1] !== currentValue) err(`currentValue ${currentValue} differs from the mise version ${mise[1]}`);
console.log(`PIN ${currentValue} ${currentDigest}`);
JS
}
test_renovate_regex_extracts_recall_plugin_pin() {
  require_file "$RENOVATE_JSON" || return 0
  require_file "$EXTERNAL_TMPL" || return 0
  command -v node >/dev/null || { record "FAIL renovate customManager check needs node"; return 0; }
  local out line bad=0
  out=$(recall_pin_probe "$RENOVATE_JSON" "$EXTERNAL_TMPL" "$MISE_SHARED" 2>&1) || out="ERR probe crashed: $out"
  while IFS= read -r line; do
    case "$line" in ERR*) record "FAIL renovate customManager for the claude-recall plugin pin (${line#ERR })"; bad=1 ;; esac
  done <<<"$out"
  [[ "$bad" -eq 0 ]] && record "PASS renovate customManager extracts the claude-recall plugin version and sha256"
  return 0
}
# Without these, Renovate would still open the PR but the two deps could pick different versions (the 7 day wait
# is a mise-only rule) or the PR could merge itself.
test_renovate_recall_rule_keeps_the_merge_gate_and_the_wait() {
  require_file "$RENOVATE_JSON" || return 0
  command -v node >/dev/null || { record "FAIL renovate rule check needs node"; return 0; }
  local out line bad=0
  out=$(node - "$RENOVATE_JSON" <<'JS' 2>&1
const fs = require("node:fs");
const err = (m) => console.log(`ERR ${m}`);
const rules = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).packageRules || [];
const recall = rules.filter((r) => r.groupName === "claude-recall");
if (recall.length !== 1) { err(`expected exactly 1 claude-recall rule, found ${recall.length}`); process.exit(0); }
const miseWait = rules.filter((r) => JSON.stringify(r.matchManagers) === '["mise"]' && r.minimumReleaseAge !== undefined);
if (miseWait.length !== 1) { err(`expected exactly 1 mise rule with minimumReleaseAge, found ${miseWait.length}`); process.exit(0); }
const r = recall[0];
if (r.automerge !== false) err("claude-recall rule must set automerge: false");
if (r.minimumReleaseAge === undefined || r.minimumReleaseAge !== miseWait[0].minimumReleaseAge) err(`claude-recall minimumReleaseAge (${r.minimumReleaseAge}) must equal the mise rule's (${miseWait[0].minimumReleaseAge})`);
if (typeof r.prBodyNotes === "undefined" || (Array.isArray(r.prBodyNotes) && r.prBodyNotes.length === 0)) err("claude-recall rule must set prBodyNotes");
const matchers = [];
for (const p of r.matchPackageNames || []) {
  if (p.startsWith("!") || p.includes("*") && !/^\/.*\/$/.test(p)) { err(`unsupported matchPackageNames pattern: ${p}`); continue; }
  const body = /^\/(.*)\/$/.exec(p);
  matchers.push(body ? (n) => new RegExp(body[1]).test(n) : (n) => n === p);
}
for (const name of ["github:babarot/claude-recall", "claude-recall-plugin"]) {
  if (!matchers.some((f) => f(name))) err(`matchPackageNames does not match ${name}`);
}
JS
) || out="ERR probe crashed: $out"
  while IFS= read -r line; do
    case "$line" in ERR*) record "FAIL renovate claude-recall rule (${line#ERR })"; bad=1 ;; esac
  done <<<"$out"
  [[ "$bad" -eq 0 ]] && record "PASS renovate claude-recall rule keeps automerge off, the shared wait and covers both deps"
  return 0
}
# Fresh cache and state so the archive is always downloaded and its checksum verified, even when other tests
# already filled the shared cache. Fetch failures are FAILs on purpose: a skipped check pins nothing.
test_recall_plugin_tarball_matches_pinned_sha256() {
  local dir="$TMP_BASE/recall-tarball" out err status=0
  mkdir -p "$dir"
  out=$(chezmoi managed --source "$SRC" --destination "$dir/dst" --config "$dir/chezmoi.toml" \
    --cache "$dir/cache" --persistent-state "$dir/state.boltdb" --refresh-externals=never \
    --include externals --override-data "$HOST_LINUX" 2>"$dir/stderr") || status=$?
  err=$(head -c 400 "$dir/stderr")
  if [[ "$status" -eq 0 && "$out" == *".claude/skills/claude-recall"* ]]; then
    record "PASS the pinned claude-recall plugin tarball downloads and matches its sha256"
  elif [[ "$err" == *"SHA256 mismatch"* ]]; then
    record "FAIL claude-recall plugin tarball differs from the pinned sha256 (the sha256 in .chezmoiexternal.toml.tmpl does not match the release asset): $err"
  else
    record "FAIL could not fetch the claude-recall plugin tarball (network or rate limit, exit $status): $err"
  fi
}
# Renovate falls back to hashing the downloaded asset when it cannot find the current digest in checksums.txt,
# so a pin written by Renovate is not proof that upstream published it. Compare with what upstream published.
test_recall_plugin_sha256_is_listed_in_upstream_checksums() {
  local version sha sums listed
  require_file "$EXTERNAL_TMPL" || return 0
  # Read with its own pattern, not the customManager's: this check must hold even when the customManager is wrong.
  version=$(sed -nE 's/^\{\{- [$]recallPluginVersion := "([^"]+)" \}\}$/\1/p' "$EXTERNAL_TMPL")
  sha=$(sed -nE 's/^\{\{- [$]recallPluginSha256 := "([0-9a-f]{64})" \}\}$/\1/p' "$EXTERNAL_TMPL")
  if [[ -z "$version" || -z "$sha" ]]; then record "FAIL could not read the pinned claude-recall version and sha256 from the template"; return 0; fi
  if ! sums=$(curl -fsSL --max-time 30 "https://github.com/babarot/claude-recall/releases/download/$version/checksums.txt" 2>&1); then
    record "FAIL could not fetch checksums.txt for claude-recall $version (network or rate limit): ${sums:0:200}"; return 0
  fi
  listed=$(awk '$2 == "claude-recall-plugin.tar.gz" {print $1}' <<<"$sums")
  if [[ "$listed" == "$sha" ]]; then
    record "PASS the pinned claude-recall plugin sha256 is the one upstream lists in checksums.txt for $version"
  else
    record "FAIL the pinned claude-recall plugin sha256 differs from upstream checksums.txt for $version (pinned: $sha / upstream: ${listed:-no claude-recall-plugin.tar.gz line})"
  fi
}
# The guard compares the mise version and the template version as strings. Both sides must carry the upstream tag
# verbatim (Renovate writes the tag as-is), so a `v` on one side only has to stop the apply.
test_recall_guard_accepts_matching_tags_and_rejects_mixed_ones() {
  local n=0 mise_v tmpl_v expect dir out status
  while read -r mise_v tmpl_v expect; do
    n=$((n + 1)); dir="$TMP_BASE/guard-$n"
    mkdir -p "$dir"; (cd "$SRC" && tar cf - --exclude=node_modules .) | tar xf - -C "$dir" # node_modules holds dangling workspace links
    sed -E '/"github:babarot\/claude-recall"/ s/version = "[^"]*"/version = "'"$mise_v"'"/' "$dir/dot_config/mise/config.toml" >"$dir/mise.new" && mv "$dir/mise.new" "$dir/dot_config/mise/config.toml"
    sed -E 's/([$]recallPluginVersion := ")[^"]*(")/\1'"$tmpl_v"'\2/' "$dir/.chezmoiexternal.toml.tmpl" >"$dir/ext.new" && mv "$dir/ext.new" "$dir/.chezmoiexternal.toml.tmpl"
    if ! grep -qF "version = \"$mise_v\"" "$dir/dot_config/mise/config.toml" || ! grep -qF "\$recallPluginVersion := \"$tmpl_v\"" "$dir/.chezmoiexternal.toml.tmpl"; then
      record "FAIL guard case mise=$mise_v template=$tmpl_v: rewriting the versions failed"; continue
    fi
    status=0
    out=$(chezmoi execute-template --source "$dir" --override-data "$HOST_LINUX" <"$dir/.chezmoiexternal.toml.tmpl" 2>&1) || status=$?
    if [[ "$expect" == ok ]]; then
      assert_eq "0" "$status" "guard accepts mise=$mise_v template=$tmpl_v"
    else
      assert_eq "1" "$status" "guard rejects mise=$mise_v template=$tmpl_v"
      assert_contains "$out" "claude-recall: mise pins" "guard names the mismatch for mise=$mise_v template=$tmpl_v"
    fi
  done <<'CASES'
v1.8.2 v1.8.2 ok
1.8.2 v1.8.2 reject
v1.8.2 1.8.2 reject
CASES
}

for t in $(declare -F | awk '{print $3}' | grep '^test_'); do
  ( "$t" ) </dev/null || record "FAIL $t (test aborted)"
done
failed=$(grep -c '^FAIL' "$RESULTS_FILE" || true)
grep '^FAIL' "$RESULTS_FILE" || true
printf '%d run, %d failed\n' "$(wc -l <"$RESULTS_FILE" | tr -d ' ')" "$failed"
[[ "$failed" -eq 0 ]]
