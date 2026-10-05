#!/usr/bin/env bash
# Builds throwaway trees next to this script and times cccc on them.
# Writes only under this script's own directory. Deletes nothing.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

# --- symlink probe: does cccc follow a link that points outside the root? ---
mkdir -p "$here/outside" "$here/linkroot"
printf 'export function outsideFn(x: number) { if (x) { return 1 } return 0 }\n' >"$here/outside/out.ts"
printf 'export function insideFn(x: number) { return x }\n' >"$here/linkroot/in.ts"
[ -e "$here/linkroot/linkdir" ] || ln -s "$here/outside" "$here/linkroot/linkdir"
[ -e "$here/linkroot/linkfile.ts" ] || ln -s "$here/outside/out.ts" "$here/linkroot/linkfile.ts"
echo "--- symlink probe ---"
(cd "$here/linkroot" && cccc --no-config --exclude '.git/**' . | jq -c '[.files[].path]')

# --- scale probe: N files, each with a few functions of moderate size ---
gen() {
  local dir="$1" n="$2" i
  mkdir -p "$dir"
  for ((i = 0; i < n; i++)); do
    local sub="$dir/d$((i / 200))"
    [ -d "$sub" ] || mkdir -p "$sub"
    cat >"$sub/f$i.ts" <<EOF
export function a$i(x: number, y: number): number {
  let total = 0;
  for (let k = 0; k < x; k++) {
    if (k % 2 === 0 && y > 3) {
      total += k;
    } else if (k % 3 === 0) {
      total -= k;
    } else {
      switch (y) {
        case 1: total += 1; break;
        case 2: total += 2; break;
        default: total += y;
      }
    }
  }
  return total;
}
export const b$i = (items: number[]) => items.filter((v) => v > $i).map((v) => (v % 2 ? v * 2 : v));
export function c$i(s: string): string {
  try {
    return s.trim() || "x";
  } catch {
    return "";
  }
}
EOF
  done
}

for n in 10000 30000; do
  dir="$here/tree$n"
  [ -d "$dir" ] || gen "$dir" "$n"
  echo "--- $n files ---"
  for run in 1 2 3; do
    start=$(date +%s%N)
    bytes=$(cd "$dir" && cccc --no-config --exclude '.git/**' . | wc -c)
    end=$(date +%s%N)
    echo "run $run: $(((end - start) / 1000000)) ms, output ${bytes} bytes"
  done
done
