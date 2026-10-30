#!/usr/bin/env bash
# shellcheck disable=SC2329 # injection overrides are called indirectly by reserveMarker

set -euo pipefail

TEST_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd -- "$TEST_DIR/../.." && pwd -P)
LOCATION_LIB="$REPO_ROOT/home/dot_local/lib/worktree-location.sh"
CASES="$TEST_DIR/location-cases.json"
TMP_BASE=$(cd -P "$(mktemp -d -t worktree-location-XXXXXX)" && pwd -P)
source "$LOCATION_LIB"

RESULTS="$TMP_BASE/results"
: >"$RESULTS"
trap 'rm -rf -- "$TMP_BASE"' EXIT
record() { printf '%s\n' "$1" >>"$RESULTS"; }
assert_eq() {
  if [[ "$1" == "$2" ]]; then
    record "PASS $3"
  else
    record "FAIL $3 (expected: $1 / actual: $2)"
  fi
}
assert_contains() {
  case "$1" in
    *"$2"*) record "PASS $3" ;;
    *) record "FAIL $3 (missing: $2)" ;;
  esac
}
assert_not_contains() {
  case "$1" in
    *"$2"*) record "FAIL $3 (unexpected: $2)" ;;
    *) record "PASS $3" ;;
  esac
}
assert_empty_dir() {
  local found
  found=$(find "$1" -mindepth 1 -print -quit)
  if [[ -z "$found" ]]; then record "PASS $2"; else record "FAIL $2 ($found)"; fi
}

while IFS= read -r item; do
  name=$(jq -r '.name' <<<"$item")
  common_dir=$(jq -r '.commonDir' <<<"$item")
  home=$(jq -r '.home' <<<"$item")
  error=$(jq -r '.error // empty' <<<"$item")
  if [[ "$error" == "unsupported" ]]; then
    if repoName "$common_dir" >/dev/null 2>&1; then
      record "FAIL path $name repoName should reject"
    else
      record "PASS path $name repoName rejects"
    fi
    if currentRoot "$common_dir" "$home" >/dev/null 2>&1; then
      record "FAIL path $name currentRoot should reject"
    else
      record "PASS path $name currentRoot rejects"
    fi
  else
    assert_eq "$(jq -r '.repoName' <<<"$item")" "$(repoName "$common_dir")" "path $name repoName"
    assert_eq "$(jq -r '.currentRoot' <<<"$item")" "$(currentRoot "$common_dir" "$home")" "path $name currentRoot"
    assert_eq "$(jq -r '.legacyRoot' <<<"$item")" "$(legacyRoot "$common_dir")" "path $name legacyRoot"
  fi
done < <(jq -c '.pathCases[]' "$CASES")

while IFS= read -r item; do
  name=$(jq -r '.name' <<<"$item")
  path=$(jq -r '.path' <<<"$item")
  common_dir=$(jq -r '.commonDir' <<<"$item")
  home=$(jq -r '.home' <<<"$item")
  expected=$(jq -r '.expected' <<<"$item")
  actual=false
  if isUnderManagedRoot "$path" "$common_dir" "$home"; then actual=true; fi
  assert_eq "$expected" "$actual" "managed root $name"
done < <(jq -c '.managedCases[]' "$CASES")

while IFS= read -r item; do
  name=$(jq -r '.name' <<<"$item")
  root_state=$(jq -r '.rootState' <<<"$item")
  marker_content=$(jq -r '.markerContent' <<<"$item")
  expected=$(jq -r '.expected' <<<"$item")
  base="$TMP_BASE/case-$name"
  common_dir="$base/source/proj/.git"
  home="$base/home"
  root=$(currentRoot "$common_dir" "$home")
  external_dir="$base/external/repo/.git"
  external_file="$base/external.txt"
  mkdir -p "$common_dir"
  printf 'ref: refs/heads/main\n' >"$common_dir/HEAD"

  case "$root_state" in
    missing) ;;
    *) mkdir -p "$root" ;;
  esac
  case "$root_state" in
    temporary-file) printf 'partial\n' >"$root/.common-dir.tmp.123" ;;
    other-file) printf 'unmarked\n' >"$root/README" ;;
    marker-symlink)
      printf 'outside marker target\n' >"$external_file"
      ln -s "$external_file" "$root/.common-dir"
      ;;
  esac
  if [[ "$root_state" == "marker" ]]; then
    case "$marker_content" in
      empty) : >"$root/.common-dir" ;;
      other)
        mkdir -p "$external_dir"
        printf 'ref: refs/heads/main\n' >"$external_dir/HEAD"
        printf '%s\n' "$(cd -P -- "$external_dir" && pwd -P)" >"$root/.common-dir"
        ;;
      missing) printf '%s\n' "$base/missing/repo/.git" >"$root/.common-dir" ;;
      invalid) printf 'token=abc\n' >"$root/.common-dir" ;;
      self-crlf) printf '%s\r\n' "$(cd -P -- "$common_dir" && pwd -P)" >"$root/.common-dir" ;;
      self-no-lf) printf '%s' "$(cd -P -- "$common_dir" && pwd -P)" >"$root/.common-dir" ;;
      self-first-line)
        printf '%s\n%s\n' "$(cd -P -- "$common_dir" && pwd -P)" "$base/other/.git" >"$root/.common-dir"
        ;;
      self-lf) printf '%s\n' "$(cd -P -- "$common_dir" && pwd -P)" >"$root/.common-dir" ;;
      none) record "FAIL marker case $name has no marker content" ;;
      *) record "FAIL marker case $name has unsupported content $marker_content" ;;
    esac
  fi
  actual=$(judgeMarker "$common_dir" "$home")
  assert_eq "$expected" "$actual" "marker judgement $name"
  if [[ "$root_state" == "marker-symlink" ]]; then
    assert_eq "outside marker target" "$(cat "$external_file")" "marker symlink leaves target unchanged"
  fi
done < <(jq -c '.markerCases[]' "$CASES")

race_dir="$TMP_BASE/race"
mkdir -p "$race_dir/home" "$race_dir/one/shared/.git" "$race_dir/two/shared/.git"
printf 'ref: refs/heads/main\n' >"$race_dir/one/shared/.git/HEAD"
printf 'ref: refs/heads/main\n' >"$race_dir/two/shared/.git/HEAD"
common_a="$race_dir/one/shared/.git"
common_b="$race_dir/two/shared/.git"
home="$race_dir/home"
race_root=$(currentRoot "$common_a" "$home")
for iteration in $(seq 1 20); do
  rm -rf -- "$race_root"
  out_a="$race_dir/a-$iteration.out"
  out_b="$race_dir/b-$iteration.out"
  err_a="$race_dir/a-$iteration.err"
  err_b="$race_dir/b-$iteration.err"
  bash -c 'source "$1"; reserveMarker "$2" "$3" "$4"; status=$?; printf "%s\n" "$WORKTREE_MARKER_KIND"; exit "$status"' _ "$LOCATION_LIB" "$common_a" "$home" "$race_root/feat/a" >"$out_a" 2>"$err_a" &
  pid_a=$!
  bash -c 'source "$1"; reserveMarker "$2" "$3" "$4"; status=$?; printf "%s\n" "$WORKTREE_MARKER_KIND"; exit "$status"' _ "$LOCATION_LIB" "$common_b" "$home" "$race_root/feat/b" >"$out_b" 2>"$err_b" &
  pid_b=$!
  status_a=0
  status_b=0
  wait "$pid_a" || status_a=$?
  wait "$pid_b" || status_b=$?
  if [[ "$status_a" -eq 0 && "$status_b" -eq 1 ]]; then
    expected=$(cd -P -- "$common_a" && pwd -P)
  elif [[ "$status_a" -eq 1 && "$status_b" -eq 0 ]]; then
    expected=$(cd -P -- "$common_b" && pwd -P)
  else
    record "FAIL concurrent reservation $iteration statuses $status_a/$status_b"
    continue
  fi
  if [[ "$status_a" -eq 0 ]]; then
    assert_eq "ok-same" "$(cat "$out_a")" "concurrent reservation $iteration winner status"
    assert_eq "conflict" "$(cat "$out_b")" "concurrent reservation $iteration loser status"
  else
    assert_eq "conflict" "$(cat "$out_a")" "concurrent reservation $iteration loser status"
    assert_eq "ok-same" "$(cat "$out_b")" "concurrent reservation $iteration winner status"
  fi
  assert_eq "$expected" "$(cat "$race_root/.common-dir")" "concurrent reservation $iteration winner stays marked"
  leftover=$(find "$race_root" -maxdepth 1 -name '.common-dir.tmp.*' -print -quit)
  assert_eq "" "$leftover" "concurrent reservation $iteration removes temporary files"
done
record "PASS concurrent reservation ran 20 iterations"

home="$TMP_BASE/symlink-home"
common_dir="$TMP_BASE/symlink-repo/proj/.git"
external_dir="$TMP_BASE/symlink-target"
mkdir -p "$home" "$common_dir" "$external_dir"
printf 'ref: refs/heads/main\n' >"$common_dir/HEAD"
ln -s "$external_dir" "$home/worktrees"
if reserveMarker "$common_dir" "$home" >/dev/null 2>"$TMP_BASE/root-symlink.err"; then
  record "FAIL reservation rejects worktrees root symlink"
else
  record "PASS reservation rejects worktrees root symlink"
fi
assert_empty_dir "$external_dir" "worktrees root symlink leaves external directory empty"

home="$TMP_BASE/nested-symlink-home"
common_dir="$TMP_BASE/nested-symlink-repo/proj/.git"
external_dir="$TMP_BASE/nested-symlink-target"
mkdir -p "$common_dir" "$home/worktrees/proj" "$external_dir"
printf 'ref: refs/heads/main\n' >"$common_dir/HEAD"
ln -s "$external_dir" "$home/worktrees/proj/feat"
if reserveMarker "$common_dir" "$home" "$home/worktrees/proj/feat/x" >/dev/null 2>"$TMP_BASE/nested-symlink.err"; then
  record "FAIL reservation rejects nested target symlink"
else
  record "PASS reservation rejects nested target symlink"
fi
assert_empty_dir "$external_dir" "nested target symlink leaves external directory empty"
if [[ -e "$home/worktrees/proj/.common-dir" ]]; then
  record "FAIL nested target symlink creates no marker"
else
  record "PASS nested target symlink creates no marker"
fi

home="$TMP_BASE/temp-symlink-home"
common_dir="$TMP_BASE/temp-symlink-repo/proj/.git"
external_file="$TMP_BASE/temp-symlink-outside.txt"
root=$(currentRoot "$common_dir" "$home")
mkdir -p "$common_dir" "$root"
printf 'ref: refs/heads/main\n' >"$common_dir/HEAD"
printf 'preserve this\n' >"$external_file"
ln -s "$external_file" "$root/.common-dir.tmp.123.collision"
if reserveMarker "$common_dir" "$home" >/dev/null 2>"$TMP_BASE/temp-symlink.err"; then
  record "FAIL reservation refuses an untrusted temporary symlink"
else
  record "PASS reservation refuses an untrusted temporary symlink"
fi
assert_eq "preserve this" "$(cat "$external_file")" "temporary symlink leaves external file unchanged"

home="$TMP_BASE/marker-symlink-home"
common_dir="$TMP_BASE/marker-symlink-repo/proj/.git"
root=$(currentRoot "$common_dir" "$home")
external_file="$TMP_BASE/marker-symlink-outside.txt"
mkdir -p "$common_dir" "$root"
printf 'ref: refs/heads/main\n' >"$common_dir/HEAD"
printf '/outside/secret\n' >"$external_file"
printf 'placeholder\n' >"$root/.common-dir"
marker_path="${root%/}/.common-dir"
status=0
output=$(
  worktree_marker_read_first_line() {
    local marker=$1 value=""
    rm "$marker_path"
    ln -s "$external_file" "$marker_path"
    IFS= read -r value <"$marker" || :
    WORKTREE_MARKER_VALUE=${value%$'\r'}
  }
  reserveMarker "$common_dir" "$home" 2>&1
) || status=$?
assert_eq 1 "$status" "shell read-time symlink replacement fails closed"
assert_not_contains "$output" "/outside/secret" "shell read-time replacement does not print marker contents"
if [[ -n "$output" ]]; then
  record "PASS shell read-time replacement reports a failure reason"
else
  record "FAIL shell read-time replacement reports a failure reason"
fi

home="$TMP_BASE/invalid-marker-home"
common_dir="$TMP_BASE/invalid-marker-repo/proj/.git"
root=$(currentRoot "$common_dir" "$home")
mkdir -p "$common_dir" "$root"
printf 'ref: refs/heads/main\n' >"$common_dir/HEAD"
printf 'token=abc\n' >"$root/.common-dir"
status=0
output=$(reserveMarker "$common_dir" "$home" 2>&1) || status=$?
assert_eq 1 "$status" "shell invalid marker refuses reservation"
assert_not_contains "$output" "token=abc" "shell invalid marker does not print its contents"
assert_contains "$output" "${root%/}/.common-dir" "shell invalid marker reports its path"

home="$TMP_BASE/link-source-home"
common_dir="$TMP_BASE/link-source-repo/proj/.git"
root=$(currentRoot "$common_dir" "$home")
external_file="$TMP_BASE/link-source-outside.txt"
mkdir -p "$common_dir"
printf 'ref: refs/heads/main\n' >"$common_dir/HEAD"
printf 'preserve source\n' >"$external_file"
status=0
output=$(
  worktree_marker_temp_path() { printf '%s/.common-dir.tmp.injected\n' "$root"; }
  worktree_link_marker() {
    rm "$1"
    ln -s "$external_file" "$1"
    ln -n "$1" "$2"
  }
  reserveMarker "$common_dir" "$home" 2>&1
) || status=$?
assert_eq 1 "$status" "shell temporary symlink replacement fails closed"
assert_eq "preserve source" "$(cat "$external_file")" "shell temporary symlink replacement preserves target"
if [[ -e "$root/.common-dir" || -L "$root/.common-dir" ]]; then
  record "FAIL shell temporary symlink replacement leaves no marker"
else
  record "PASS shell temporary symlink replacement leaves no marker"
fi

home="$TMP_BASE/link-target-home"
common_dir="$TMP_BASE/link-target-repo/proj/.git"
root=$(currentRoot "$common_dir" "$home")
external_dir="$TMP_BASE/link-target-outside"
mkdir -p "$common_dir" "$external_dir"
printf 'ref: refs/heads/main\n' >"$common_dir/HEAD"
status=0
output=$(
  worktree_link_marker() {
    ln -s "$external_dir" "$2"
    ln -n "$1" "$2"
  }
  reserveMarker "$common_dir" "$home" 2>&1
) || status=$?
assert_eq 1 "$status" "shell link-time marker symlink replacement fails closed"
assert_empty_dir "$external_dir" "shell link-time marker symlink leaves external directory empty"

home="$TMP_BASE/conflict-home"
common_dir="$TMP_BASE/conflict-repo/proj/.git"
other_common="$TMP_BASE/conflict-other/proj/.git"
root=$(currentRoot "$common_dir" "$home")
mkdir -p "$common_dir" "$other_common" "$root"
printf 'ref: refs/heads/main\n' >"$common_dir/HEAD"
printf 'ref: refs/heads/main\n' >"$other_common/HEAD"
printf '%s\n' "$(cd -P -- "$other_common" && pwd -P)" >"$root/.common-dir"
status=0
output=$(reserveMarker "$common_dir" "$home" 2>&1) || status=$?
assert_eq 1 "$status" "shell conflict refuses reservation"
assert_contains "$output" "${root%/}/.common-dir" "shell conflict reports marker path"
assert_not_contains "$output" "$other_common" "shell conflict does not print marker contents"

cat "$RESULTS"
pass=$(grep -c '^PASS' "$RESULTS" || true)
fail=$(grep -c '^FAIL' "$RESULTS" || true)
printf 'PASS: %s FAIL: %s\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
