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
  assert_contains "$out" $'\napm = ' "apm stays in the shared set (the VM installs skills)"
  # run_onchange_after_install-safe-chain hashes only config.toml (spec K7)
  assert_contains "$out" '"github:AikidoSec/safe-chain"' "safe-chain stays in config.toml"
  # lint-actions.yml reads this line with sed and the claude-action-bootstrap skill relies on the tool in other repos
  assert_contains "$out" '"github:jdx/jactionlint" = "' "jactionlint stays in the shared set (host and agent-vm)"
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

# tla2tools.jar external: the pin is read from the rendered template, so the checks follow a version bump. The
# real-fetch check below needs the network and runs here only (CI does not run this file).
FORMAL_CHECK_JAR=".config/formal-check/tla2tools.jar"
jar_external_block() { # override_data_json -> the jar's table body from the rendered external, or nothing
  render .chezmoiexternal.toml.tmpl "$1" 2>/dev/null \
    | awk -v h="[\"$FORMAL_CHECK_JAR\"]" '$0 == h {on = 1; next} /^\[/ {on = 0} on {print}'
}
test_tla2tools_external_is_pinned_on_linux_and_absent_on_windows() {
  local linux windows url sha
  linux=$(jar_external_block "$HOST_LINUX")
  url=$(sed -nE 's/^url = "(.*)"$/\1/p' <<<"$linux")
  sha=$(sed -nE 's/^checksum\.sha256 = "(.*)"$/\1/p' <<<"$linux")
  case "$url" in
    https://github.com/tlaplus/tlaplus/releases/download/v*/tla2tools.jar) record "PASS jar url is the tlaplus release asset, ending in /tla2tools.jar" ;;
    *) record "FAIL jar url is ${url:-missing}" ;;
  esac
  if [[ "$sha" =~ ^[0-9a-f]{64}$ ]]; then record "PASS jar checksum is 64 lowercase hex"; else record "FAIL jar checksum is '${sha:-missing}'"; fi
  assert_not_contains "$linux" "refreshPeriod" "jar has no refreshPeriod (fetched once, then served from cache)"
  windows=$(jar_external_block '{"chezmoi":{"os":"windows"}}')
  assert_eq "" "$windows" "no jar entry on windows"
}
test_agent_vm_manages_no_formal_check_runtime() {
  local vm; vm=$'\n'"$(managed_as "$VM_DATA")"$'\n'
  assert_not_contains "$vm" '.config/formal-check' "the VM gets no formal-check dir or jar"
  assert_not_contains "$vm" $'\n.chezmoiscripts/10-install-formal-check-deps.sh\n' "the VM gets no formal-check installer"
}
# Fetches the jar the way a user's apply does (fresh cache and state, so chezmoi always verifies the checksum) and
# compares the bytes with the pin. A version bump of the jar is checked here, not in CI: run this before raising it.
test_tla2tools_jar_matches_pinned_sha256() {
  local dir="$TMP_BASE/tla-jar" status=0 sha actual err
  mkdir -p "$dir"
  sha=$(jar_external_block "$HOST_LINUX" | sed -nE 's/^checksum\.sha256 = "(.*)"$/\1/p')
  [[ -n "$sha" ]] || { record "FAIL could not read the jar sha256 from the rendered external"; return 0; }
  chezmoi cat --source "$SRC" --destination "$dir/dst" --config "$dir/chezmoi.toml" --cache "$dir/cache" \
    --persistent-state "$dir/state.boltdb" --override-data "$HOST_LINUX" "$dir/dst/$FORMAL_CHECK_JAR" \
    >"$dir/tla2tools.jar" 2>"$dir/stderr" || status=$?
  err=$(head -c 400 "$dir/stderr")
  if [[ "$status" -ne 0 ]]; then
    if [[ "$err" == *"SHA256 mismatch"* ]]; then record "FAIL tla2tools.jar differs from the pinned sha256: $err"
    else record "FAIL could not fetch tla2tools.jar (network or rate limit, exit $status): $err"; fi
    return 0
  fi
  actual=$(sha256_of "$dir/tla2tools.jar")
  assert_eq "$sha" "$actual" "tla2tools.jar downloads and matches its pinned sha256"
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
# The layout test compares chezmoi's result with the file list of the pinned tarball itself, so an upstream
# change of the layout (files added, dropped or renamed) does not fail it. A wrong stripComponents or a change
# in chezmoi's tar handling still does: that is what drops .mcp.json or shifts files one level up without any error.
# The expected set comes from the tarball (fetched with curl, bytes checked against the pinned sha256) and not
# from chezmoi's cache: the cache key is chezmoi's internal format, and depending on it is the same fragility
# that e251f54e removed.
# This test does not vouch for what the tarball contains (hook commands, the .mcp.json launch command, what
# register.tsx does). That stays with the human who merges the automerge-off Renovate PR.
RECALL_DIR=.claude/skills/claude-recall
# This repo depends on these three paths: the recall MCP server is declared in .mcp.json, the SessionEnd import
# hook and its modules in hooks/hooks.json, and Claude Code recognises the directory as a plugin by
# .claude-plugin/plugin.json. They must exist in the tarball and in the extracted result.
RECALL_REQUIRED_FILES=".claude-plugin/plugin.json .mcp.json hooks/hooks.json"
# Prints the paths chezmoi should place for the regular files of a tar listing (leading ./ removed, under
# $RECALL_DIR), or fails with the reason on stderr. Takes `tar -t` and `tar -tv` of the same archive: the type is
# the first character of the -tv line, the name comes from the -t line of the same number (-tv adds link targets
# to the name). Only the first character is read because GNU tar and bsdtar format the rest differently.
# Entries that are not regular files or directories, absolute names and `..` elements fail instead of being
# dropped, so a tarball cannot silently hide an entry from the comparison.
recall_expected_paths() { # tar_t_listing tar_tv_listing
  local names=$1 verbose=$2 name line type rel out="" n_names n_verbose
  n_names=$(printf '%s\n' "$names" | awk 'END{print NR}')
  n_verbose=$(printf '%s\n' "$verbose" | awk 'END{print NR}')
  if [[ "$n_names" != "$n_verbose" ]]; then
    printf 'tar -t has %s lines but tar -tv has %s (a name with a newline?)\n' "$n_names" "$n_verbose" >&2; return 1
  fi
  while IFS= read -r name <&3 && IFS= read -r line <&4; do
    case "$name" in /*) printf 'absolute path in the tarball: %s\n' "$name" >&2; return 1 ;; esac
    case "/$name/" in */../*) printf 'path with a .. element in the tarball: %s\n' "$name" >&2; return 1 ;; esac
    type=${line:0:1}
    case "$type" in
      d) continue ;;
      -) ;;
      *) printf "tarball entry that is neither a regular file nor a directory (type '%s'): %s\n" "$type" "$name" >&2; return 1 ;;
    esac
    rel=${name#./}
    out+="$RECALL_DIR/$rel"$'\n'
  done 3<<<"$names" 4<<<"$verbose"
  if [[ -z "$out" ]]; then printf 'the tarball holds no regular files\n' >&2; return 1; fi
  printf '%s' "$out"
}
# Prints one line per side that lacks required files (nothing when all are present). Takes the tarball's files
# (before .chezmoiignore) and the actual set (chezmoi's result), both as lists of paths under $RECALL_DIR.
recall_required_report() { # expected_paths actual_paths
  local f missing_tar="" missing_out=""
  for f in $RECALL_REQUIRED_FILES; do
    grep -qxF -- "$RECALL_DIR/$f" <<<"$1" || missing_tar+=" $f"
    grep -qxF -- "$RECALL_DIR/$f" <<<"$2" || missing_out+=" $f"
  done
  [[ -z "$missing_tar" ]] || printf 'claude-recall plugin tarball lacks required file(s):%s. Upstream dropped it; check that the plugin still works without it and revisit RECALL_REQUIRED_FILES in tests/agent-vm/run-templates.sh\n' "$missing_tar"
  [[ -z "$missing_out" ]] || printf 'chezmoi did not place required claude-recall file(s):%s (extraction or ignore error: check stripComponents in .chezmoiexternal.toml.tmpl, the chezmoi version and .chezmoiignore)\n' "$missing_out"
}
sha256_of() { # file
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
# Fresh cache and state so the archive is always downloaded and its checksum verified, even when other tests
# already filled the shared cache. Fetch failures are FAILs on purpose: a skipped check pins nothing.
test_recall_plugin_tarball_matches_pinned_sha256() {
  local dir="$TMP_BASE/recall-tarball" out err status=0 actual missing extra url sha tar_t tar_tv expected tarball_files ignored reason line
  local -a chezmoi_args
  mkdir -p "$dir"
  chezmoi_args=(--source "$SRC" --destination "$dir/dst" --config "$dir/chezmoi.toml"
    --cache "$dir/cache" --persistent-state "$dir/state.boltdb" --refresh-externals=never --override-data "$HOST_LINUX")
  out=$(chezmoi managed "${chezmoi_args[@]}" --include externals --exclude dirs 2>"$dir/stderr") || status=$?
  err=$(head -c 400 "$dir/stderr")
  if [[ "$status" -ne 0 ]]; then
    if [[ "$err" == *"SHA256 mismatch"* ]]; then
      record "FAIL claude-recall plugin tarball differs from the pinned sha256 (the sha256 in .chezmoiexternal.toml.tmpl does not match the release asset): $err"
    else
      record "FAIL could not fetch the claude-recall plugin tarball (network or rate limit, exit $status): $err"
    fi
    return 0
  fi
  actual=$(grep "^$RECALL_DIR/" <<<"$out" | LC_ALL=C sort || true)

  # The URL is taken from the rendered template as is (not rebuilt from the version), the sha256 with the same
  # pattern as the checksums test below.
  url=$(chezmoi execute-template --source "$SRC" --override-data "$HOST_LINUX" <"$EXTERNAL_TMPL" 2>/dev/null \
    | awk -v h="[\"$RECALL_DIR\"]" '$0 == h {on = 1; next} /^\[/ {on = 0} on && /^url = / {gsub(/^url = "|"$/, ""); print; exit}') || true
  sha=$(sed -nE 's/^\{\{- [$]recallPluginSha256 := "([0-9a-f]{64})" \}\}$/\1/p' "$EXTERNAL_TMPL")
  if [[ -z "$url" || -z "$sha" ]]; then
    record "FAIL could not read the claude-recall plugin tarball url (${url:-none}) and pinned sha256 (${sha:-none}) from the template"; return 0
  fi
  if ! err=$(curl -fsSL --max-time 30 --retry 2 -o "$dir/plugin.tar.gz" "$url" 2>&1); then
    record "FAIL could not fetch the claude-recall plugin tarball for the expected file list (network or rate limit): ${err:0:200}"; return 0
  fi
  if [[ "$(sha256_of "$dir/plugin.tar.gz")" != "$sha" ]]; then
    record "FAIL the claude-recall plugin tarball fetched for the expected file list differs from the pinned sha256 (pinned: $sha / fetched: $(sha256_of "$dir/plugin.tar.gz"))"; return 0
  fi
  if ! tar_t=$(tar -tzf "$dir/plugin.tar.gz" 2>&1) || ! tar_tv=$(tar -tvzf "$dir/plugin.tar.gz" 2>&1); then
    record "FAIL could not list the claude-recall plugin tarball: ${tar_t:0:200}"; return 0
  fi
  if ! expected=$(recall_expected_paths "$tar_t" "$tar_tv" 2>&1); then
    record "FAIL claude-recall plugin tarball cannot give an expected file list: $expected"; return 0
  fi
  expected=$(LC_ALL=C sort <<<"$expected")
  # The tarball side of the required check uses the list before ignores, so a file left out by .chezmoiignore is
  # reported as an extraction-side miss and not as one that upstream dropped.
  tarball_files=$expected
  # Which files chezmoi leaves out (.chezmoiignore) is asked of chezmoi, not copied into this test.
  if ! ignored=$(chezmoi ignored "${chezmoi_args[@]}" 2>"$dir/ignored-stderr"); then
    record "FAIL chezmoi ignored failed, so the expected claude-recall files cannot be narrowed: $(head -c 300 "$dir/ignored-stderr")"; return 0
  fi
  ignored=$(grep "^$RECALL_DIR/" <<<"$ignored" || true)
  if [[ -n "$ignored" ]]; then
    expected=$(grep -vxF -f <(printf '%s\n' "$ignored") <<<"$expected" || true)
  fi

  # Both checks always run so that one failure does not hide the other.
  reason=$(recall_required_report "$tarball_files" "$actual")
  if [[ -n "$reason" ]]; then
    while IFS= read -r line; do record "FAIL $line"; done <<<"$reason"
  fi
  missing=$(comm -23 <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") | paste -sd ' ' -)
  extra=$(comm -13 <(printf '%s\n' "$expected") <(printf '%s\n' "$actual" | grep . || true) | paste -sd ' ' -)
  if [[ -n "$missing" || -n "$extra" ]]; then
    record "FAIL claude-recall plugin layout differs from the pinned tarball (missing: ${missing:-none} / extra: ${extra:-none}). Check stripComponents in .chezmoiexternal.toml.tmpl and the chezmoi version"
  elif [[ -z "$reason" ]]; then
    record "PASS the pinned claude-recall plugin tarball downloads, matches its sha256 and lands as its own file list says"
  fi
}
# Fixed inputs for the two pure functions, in GNU tar -tv form (the CI also runs this on macOS with bsdtar, whose
# first character per entry is the same type letter).
tv_line() { printf '%s 0/0 0 2026-01-01 00:00 %s\n' "$1" "$2"; } # mode name
recall_listing_t() { printf '%s\n' "$@"; }
test_recall_expected_paths_from_fixed_listings() {
  local t tv out expect="$RECALL_DIR/.claude-plugin/plugin.json
$RECALL_DIR/.mcp.json
$RECALL_DIR/hooks/hooks.json
$RECALL_DIR/skills/recall/SKILL.md"
  t=$(recall_listing_t ./ ./.claude-plugin/ ./.claude-plugin/plugin.json ./.mcp.json ./hooks/hooks.json ./skills/recall/SKILL.md)
  tv=$(tv_line drwxr-xr-x ./; tv_line drwxr-xr-x ./.claude-plugin/; tv_line -rw-r--r-- ./.claude-plugin/plugin.json
    tv_line -rw-r--r-- ./.mcp.json; tv_line -rw-r--r-- ./hooks/hooks.json; tv_line -rw-r--r-- ./skills/recall/SKILL.md)
  out=$(recall_expected_paths "$t" "$tv" 2>&1) || out="rejected: $out"
  assert_eq "$expect" "$out" "expected paths: the 1.7.2 layout gives its 4 files"

  t=$(recall_listing_t .claude-plugin/plugin.json .mcp.json hooks/hooks.json skills/recall/SKILL.md)
  tv=$(tv_line -rw-r--r-- .claude-plugin/plugin.json; tv_line -rw-r--r-- .mcp.json; tv_line -rw-r--r-- hooks/hooks.json; tv_line -rw-r--r-- skills/recall/SKILL.md)
  out=$(recall_expected_paths "$t" "$tv" 2>&1) || out="rejected: $out"
  assert_eq "$expect" "$out" "expected paths: names without a leading ./ give the same set"

  t=$(recall_listing_t a/foo..bar)
  tv=$(tv_line -rw-r--r-- a/foo..bar)
  out=$(recall_expected_paths "$t" "$tv" 2>&1) || out="rejected: $out"
  assert_eq "$RECALL_DIR/a/foo..bar" "$out" "expected paths: foo..bar is a name, not a .. element"
}
expect_recall_paths_rejected() { # label needle t_listing tv_listing
  local out
  if out=$(recall_expected_paths "$3" "$4" 2>&1); then
    record "FAIL expected paths: $1 was accepted (output: $out)"
  else
    assert_contains "$out" "$2" "expected paths: $1 is rejected with its name"
  fi
}
test_recall_expected_paths_rejects_unsafe_listings() {
  expect_recall_paths_rejected "a symlink" "evil-link" "$(recall_listing_t ./ok ./evil-link)" "$(tv_line -rw-r--r-- ./ok; tv_line lrwxrwxrwx './evil-link -> /etc/passwd')"
  expect_recall_paths_rejected "a hardlink" "hard" "$(recall_listing_t ./ok ./hard)" "$(tv_line -rw-r--r-- ./ok; tv_line hrw-r--r-- './hard link to ./ok')"
  expect_recall_paths_rejected "../x" "../x" "$(recall_listing_t ../x)" "$(tv_line -rw-r--r-- ../x)"
  expect_recall_paths_rejected "a/../../x" "a/../../x" "$(recall_listing_t a/../../x)" "$(tv_line -rw-r--r-- a/../../x)"
  expect_recall_paths_rejected "/etc/x" "/etc/x" "$(recall_listing_t /etc/x)" "$(tv_line -rw-r--r-- /etc/x)"
  expect_recall_paths_rejected "listings of different lengths" "lines" "$(recall_listing_t ./a ./b)" "$(tv_line -rw-r--r-- ./a)"
  expect_recall_paths_rejected "a listing with directories only" "no regular files" "$(recall_listing_t ./ ./d/)" "$(tv_line drwxr-xr-x ./; tv_line drwxr-xr-x ./d/)"
}
test_recall_required_report_names_the_side_that_lacks_a_file() {
  local all="" f out
  for f in $RECALL_REQUIRED_FILES; do all+="$RECALL_DIR/$f"$'\n'; done
  assert_eq "" "$(recall_required_report "$all" "$all")" "required files: nothing reported when both sides hold them"

  out=$(recall_required_report "$all" "$(grep -vxF "$RECALL_DIR/.mcp.json" <<<"$all")")
  assert_contains "$out" "did not place required claude-recall file(s): .mcp.json" "required files: a file missing from the result is named on the extraction side"
  assert_eq "1" "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" "required files: that is one line"

  out=$(recall_required_report "$(grep -vxF "$RECALL_DIR/hooks/hooks.json" <<<"$all")" "$all")
  assert_contains "$out" "tarball lacks required file(s): hooks/hooks.json" "required files: a file missing from the tarball is named on the upstream side"
  assert_not_contains "$out" "did not place" "required files: the extraction side stays quiet then"

  out=$(recall_required_report "" "")
  assert_eq "2" "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" "required files: three missing files still give one line per side"
  assert_contains "$out" ".claude-plugin/plugin.json .mcp.json hooks/hooks.json" "required files: all missing files are in the line"
}
# home/.chezmoiversion and stripComponents = 0 in the claude-recall external are a pair: below 2.73.2 that
# external stops with "inconsistent state", so the floor must stay. Compared numerically, not as strings.
CHEZMOI_VERSION_FLOOR="2.73.2"
chezmoi_version_file_meets_floor() { # file floor
  local v
  [[ -f "$1" ]] || return 1
  v=$(tr -d '[:space:]' <"$1")
  v=${v#v}
  [[ "$v" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || return 1
  local -a a b
  IFS=. read -ra a <<<"$v"
  IFS=. read -ra b <<<"$2"
  local i
  for i in 0 1 2; do
    ((10#${a[i]:-0} > 10#${b[i]:-0})) && return 0
    ((10#${a[i]:-0} < 10#${b[i]:-0})) && return 1
  done
  return 0
}
test_chezmoiversion_keeps_the_floor_for_the_recall_layout() {
  if chezmoi_version_file_meets_floor "$SRC/.chezmoiversion" "$CHEZMOI_VERSION_FLOOR"; then
    record "PASS home/.chezmoiversion requires chezmoi $CHEZMOI_VERSION_FLOOR or later"
  else
    record "FAIL home/.chezmoiversion is missing or below $CHEZMOI_VERSION_FLOOR; the claude-recall external (stripComponents = 0) needs it"
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
