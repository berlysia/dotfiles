#!/usr/bin/env bash
# Replays recent commits touching hook sources and records every named function
# whose cognitive complexity rose or that was newly added. Read-only against the
# repository; writes only under this script's own directory. Deletes nothing.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="${1:?repo path}"
limit="${2:-150}"
out="$here/all.jsonl"
: >"$out"

paths=(
  'home/dot_claude/hooks/implementations/*.ts'
  'home/dot_claude/hooks/lib/*.ts'
  'home/dot_claude/hooks/cli/*.ts'
)

count=0
while read -r c; do
  mapfile -t files < <(git -C "$repo" diff --name-only --diff-filter=AM "$c~1" "$c" -- "${paths[@]}")
  [ "${#files[@]}" -eq 0 ] && continue
  mapfile -t old < <(git -C "$repo" diff --name-only --diff-filter=M "$c~1" "$c" -- "${files[@]}")

  mkdir -p "$here/$c/o" "$here/$c/n"
  before='{}'
  if [ "${#old[@]}" -gt 0 ]; then
    git -C "$repo" archive "$c~1" -- "${old[@]}" | tar -x -C "$here/$c/o"
    before="$(cccc --no-config "$here/$c/o" | jq -c -f "$here/flat.jq")"
  fi
  git -C "$repo" archive "$c" -- "${files[@]}" | tar -x -C "$here/$c/n"
  after="$(cccc --no-config "$here/$c/n" | jq -c -f "$here/flat.jq")"

  jq -c -n --arg c "$c" --argjson o "$before" --argjson n "$after" \
    '$n | to_entries[] | {c: $c, key, new: .value, old: ($o[.key])} | select(.old == null or .new > .old)' \
    >>"$out"
  count=$((count + 1))
done < <(git -C "$repo" log "-$limit" --no-merges --format=%h -- "${paths[@]}")

echo "commits analysed: $count"
jq -s --argjson n "$count" '
  def rate(f):
    ([.[] | select(f) | .c] | unique | length) as $k
    | "\($k) commits (\(($k * 100 / $n) | floor)%), \([.[] | select(f)] | length) functions";
  {
    "any increase or new": rate(true),
    "new>=10": rate(.new >= 10),
    "new>=15": rate(.new >= 15),
    "new>=20": rate(.new >= 20),
    "new>=25": rate(.new >= 25),
    "new>=15, existing only": rate(.new >= 15 and .old != null),
    "new>=15, added only": rate(.new >= 15 and .old == null),
    "new>=15, added or delta>=3": rate(.new >= 15 and (.old == null or .new - .old >= 3)),
    "new>=15, added or delta>=5": rate(.new >= 15 and (.old == null or .new - .old >= 5)),
    "delta of existing with new>=15": (
      [.[] | select(.new >= 15 and .old != null) | .new - .old] | sort
      | {n: length, min: .[0], median: .[length / 2 | floor], max: .[-1], le2: (map(select(. <= 2)) | length)}
    )
  }' "$out"
