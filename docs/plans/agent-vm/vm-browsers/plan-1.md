<!-- spec-ref: spec.md -->

# Plan 1: host 側（ストアの取得、machine ごとの複製、マウント）

spec の K2、K3 を実装する。VM 側（K4、K5、K6 の bootstrap 部分）は plan-2、文書と実機検証（K7、受け入れ）は plan-3 で扱う。

前提:

- ADR-0019 の変更（`5ab84f5` まで）が master にある。
- 着手時に、現状の master で `agent-vm prewarm` が通ることを確かめる（spec R7）。
- launcher のテストは ubuntu と macOS の両方で走る（`.github/workflows/ci-agent-vm.yml` の matrix、macOS は `/bin/bash` 3.2）。
- spec との差分（いずれも Round 1 のレビューの指摘に基づく）:
  - 複製コマンドの差し替え口 `AGENT_VM_CLONE_CMD`。ubuntu の CI の GNU cp に `-c`（clonefile）が無いためのテスト専用のもの。本番の既定は `cp -c -R` で、通常のコピーには落とさない（spec K3）。
  - 取得の待ちの上限 `run_bounded`（手動の実行では `npm view` 120 秒、`bunx playwright install` 900 秒。apply から呼ぶときは 30 秒、300 秒）。F4 の実測で、取得は約 1 分、`npm view` は数秒だった。上限はその 10 倍以上をとり、遅い回線でも正常な取得を切らず、詰まった接続で apply が戻らない事態だけを防ぐ。SIGALRM が届くのは exec した最初のプロセスだけで、その子（ダウンロードしている node）は残りうる。apply を戻すという目的は果たすので、既知の限界として受け入れる。
  - `env -i` の許可リストは、spec K2 の `MISE_*`、`XDG_*` のパターンより狭い固定の名前にした（`MISE_*` には取得に不要なトークンが含まれうるため）。`LANG` を足した。mise の shim がこれ以外の `MISE_*` を要しないことは、plan-3 の実機（apply）で確かめる。
  - spec K3 の判定 2 は「`current` がある（lstat）」だが、この plan は `-L` と `-e` の両方を見る。リンク先の世代が消えた（dangling な）`current` も「無い」として作り直すため。
- CI の時間: T4 の `test_ensure_browsers_never_fails_and_closes_fd8` の busy の経路は、ロックの待ちの上限（60 秒）を実際に待つので、`run.sh` が約 1 分長くなる。

## Files

```
# 編集
home/dot_local/bin/executable_agent-vm
tests/agent-vm/run.sh
tests/agent-vm/run-templates.sh

# 新規作成
home/.chezmoiscripts/run_after_50-agent-vm-fetch-browsers.sh.tmpl
```

## Tasks

全タスク共通の決めごと:

- 関数の追加先は `home/dot_local/bin/executable_agent-vm` とし、既存の関数群（`build_staging` の近く）に並べる。
- launcher は `set -euo pipefail` と、`set -E` 付きの ERR trap（`executable_agent-vm:799-807`）で動く。新しい関数では、失敗しうるコマンドを必ず `if` か `||` で受け、パイプラインの終了コードが判定に効かないよう、出力をいったん変数に取ってから判定する。`tr </dev/urandom | head` のように、SIGPIPE を起こす書き方はしない。
- テストは `tests/agent-vm/run.sh` に `test_*` 関数として足す。各テストは自分の `$TMP_ROOT` と `$AGENT_VM_STATE_DIR` を持つ（`run.sh` 末尾のループ）。
  - assert は `tests/agent-vm/lib.sh` のものを使う。新しい fixture は作らない。
  - `run.sh` は各テストを `( ... ) || record` で走らせるため、テストの中では `set -e` が効かない。「`set -e` の下で関数が最後まで走る」ことは、`errexit_run`（T1 で足す）で別プロセスを起こして確かめる。
  - stub に渡す環境変数は `export` する（`VAR=x; (cmd)` は子プロセスに渡らない）。
- 実行: `bash tests/agent-vm/run.sh`（期待: 最終行が `N run, 0 failed`）。

### T1: テストの補助、`clone_cmd`、`store_hash`、`run_bounded`

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`（`dir_hash` の直後）
- テスト: `tests/agent-vm/run.sh`
- 参照: `home/dot_local/bin/executable_agent-vm:117-121`（`dir_hash`。変えない）

- [ ] **Step 1: 失敗するテストを書く**

```bash
errexit_run() { # snippet: run it in a fresh bash with the launcher sourced under set -euo pipefail; prints "reached" at the end
  # stderr is kept for diagnosis when "reached" is missing.
  bash -c 'set -euo pipefail; AGENT_VM_LIB=1 . "$1"; eval "$2"; echo reached' _ "$LAUNCHER" "$1" 2>>"$TMP_ROOT/errexit.err" || true
}
test_store_hash_covers_symlinks_and_modes_but_not_meta() {
  local s="$TMP_ROOT/s" h1 h2 h3 h4; mkdir -p "$s/bin" "$s/x"
  printf 'a\n' >"$s/x/f"; ln -s ../x/f "$s/bin/l"; printf 'm\n' >"$s/.meta"
  h1=$(store_hash "$s")
  case "$h1" in v2:[0-9a-f]*) record "PASS store_hash has the v2 prefix" ;; *) record "FAIL store_hash has the v2 prefix ($h1)" ;; esac
  printf 'other\n' >"$s/.meta"; h2=$(store_hash "$s")
  assert_eq "$h1" "$h2" ".meta is excluded"
  ln -sfn ../x/g "$s/bin/l"; h3=$(store_hash "$s")
  if [[ "$h1" != "$h3" ]]; then record "PASS symlink target change is detected"; else record "FAIL symlink target change is detected"; fi
  ln -sfn ../x/f "$s/bin/l"; chmod +x "$s/x/f"; h4=$(store_hash "$s")
  if [[ "$h1" != "$h4" ]]; then record "PASS mode change is detected"; else record "FAIL mode change is detected"; fi
}
test_dir_hash_is_unchanged_by_store_hash() {
  local s="$TMP_ROOT/s"; mkdir -p "$s"; printf 'a\n' >"$s/f"
  case "$(dir_hash "$s")" in v1:*) record "PASS dir_hash keeps v1" ;; *) record "FAIL dir_hash keeps v1" ;; esac
}
test_clone_cmd_defaults_to_clonefile() {
  assert_eq "cp -c -R" "$(clone_cmd)" "clonefile is the default clone command"
  assert_eq "cp -R" "$(AGENT_VM_CLONE_CMD='cp -R' clone_cmd)" "tests can override the clone command"
}
test_run_bounded_stops_a_hung_command() {
  assert_status 142 "a command past its bound is killed by SIGALRM" -- run_bounded 1 sleep 5
  assert_status 0 "a quick command passes through" -- run_bounded 5 true
}
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run.sh`
期待: 上の 4 テストの assert が FAIL する（`store_hash`、`clone_cmd`、`run_bounded` が未定義なので、値が空になるか終了コードが 127 になる）。

- [ ] **Step 3: 最小実装を書く**

```bash
# Production always clones (APFS clonefile, no data copied); the override exists only for the Linux CI runner,
# whose GNU cp has no -c. A plain copy would cost ~337MB per machine, so nothing falls back to it on its own.
# The override is split on spaces; tests set it to a plain command without globs.
clone_cmd() { printf '%s\n' "${AGENT_VM_CLONE_CMD:-cp -c -R}"; }

# macOS has no timeout(1); SIGALRM survives exec, so the bound applies to the command itself (exit 142 when hit).
run_bounded() { perl -e 'alarm shift; exec @ARGV or die "exec: $!\n"' "$@"; }

store_hash() { # dir -> v2:<sha256>; covers symlink targets and modes, skips the top-level .meta (spec K3)
  local digest
  digest=$(cd "$1" && find . -mindepth 1 ! -path ./.meta -print0 | LC_ALL=C sort -z | perl -0ne '
    use Digest::SHA; chomp; my $p = $_; my @st = lstat($p) or die "lstat $p: $!\n";
    if (-l _) { printf "l %o %s -> %s\n", $st[2] & 07777, $p, readlink($p) }
    elsif (-d _) { printf "d %o %s\n", $st[2] & 07777, $p }
    elsif (-f _) { printf "f %o %s %s\n", $st[2] & 07777, $p, Digest::SHA->new(256)->addfile($p, "b")->hexdigest }
    else { die "unexpected file type: $p\n" }' | shasum -a 256 | cut -c1-64) || return 1
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf 'v2:%s\n' "$digest"
}
```

`addfile` はファイルを一定のメモリで読む（約 266MB の headless shell を丸ごと読み込まない）。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run.sh`
期待: 上の 4 テストが PASS し、最終行が `0 failed`。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): add store_hash, a bounded runner and an overridable clone command"
```

### T2: `fetch-browsers`（取得、検証、公開、`--force`、失敗の記録）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`（新関数群、`main` の case、`show_help`）
- テスト: `tests/agent-vm/run.sh`
- 参照: `home/dot_local/bin/executable_agent-vm:99-115`（`acquire_lock` の flock の流儀。fd 8 版を作る）
- 参照: `home/dot_local/bin/executable_agent-vm:123-146`（`build_staging` の build/ と perl rename の流儀）
- 参照: `home/dot_local/bin/executable_agent-vm:795-808`（`set -E` の ERR trap。失敗を返す関数は `|| exit` で受ける）
- 参照: `package.json:35`（`@playwright/mcp` の版）

関数の分担:

- `browser_store_id <working tree>`: `package.json` の `@playwright/mcp` の値から `mcp-<版>` を出す。値が exact（`^[0-9][0-9A-Za-z.+-]*$`）でなければ失敗する。perl のキーは `q(@playwright/mcp)` と書く（二重引用符の中では `@playwright` が配列として展開され、キーが変わってしまう）。
- `acquire_store_lock <seconds>` / `release_store_lock`: `browser-store.lock` を fd 8 で flock する。`acquire_lock` と同じ形。
- `fetch_env_args`: `env -i` に渡す `NAME=value` を、固定の名前の許可リストから配列 `FETCH_ENV` に詰める。値に改行を含む変数は渡さない。
- `cmd_fetch_browsers [--force] [--from-apply <working tree>]`: spec K2 の手順 1〜8。

テストでは、`npm`、`bunx`、`file` を `$TMP_ROOT/bin` に置く stub で差し替え、`PATH` の先頭に足す。`env -i` は `STUB_LOG` を消すので、stub のログの書き先は生成時に絶対パスとして埋め込む（許可リストにテスト用の変数は足さない）。

- [ ] **Step 1: 失敗するテストを書く**

```bash
fetch_stubs() { # npm/bunx/file stubs for cmd_fetch_browsers; $1 = playwright version npm reports
  mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/wt"; BUNX_LOG="$TMP_ROOT/bunx.log"; : >"$BUNX_LOG"
  printf '{"dependencies":{"@playwright/mcp":"0.0.75"}}\n' >"$TMP_ROOT/wt/package.json"
  printf '#!/bin/sh\nprintf %%s %s\n' "'{\"playwright\":\"$1\",\"playwright-core\":\"$1\"}'" >"$TMP_ROOT/bin/npm"
  cat >"$TMP_ROOT/bin/bunx" <<EOF
#!/bin/sh
{ printf 'bunx %s\n' "\$*"; env | grep -E '^(PLAYWRIGHT_|HTTPS_PROXY=|NO_PROXY=|EVIL=)' | sort; } >>"$BUNX_LOG"
d="\$PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-1224/chrome-linux"; mkdir -p "\$d"
printf 'elf\n' >"\$d/headless_shell"; chmod +x "\$d/headless_shell"
EOF
  printf '#!/bin/sh\necho "$1: ELF 64-bit LSB pie executable, ARM aarch64"\n' >"$TMP_ROOT/bin/file"
  chmod +x "$TMP_ROOT/bin/npm" "$TMP_ROOT/bin/bunx" "$TMP_ROOT/bin/file"
  export PATH="$TMP_ROOT/bin:$PATH"
}
test_browser_store_id_reads_the_scoped_package() {
  mkdir -p "$TMP_ROOT/wt"; printf '{"dependencies":{"@playwright/mcp":"0.0.75"}}\n' >"$TMP_ROOT/wt/package.json"
  assert_eq "mcp-0.0.75" "$(browser_store_id "$TMP_ROOT/wt")" "the scoped package name is read literally"
}
test_fetch_publishes_store_with_meta_and_stable_link() {
  fetch_stubs 1.61.0-alpha-1778188671000
  cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  local s="$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75"
  assert_status 0 "store published under the mcp version" -- test -d "$s"
  assert_eq "../chromium_headless_shell-1224/chrome-linux/headless_shell" "$(readlink "$s/bin/headless_shell")" "stable relative link"
  assert_contains "$(cat "$s/.meta")" "playwright_version=1.61.0-alpha-1778188671000" "meta records the playwright version"
  assert_eq "sha256=$(store_hash "$s")" "$(grep '^sha256=' "$s/.meta")" "meta records the store hash"
  assert_eq "700" "$(perl -e 'printf "%o", (stat shift)[2] & 0777' "$AGENT_VM_STATE_DIR/browser-store")" "store dir is 0700"
}
test_fetch_is_a_no_op_when_the_store_exists() {
  fetch_stubs 1.61.0-alpha-1778188671000
  cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  assert_eq "1" "$(grep -c '^bunx ' "$BUNX_LOG")" "first run downloads once"
  cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  assert_eq "1" "$(grep -c '^bunx ' "$BUNX_LOG")" "second run does not download"
}
test_fetch_force_replaces_an_existing_store() {
  fetch_stubs 1.61.0-alpha-1778188671000
  cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  printf 'tampered\n' >"$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75/chromium_headless_shell-1224/chrome-linux/headless_shell"
  cmd_fetch_browsers --force --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  assert_eq "elf" "$(cat "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75/chromium_headless_shell-1224/chrome-linux/headless_shell")" "--force replaces the store"
  assert_eq "" "$(ls "$AGENT_VM_STATE_DIR/build")" "no leftovers in build/"
}
test_fetch_refuses_a_range_version() {
  fetch_stubs '^1.61.0'
  assert_status 1 "a range version fails the fetch" -- cmd_fetch_browsers --from-apply "$TMP_ROOT/wt"
  assert_contains "$(cat "$AGENT_VM_STATE_DIR/browser-store/.last-failure")" "range" "failure reason recorded"
  assert_status 1 "nothing published" -- test -e "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75"
}
test_fetch_failure_reason_keeps_paths_readable() {
  fetch_stubs 1.61.0-alpha-1778188671000
  printf '#!/bin/sh\nexit 3\n' >"$TMP_ROOT/bin/bunx"
  cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  assert_contains "$(cat "$AGENT_VM_STATE_DIR/browser-store/.last-failure")" "(see $AGENT_VM_STATE_DIR/browser-store/.fetch.log)" "the sanitized reason keeps the log path intact"
}
test_fetch_refuses_a_non_arm64_binary() {
  fetch_stubs 1.61.0-alpha-1778188671000
  printf '#!/bin/sh\necho "$1: Mach-O 64-bit executable arm64"\n' >"$TMP_ROOT/bin/file"
  assert_status 1 "a non-ELF binary fails the fetch" -- cmd_fetch_browsers --from-apply "$TMP_ROOT/wt"
  assert_status 1 "nothing published" -- test -e "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75"
}
test_fetch_records_a_failure_when_no_browser_was_installed() {
  fetch_stubs 1.61.0-alpha-1778188671000
  printf '#!/bin/sh\nexit 0\n' >"$TMP_ROOT/bin/bunx"
  assert_status 1 "an empty install fails the fetch" -- cmd_fetch_browsers --from-apply "$TMP_ROOT/wt"
  assert_status 0 "the failure is recorded" -- test -s "$AGENT_VM_STATE_DIR/browser-store/.last-failure"
}
test_fetch_passes_only_allowlisted_env() {
  fetch_stubs 1.61.0-alpha-1778188671000
  EVIL=1 PLAYWRIGHT_DOWNLOAD_HOST=http://evil HTTPS_PROXY=http://proxy NO_PROXY='*.local, 10.0.0.0/8' \
    cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  local log; log=$(cat "$BUNX_LOG")
  assert_not_contains "$log" "EVIL=" "unlisted variables are dropped"
  assert_not_contains "$log" "PLAYWRIGHT_DOWNLOAD_HOST" "playwright overrides are dropped"
  assert_contains "$log" "HTTPS_PROXY=http://proxy" "proxy is passed"
  assert_contains "$log" "NO_PROXY=*.local, 10.0.0.0/8" "a value with spaces and globs is passed intact"
  assert_contains "$log" "PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-arm64" "platform override is set"
}
test_fetch_failure_repeats_as_one_line() {
  fetch_stubs '^1.61.0'
  cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  local second; second=$(cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" 2>&1 || true)
  assert_eq "1" "$(printf '%s\n' "$second" | grep -c .)" "a repeated failure prints one line"
  assert_contains "$second" "agent-vm fetch-browsers" "the line names the recovery"
}
test_fetch_cli_failure_prints_no_unexpected_error() {
  fetch_stubs '^1.61.0'
  local err status=0
  err=$(AGENT_VM_STATE_DIR="$AGENT_VM_STATE_DIR" bash "$LAUNCHER" fetch-browsers --from-apply "$TMP_ROOT/wt" 2>&1 >/dev/null) || status=$?
  assert_eq "1" "$status" "the CLI exits 1 on a fetch failure"
  assert_not_contains "$err" "unexpectedly" "the ERR trap does not add its own report"
}
test_fetch_removes_older_stores_after_publishing() {
  fetch_stubs 1.61.0-alpha-1778188671000
  mkdir -p "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.74"
  cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  assert_status 1 "older store removed" -- test -e "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.74"
}
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run.sh`
期待: T2 で足したテストの assert が FAIL する（`cmd_fetch_browsers` が未定義）。

- [ ] **Step 3: 最小実装を書く**

```bash
store_dir() { printf '%s/browser-store\n' "$AGENT_VM_STATE_DIR"; }

browser_store_id() { # working tree -> mcp-<version>; the exact @playwright/mcp pin in package.json (spec K2)
  local v
  v=$(perl -MJSON::PP -0777 -ne 'my $j = decode_json($_); print $j->{dependencies}{q(@playwright/mcp)} // ""' "$1/package.json" 2>/dev/null) || return 1
  [[ "$v" =~ ^[0-9][0-9A-Za-z.+-]*$ ]] || return 1
  printf 'mcp-%s\n' "$v"
}

acquire_store_lock() { # max_wait_seconds; holds fd 8 until release_store_lock (lock order: fd 9, then fd 8)
  local waited=0
  mkdir -p "$AGENT_VM_STATE_DIR" || return 1
  # A failed redirection on a bare `exec` would end the shell; braces turn it into an ordinary failure.
  { exec 8>"$AGENT_VM_STATE_DIR/browser-store.lock"; } 2>/dev/null || return 1
  until perl -MFcntl=:flock -e 'open(my $f, ">&=", 8) or die "fdopen: $!"; flock($f, LOCK_EX | LOCK_NB) or exit 1'; do
    waited=$((waited + 1))
    if [[ "$waited" -ge "$1" ]]; then exec 8>&-; return 1; fi
    sleep 1
  done
}
release_store_lock() { exec 8>&-; }

# Fixed names only: a pattern such as MISE_* would also pass tokens the download has no use for.
FETCH_ENV_NAMES="USER TMPDIR LANG HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy SSL_CERT_FILE NODE_EXTRA_CA_CERTS MISE_DATA_DIR MISE_CONFIG_DIR XDG_CACHE_HOME XDG_CONFIG_HOME XDG_DATA_HOME"
fetch_env_args() { # fills FETCH_ENV with NAME=value pairs for env -i (values with a newline are not passed)
  local n v
  FETCH_ENV=("PATH=$PATH" "HOME=$HOME")
  for n in $FETCH_ENV_NAMES; do
    v=$(printenv "$n" 2>/dev/null) || continue
    case "$v" in *$'\n'*) continue ;; esac
    FETCH_ENV+=("$n=$v")
  done
}

fetch_fail() { # id reason: record, then print one line (shortened when the same id failed before); returns 1
  local f reason=${2//[^[:alnum:] .,:()\/@_+-]/?}
  f="$(store_dir)/.last-failure"
  if [[ -f "$f" && "$(cut -f1 "$f" 2>/dev/null)" == "$1" ]]; then
    step "browser fetch still failing ($reason); recover: agent-vm fetch-browsers"
  else
    step "browser fetch failed for $1: $reason; recover: agent-vm fetch-browsers"
  fi
  printf '%s\t%s\n' "$1" "$reason" >"$f" || true
  return 1
}

cmd_fetch_browsers() { # [--force] [--from-apply <working tree>]  (spec K2)
  local force=0 wt="" from_apply="" id pw build bin rev hash meta log
  while [[ $# -gt 0 ]]; do
    case "$1" in --force) force=1 ;; --from-apply) wt=${2:-}; from_apply=1; shift ;; *) die "usage: agent-vm fetch-browsers [--force]" ;; esac
    shift
  done
  if [[ -z "$wt" ]]; then wt=$(resolve_working_tree); fi
  mkdir -p "$(store_dir)" "$AGENT_VM_STATE_DIR/build" && chmod 700 "$(store_dir)" || { step "cannot create $(store_dir)"; return 1; }
  if ! id=$(browser_store_id "$wt"); then fetch_fail unknown "@playwright/mcp in package.json is missing or not an exact version"; return 1; fi
  if [[ "$force" -eq 0 && -d "$(store_dir)/$id" ]]; then return 0; fi
  # From chezmoi apply the bounds are tighter, so a network that keeps failing costs each apply at most ~5 minutes.
  local view_limit=120 install_limit=900
  if [[ -n "$from_apply" ]]; then view_limit=30; install_limit=300; fi
  fetch_env_args
  # Same clean cwd and allowlisted env as the install, so a .npmrc or mise config in the caller's cwd does not apply.
  meta=$(cd "$AGENT_VM_STATE_DIR/build" && run_bounded "$view_limit" env -i "${FETCH_ENV[@]}" \
    npm view "@playwright/mcp@${id#mcp-}" dependencies --json 2>/dev/null 9>&- 8>&-) || { fetch_fail "$id" "npm view failed"; return 1; }
  pw=$(printf '%s' "$meta" | perl -MJSON::PP -0777 -ne 'print decode_json($_)->{playwright} // ""' 2>/dev/null) || pw=""
  [[ "$pw" =~ ^[0-9][0-9A-Za-z.+-]*$ ]] || { fetch_fail "$id" "@playwright/mcp now gives playwright a range or no version"; return 1; }
  build=$(mktemp -d "$AGENT_VM_STATE_DIR/build/store.XXXXXX") || { fetch_fail "$id" "no build dir"; return 1; }
  log="$(store_dir)/.fetch.log"
  if ! (cd "$build" && run_bounded "$install_limit" env -i "${FETCH_ENV[@]}" \
      PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-arm64 PLAYWRIGHT_BROWSERS_PATH="$build" \
      bunx "playwright@$pw" install --only-shell chromium) >"$log" 2>&1 9>&- 8>&-; then
    rm -rf "$build"; fetch_fail "$id" "playwright install failed (see $log)"; return 1
  fi
  bin=$(cd "$build" && find . -path './chromium_headless_shell-*/chrome-linux/headless_shell' -type f 2>/dev/null) || bin=""
  bin=${bin#./}
  if [[ -z "$bin" || "$bin" == *$'\n'* ]] || ! file "$build/$bin" 2>/dev/null | grep -q 'ELF 64-bit.*aarch64'; then
    rm -rf "$build"; fetch_fail "$id" "the downloaded browser is not a single linux-arm64 ELF"; return 1
  fi
  rev=${bin%%/*}; rev=${rev##*-}
  # mktemp -d made the root 0700; the clones keep that mode, so open it up for the VM user before hashing.
  if ! chmod 755 "$build" || ! mkdir "$build/bin" || ! ln -s "../$bin" "$build/bin/headless_shell" || ! hash=$(store_hash "$build"); then
    rm -rf "$build"; fetch_fail "$id" "could not finish the store layout"; return 1
  fi
  printf 'mcp_version=%s\nplaywright_version=%s\nrevision=%s\nsha256=%s\n' "${id#mcp-}" "$pw" "$rev" "$hash" >"$build/.meta" ||
    { rm -rf "$build"; fetch_fail "$id" "could not write .meta"; return 1; }
  acquire_store_lock 60 || { rm -rf "$build"; fetch_fail "$id" "the browser store is busy"; return 1; }
  if [[ -d "$(store_dir)/$id" ]]; then
    if [[ "$force" -eq 0 ]]; then release_store_lock; rm -rf "$build"; rm -f "$(store_dir)/.last-failure"; return 0; fi
    if ! perl -e 'rename($ARGV[0], $ARGV[1]) or die' "$(store_dir)/$id" "$build.old"; then
      release_store_lock; rm -rf "$build"; fetch_fail "$id" "could not move the old store aside"; return 1
    fi
  fi
  if ! perl -e 'rename($ARGV[0], $ARGV[1]) or die' "$build" "$(store_dir)/$id"; then
    if [[ -d "$build.old" ]]; then perl -e 'rename($ARGV[0], $ARGV[1])' "$build.old" "$(store_dir)/$id" || true; fi
    release_store_lock; rm -rf "$build"; fetch_fail "$id" "could not publish the store"; return 1
  fi
  rm -f "$(store_dir)/.last-failure"
  # Best effort from here: the new store is published, so cleanup problems must not report the fetch as failed.
  find "$(store_dir)" -mindepth 1 -maxdepth 1 -name 'mcp-*' ! -name "$id" -exec rm -rf {} + 9>&- 8>&- 2>/dev/null || true
  release_store_lock
  rm -rf "$build.old" 2>/dev/null || true
  return 0
}
```

`main` の case に `fetch-browsers) shift; cmd_fetch_browsers "$@" || exit $? ;;` を足す（ERR trap に失敗を拾わせない）。`fetch-browsers` は `check_health` を通らない（`main` から直接呼ぶ）。`show_help` に `agent-vm fetch-browsers [--force]  Fetch the linux-arm64 browser for VM browser MCPs` を 1 行足す。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run.sh`
期待: T2 で足したテストがすべて PASS し、最終行が `0 failed`。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): fetch a linux-arm64 headless shell into a host-side store"
```

### T3: `ensure_machine` の印とディレクトリ、マウント

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`（`ensure_machine`）
- テスト: `tests/agent-vm/run.sh`
- 参照: `home/dot_local/bin/executable_agent-vm:149-161`（`ensure_machine`）
- 参照: `tests/agent-vm/stubs/orb`（`STUB_ORB_LIST_STDOUT`、`STUB_ORB_FAIL_ON` は `$*` の部分一致）

挙動の変更: 現行は `orb list` が失敗すると「machine が無い」と同じ扱いになり、`orb create` に進む。新しいコードは `orb list` の出力を先に取り、失敗したら `die` する（fail closed）。

- [ ] **Step 1: 失敗するテストを書く**

```bash
test_new_machine_gets_browser_mount_and_marker() {
  export STUB_ORB_LIST_STDOUT="other-machine"
  ensure_machine agent-n-000000 "$TMP_ROOT" "$TMP_ROOT" >/dev/null 2>&1
  assert_contains "$(cat "$STUB_LOG")" "--mount $AGENT_VM_STATE_DIR/browsers/agent-n-000000:/opt/agent-vm/browsers" "browser mount added"
  assert_status 0 "mount marker written" -- test -f "$AGENT_VM_STATE_DIR/browser-records/agent-n-000000.mount"
}
test_new_machine_drops_a_stale_id_record() {
  mkdir -p "$AGENT_VM_STATE_DIR/browser-records"; printf 'mcp-0.0.75\n' >"$AGENT_VM_STATE_DIR/browser-records/agent-n-000000.id"
  export STUB_ORB_LIST_STDOUT="other-machine"
  ensure_machine agent-n-000000 "$TMP_ROOT" "$TMP_ROOT" >/dev/null 2>&1
  assert_status 1 "stale id removed on create" -- test -e "$AGENT_VM_STATE_DIR/browser-records/agent-n-000000.id"
}
test_existing_machine_gets_no_marker() {
  export STUB_ORB_LIST_STDOUT="agent-n-000000"
  ensure_machine agent-n-000000 "$TMP_ROOT" "$TMP_ROOT" >/dev/null 2>&1
  assert_status 1 "no marker for an existing machine" -- test -e "$AGENT_VM_STATE_DIR/browser-records/agent-n-000000.mount"
}
test_failed_orb_list_writes_no_marker_and_stops() {
  export STUB_ORB_FAIL_ON="list"
  local out; out=$(errexit_run 'ensure_machine agent-n-000000 "$TMP_ROOT" "$TMP_ROOT"')
  assert_not_contains "$out" "reached" "a failed orb list stops the launch"
  assert_status 1 "no marker when orb list failed" -- test -e "$AGENT_VM_STATE_DIR/browser-records/agent-n-000000.mount"
  assert_not_contains "$(cat "$STUB_LOG")" "orb create" "no create after a failed list"
}
test_marker_survives_a_failed_create() {
  export STUB_ORB_LIST_STDOUT="other-machine" STUB_ORB_FAIL_ON="ubuntu agent-n-000000"
  (ensure_machine agent-n-000000 "$TMP_ROOT" "$TMP_ROOT") >/dev/null 2>&1 || true
  assert_contains "$(cat "$STUB_LOG")" "orb create" "create was attempted"
  assert_status 0 "marker written before create" -- test -f "$AGENT_VM_STATE_DIR/browser-records/agent-n-000000.mount"
}
```

`errexit_run` は環境を引き継ぐので、`TMP_ROOT`、`AGENT_VM_STATE_DIR`、`STUB_LOG`、`STUB_ORB_*` はそのまま子プロセスに届く。`STUB_ORB_FAIL_ON="ubuntu agent-n-000000"` は create の argv の末尾にだけ当たる（`$TMP_ROOT` に含まれる語に当たらないよう、machine 名ごと指定する）。

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run.sh`
期待: `browser mount added`、`mount marker written`、`stale id removed on create`、`a failed orb list stops the launch`、`no create after a failed list`、`marker written before create` が FAIL。

- [ ] **Step 3: 最小実装を書く**

```bash
ensure_machine() { # machine repo_root working_tree
  local machines
  machines=$(orb list </dev/null 9>&- 8>&-) || die "could not list OrbStack machines. $FAIL_CLOSED_HINT"
  # No pipeline: under pipefail a grep -q that exits early could fail the producer and read as "no such machine".
  if awk -v n="$1" '$1 == n {f = 1} END {exit !f}' <<<"$machines"; then return 0; fi
  mkdir -p "$AGENT_VM_STATE_DIR/staging/$1" "$AGENT_VM_STATE_DIR/outbox/$1" \
    "$AGENT_VM_STATE_DIR/browsers/$1" "$AGENT_VM_STATE_DIR/browser-records"
  # The marker records the intent to create with the browser mount; written first so a create that made the
  # machine but then failed still leaves it (this function returns early for existing machines). spec K3.
  : >"$AGENT_VM_STATE_DIR/browser-records/$1.mount"
  rm -f "$AGENT_VM_STATE_DIR/browser-records/$1.id"
  step "creating isolated machine $1 (first run only)"
  orb create --isolated --isolate-network --forward-ssh-agent \
    -c "$3/agent-vm/cloud-init.yaml" \
    --mount "$2:$2" \
    --mount "$AGENT_VM_STATE_DIR/staging/$1:/opt/agent-vm/src" \
    --mount "$AGENT_VM_STATE_DIR/outbox/$1:/opt/agent-vm/outbox" \
    --mount "$AGENT_VM_STATE_DIR/browsers/$1:/opt/agent-vm/browsers" \
    ubuntu "$1" </dev/null 9>&- 8>&-
}
```

`mkdir -p` と印の作成の失敗は、既存の staging、outbox の `mkdir -p` と同じく `set -e` で起動を止める（spec K3。「ブラウザだけ省略」の対象外）。`FAIL_CLOSED_HINT` は既存の変数。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run.sh`
期待: 上の 5 テストと既存の全テスト（`orb list` の stub で machine の有無を決めるもの）が PASS し、最終行が `0 failed`。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): mount a per-machine browser dir on new machines"
```

### T4: `ensure_browsers`（判定、TOFU、複製、公開、記録）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`（新関数、`prepare_machine`）
- テスト: `tests/agent-vm/run.sh`
- 参照: `home/dot_local/bin/executable_agent-vm:554-573`（`prepare_machine`。`ensure_machine` と `maybe_bootstrap` の間に入れる）
- 参照: spec K3 の判定（判定 1〜4）

テストでは `AGENT_VM_CLONE_CMD='cp -R'` を export する（ubuntu の CI に `cp -c` が無いため）。ストアは T2 の `fetch_stubs` と `cmd_fetch_browsers` で用意する。

- [ ] **Step 1: 失敗するテストを書く**

```bash
browsers_ready() { # store published + machine marker present
  fetch_stubs 1.61.0-alpha-1778188671000; cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  mkdir -p "$AGENT_VM_STATE_DIR/browsers/agent-b-000000" "$AGENT_VM_STATE_DIR/browser-records"
  : >"$AGENT_VM_STATE_DIR/browser-records/agent-b-000000.mount"
  export AGENT_VM_CLONE_CMD='cp -R'
}
test_ensure_browsers_skips_without_marker() {
  browsers_ready; rm "$AGENT_VM_STATE_DIR/browser-records/agent-b-000000.mount"
  ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  assert_eq "" "$(ls "$AGENT_VM_STATE_DIR/browsers/agent-b-000000")" "nothing published without the marker"
}
test_ensure_browsers_publishes_current_and_records_id() {
  browsers_ready
  local out; out=$(errexit_run 'ensure_browsers agent-b-000000 "$TMP_ROOT/wt"')
  assert_contains "$out" "reached" "publishing completes under set -euo pipefail"
  local b="$AGENT_VM_STATE_DIR/browsers/agent-b-000000"
  assert_status 0 "current is a symlink" -- test -L "$b/current"
  case "$(readlink "$b/current")" in gen-mcp-0.0.75.*) record "PASS current points at a gen-<id> dir" ;; *) record "FAIL current points at a gen-<id> dir" ;; esac
  assert_status 0 "headless shell reachable through current" -- test -f "$b/current/bin/headless_shell"
  assert_eq "mcp-0.0.75" "$(cat "$AGENT_VM_STATE_DIR/browser-records/agent-b-000000.id")" "id recorded"
  assert_eq "" "$(ls "$b" | grep '^current\.' || true)" "no temporary link left behind"
}
test_ensure_browsers_is_a_no_op_when_current_and_id_match() {
  browsers_ready; ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  local before; before=$(ls "$AGENT_VM_STATE_DIR/browsers/agent-b-000000")
  ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  assert_eq "$before" "$(ls "$AGENT_VM_STATE_DIR/browsers/agent-b-000000")" "no new generation"
}
test_ensure_browsers_rebuilds_when_current_is_gone() {
  browsers_ready; ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  rm "$AGENT_VM_STATE_DIR/browsers/agent-b-000000/current"
  ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  assert_status 0 "current restored" -- test -L "$AGENT_VM_STATE_DIR/browsers/agent-b-000000/current"
}
test_ensure_browsers_rebuilds_a_dangling_current() {
  browsers_ready; ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  rm -rf "$AGENT_VM_STATE_DIR/browsers/agent-b-000000"/gen-*
  ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  assert_status 0 "a dangling current is republished" -- test -f "$AGENT_VM_STATE_DIR/browsers/agent-b-000000/current/bin/headless_shell"
}
test_ensure_browsers_keeps_old_generations() {
  browsers_ready; ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  printf 'mcp-0.0.74\n' >"$AGENT_VM_STATE_DIR/browser-records/agent-b-000000.id"
  ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  assert_eq "2" "$(ls -d "$AGENT_VM_STATE_DIR/browsers/agent-b-000000"/gen-* | wc -l | tr -d ' ')" "old generation kept while the VM may run"
}
test_ensure_browsers_warns_when_store_is_missing() {
  browsers_ready; rm -rf "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75"
  printf 'mcp-0.0.75\tnpm view failed\n' >"$AGENT_VM_STATE_DIR/browser-store/.last-failure"
  local err; err=$(ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>&1)
  assert_contains "$err" "agent-vm fetch-browsers" "recovery printed"
  assert_contains "$err" "npm view failed" "the last fetch failure is shown"
  assert_status 1 "no id recorded" -- test -e "$AGENT_VM_STATE_DIR/browser-records/agent-b-000000.id"
}
test_ensure_browsers_refuses_a_tampered_store() {
  browsers_ready
  printf 'x\n' >"$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75/chromium_headless_shell-1224/chrome-linux/headless_shell"
  local err; err=$(ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>&1)
  assert_contains "$err" "agent-vm fetch-browsers --force" "TOFU mismatch names --force"
  assert_status 1 "current not published" -- test -e "$AGENT_VM_STATE_DIR/browsers/agent-b-000000/current"
}
test_ensure_browsers_does_not_follow_a_planted_current() {
  browsers_ready; mkdir -p "$TMP_ROOT/outside"
  ln -s "$TMP_ROOT/outside" "$AGENT_VM_STATE_DIR/browsers/agent-b-000000/current"
  ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  assert_eq "" "$(ls -A "$TMP_ROOT/outside")" "nothing written through a planted symlink"
  case "$(readlink "$AGENT_VM_STATE_DIR/browsers/agent-b-000000/current")" in gen-*) record "PASS planted current replaced" ;; *) record "FAIL planted current replaced" ;; esac
}
test_ensure_browsers_warns_when_current_is_a_directory() {
  browsers_ready; mkdir -p "$AGENT_VM_STATE_DIR/browsers/agent-b-000000/current/x"
  local err; err=$(ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>&1)
  assert_contains "$err" "agent-vm rm" "a blocked current names agent-vm rm"
  assert_eq "1" "$(ls -d "$AGENT_VM_STATE_DIR/browsers/agent-b-000000"/gen-* 2>/dev/null | wc -l | tr -d ' ')" "a failed publish leaves its generation for forget_machine (no deep delete in the VM-writable tree)"
  assert_status 1 "no id recorded after a failed publish" -- test -e "$AGENT_VM_STATE_DIR/browser-records/agent-b-000000.id"
}
test_ensure_browsers_never_fails_and_closes_fd8() {
  browsers_ready
  local path out holder="" before
  for path in clone tofu store busy; do
    rm -rf "$AGENT_VM_STATE_DIR/browsers/agent-b-000000"/* "$AGENT_VM_STATE_DIR/browser-records/agent-b-000000.id"
    case "$path" in
      clone) export AGENT_VM_CLONE_CMD=false ;;
      tofu) export AGENT_VM_CLONE_CMD='cp -R'
            before=$(store_hash "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75")
            chmod 750 "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75/bin"
            if [[ "$before" != "$(store_hash "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75")" ]]; then record "PASS tofu: the store hash really changed"; else record "FAIL tofu: the store hash really changed"; fi ;;
      store) chmod 755 "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75/bin"
             mv "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75" "$TMP_ROOT/store-aside" ;;
      busy) mv "$TMP_ROOT/store-aside" "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75"
            perl -MFcntl=:flock -e 'open(my $f, ">", $ARGV[0]) or die; flock($f, LOCK_EX) or die;
              open(my $r, ">", $ARGV[1]) or die; close $r; sleep 70' \
              "$AGENT_VM_STATE_DIR/browser-store.lock" "$TMP_ROOT/held" &
            holder=$!
            for _ in $(seq 1 100); do [[ -e "$TMP_ROOT/held" ]] && break; sleep 0.1; done   # the holder has the lock first
            if [[ ! -e "$TMP_ROOT/held" ]]; then record "FAIL busy: the lock holder never started"; continue; fi ;;
    esac
    out=$(errexit_run 'ensure_browsers agent-b-000000 "$TMP_ROOT/wt"; test -e /dev/fd/8 && echo fd8-open')
    assert_contains "$out" "reached" "$path: ensure_browsers returns under set -euo pipefail"
    assert_not_contains "$out" "fd8-open" "$path: fd 8 is closed afterwards"
    assert_status 1 "$path: nothing published" -- test -e "$AGENT_VM_STATE_DIR/browsers/agent-b-000000/current"
  done
  if [[ -n "$holder" ]]; then kill "$holder" 2>/dev/null || true; fi
}
```

`busy` の経路は 60 秒の待ちを含むので、このテストは約 1 分かかる。`tofu` の経路は、ストアの中の `bin` の mode を 755 から 750 に変えて `store_hash` を食い違わせる（中身は変えない）。食い違ったことを、その場で assert する。

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run.sh`
期待: T4 で足したテストの assert が FAIL する（`ensure_browsers` が未定義）。

- [ ] **Step 3: 最小実装を書く**

```bash
ensure_browsers() { # machine working_tree; never fails: every problem is a warning and the browser is skipped (spec K3)
  local rec="$AGENT_VM_STATE_DIR/browser-records/$1" dir="$AGENT_VM_STATE_DIR/browsers/$1" id src build gen link tmp
  local -a clone
  [[ -f "$rec.mount" ]] || return 0                                                          # decision 1
  if ! id=$(browser_store_id "$2"); then step "browsers skipped: cannot read @playwright/mcp from package.json"; return 0; fi
  # decision 2: -L and -e together: a current whose target generation is gone (dangling) counts as missing.
  if [[ "$(cat "$rec.id" 2>/dev/null || true)" == "$id" && -L "$dir/current" && -e "$dir/current" ]]; then return 0; fi
  src="$(store_dir)/$id"
  if [[ ! -d "$src" ]]; then                                                                  # decision 3
    step "browsers skipped: no browser for $id yet; recover: agent-vm fetch-browsers"
    if [[ -f "$(store_dir)/.last-failure" ]]; then step "last fetch failure: $(cut -f2 "$(store_dir)/.last-failure" 2>/dev/null || true)"; fi
    return 0
  fi
  if ! acquire_store_lock 60; then step "browsers skipped: the browser store is busy"; return 0; fi  # decision 4 from here
  if [[ "$(grep '^sha256=' "$src/.meta" 2>/dev/null || true)" != "sha256=$(store_hash "$src" || true)" ]]; then
    release_store_lock; step "browsers skipped: the browser store does not match its record; recover: agent-vm fetch-browsers --force"; return 0
  fi
  read -r -a clone <<<"$(clone_cmd)"
  if ! build=$(mktemp -d "$AGENT_VM_STATE_DIR/build/browsers.XXXXXX") || ! "${clone[@]}" "$src" "$build/tree" 9>&- 8>&-; then
    release_store_lock; rm -rf "${build:-/nonexistent}" 2>/dev/null || true
    step "browsers skipped: could not clone the store; check that $AGENT_VM_STATE_DIR is on one APFS volume"; return 0
  fi
  release_store_lock
  if ! gen=$(mktemp -u "$dir/gen-$id.XXXXXXXX") || ! link=$(mktemp -u "$dir/current.XXXXXXXX"); then
    rm -rf "$build" 2>/dev/null || true; step "browsers skipped: no temporary name in $dir"; return 0
  fi
  if ! perl -e 'rename($ARGV[0], $ARGV[1]) or die' "$build/tree" "$gen" 9>&- 8>&- ||
     ! perl -e 'symlink($ARGV[0], $ARGV[1]) or die' "${gen##*/}" "$link" 9>&- 8>&- ||
     ! perl -e 'rename($ARGV[0], $ARGV[1]) or die' "$link" "$dir/current" 9>&- 8>&-; then
    # $gen is already inside the VM-writable tree, so it is left for forget_machine (spec K3: no deep delete there
    # while the VM may run). Only the link name and the host-only build dir are removed.
    rm -f "$link" 2>/dev/null || true; rm -rf "$build" 2>/dev/null || true
    step "browsers skipped: could not publish into $dir; if it persists: agent-vm rm"; return 0
  fi
  rm -rf "$build" 2>/dev/null || true
  if ! tmp=$(mktemp "$rec.id.tmp.XXXXXX") || ! printf '%s\n' "$id" >"$tmp" ||
     ! perl -e 'rename($ARGV[0], $ARGV[1]) or die' "$tmp" "$rec.id"; then
    rm -f "${tmp:-/nonexistent}" 2>/dev/null || true
    step "browsers: could not record the published id; the next launch publishes again"
  fi
  return 0
}
```

`prepare_machine` で `ensure_machine "$MACHINE" "$REPO" "$wt"` の直後に `ensure_browsers "$MACHINE" "$wt"` を足す。`set -e` の下で素の呼び出しにし、`|| true` は付けない。`$AGENT_VM_STATE_DIR/build` は、同じ `prepare_machine` の中で先に走る `build_staging` が作る。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run.sh`
期待: T4 で足したテストと既存の全テストが PASS し、最終行が `0 failed`。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): clone the browser store into each machine before bootstrap"
```

### T5: `forget_machine` の後始末

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`（`forget_machine`）
- テスト: `tests/agent-vm/run.sh`
- 参照: `home/dot_local/bin/executable_agent-vm:700-704`（`forget_machine`）、`:746-780`（`cmd_gc` と `cmd_rm` は `orb delete -f` の後に呼ぶ）
- 参照: `tests/agent-vm/run.sh:724`（root で走るときの skip の流儀）

- [ ] **Step 1: 失敗するテストを書く**

```bash
test_forget_machine_removes_browser_records_and_copies() {
  mkdir -p "$AGENT_VM_STATE_DIR/browsers/agent-g-000000/gen-x" "$AGENT_VM_STATE_DIR/browser-records"
  : >"$AGENT_VM_STATE_DIR/browser-records/agent-g-000000.mount"; : >"$AGENT_VM_STATE_DIR/browser-records/agent-g-000000.id"
  : >"$AGENT_VM_STATE_DIR/browser-records/agent-g-000000.id.tmp.abc123"
  : >"$AGENT_VM_STATE_DIR/browser-records/agent-other-000000.mount"
  forget_machine agent-g-000000 2>/dev/null
  assert_eq "agent-other-000000.mount" "$(ls "$AGENT_VM_STATE_DIR/browser-records")" "only this machine's records removed"
  assert_status 1 "browser copies removed" -- test -e "$AGENT_VM_STATE_DIR/browsers/agent-g-000000"
}
test_forget_machine_removes_a_dir_the_vm_locked_down() {
  if [[ "$(id -u)" -eq 0 ]]; then record "PASS locked-down dir removed (skipped: running as root)"; return 0; fi
  mkdir -p "$AGENT_VM_STATE_DIR/browsers/agent-g-000000/locked/inner"; chmod 000 "$AGENT_VM_STATE_DIR/browsers/agent-g-000000/locked"
  local out; out=$(errexit_run 'forget_machine agent-g-000000')
  assert_contains "$out" "reached" "forget_machine does not abort"
  assert_status 1 "locked-down dir removed" -- test -e "$AGENT_VM_STATE_DIR/browsers/agent-g-000000"
}
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run.sh`
期待: `only this machine's records removed`、`browser copies removed`、`locked-down dir removed` が FAIL。

- [ ] **Step 3: 最小実装を書く**

```bash
forget_machine() { # machine: host-side state for one machine (host-authored env files are kept)
  rm -rf "$AGENT_VM_STATE_DIR/staging/$1" "$AGENT_VM_STATE_DIR/outbox/$1" \
    "$AGENT_VM_STATE_DIR/snapshots/$1" "$AGENT_VM_STATE_DIR/ingested/$1" \
    "$(meta_path "$1")" "$AGENT_VM_STATE_DIR/machines/$1.lock"
  rm -f "$AGENT_VM_STATE_DIR/browser-records/$1".* 2>/dev/null || true
  # Callers run this only after `orb delete` succeeded, so no VM can write into the tree while it is removed.
  # chmod first: the VM may have dropped permissions on dirs inside its copy.
  if [[ -e "$AGENT_VM_STATE_DIR/browsers/$1" ]]; then
    chmod -R u+rwX "$AGENT_VM_STATE_DIR/browsers/$1" 2>/dev/null || true
    rm -rf "$AGENT_VM_STATE_DIR/browsers/$1" 2>/dev/null || step "could not fully remove $AGENT_VM_STATE_DIR/browsers/$1; remove it by hand"
  fi
}
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run.sh`
期待: 全テスト PASS、最終行が `0 failed`。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): remove browser records and copies with the machine"
```

### T6: apply のたびに取得する darwin 専用 script

**Files:**

- 新規: `home/.chezmoiscripts/run_after_50-agent-vm-fetch-browsers.sh.tmpl`
- 編集: `tests/agent-vm/run-templates.sh`（非 darwin で中身が空になることのテスト）
- 参照: `home/.chezmoiscripts/run_after_10-install-textlint-deps.sh.tmpl`（`run_after_` の流儀）
- 参照: `home/.chezmoiignore:84-93`（script は `run_after_` を除いたターゲット名で照合される。ここには足さない）

`.chezmoiignore` には足さず、テンプレート全体を `{{ if eq .chezmoi.os "darwin" }}` で囲む。chezmoi は、描画結果が空の script を実行しない。VM ブロックの `**` 除外にも当たるので、VM の期待リスト（K20）は変わらない。

- [ ] **Step 1: 失敗するテストを書く**

`tests/agent-vm/run-templates.sh` の既存の描画ヘルパー `render <template_relpath> <override_json>`（`run-templates.sh:12`。`--source "$SRC"` 付きで `chezmoi execute-template --override-data` を呼ぶ）を使う。Round 2 のレビューで、`{"chezmoi":{"os":"linux"}}` で空になり、`darwin` で描画されることを確かめ済み。

```bash
test_fetch_browsers_script_is_darwin_only() {
  local t=.chezmoiscripts/run_after_50-agent-vm-fetch-browsers.sh.tmpl
  assert_eq "" "$(render "$t" '{"chezmoi":{"os":"linux"}}' | tr -d '[:space:]')" "renders empty on linux"
  assert_contains "$(render "$t" '{"chezmoi":{"os":"darwin"}}')" "agent-vm\" fetch-browsers" "renders the fetch on darwin"
}
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run-templates.sh`
期待: テンプレートが無いので FAIL。

- [ ] **Step 3: script を書く**

```bash
{{ if eq .chezmoi.os "darwin" -}}
#!/usr/bin/env bash
# Keep the host-side linux-arm64 browser store for agent-vm in step with package.json (docs/decisions/0018, K23).
# Runs on every apply; agent-vm fetch-browsers is a no-op without network when the store is current.
set -euo pipefail
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"
# fetch-browsers prints its own one-line warning with the recovery; nothing is added here.
"$HOME/.local/bin/agent-vm" fetch-browsers --from-apply {{ .chezmoi.workingTree | shellQuote }} || true
exit 0
{{ end -}}
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run-templates.sh`、`bash tests/agent-vm/run.sh`
期待: どちらも `0 failed`。

- [ ] **Step 5: コミット**

```bash
git add home/.chezmoiscripts/run_after_50-agent-vm-fetch-browsers.sh.tmpl tests/agent-vm/run-templates.sh
git commit -m "feat(agent-vm): fetch the VM browser store on every apply on macOS"
```

## ISO 25010 具体テストケース

### 機能適合性

- **入力**: `package.json` の `@playwright/mcp` が `0.0.75`、npm が `playwright: 1.61.0-alpha-1778188671000` を返す → **期待**: `browser-store/mcp-0.0.75/bin/headless_shell` が `../chromium_headless_shell-1224/chrome-linux/headless_shell` を指し、`.meta` に 4 つのキーがある（T2）。
- **入力**: `.mount` あり、ストアあり、`.id` 無し → **期待**: `browsers/<m>/current` が `gen-mcp-0.0.75.*` を指す symlink になり、`.id` が `mcp-0.0.75` になる（T4）。

### 信頼性

- **入力**: 複製の失敗、TOFU の不一致、ストア無し、ロックの待ちが上限を超える → **期待**: どの経路でも、`set -euo pipefail` の別プロセスで `ensure_browsers` の後の行に到達し、fd 8 が閉じている（T4）。
- **入力**: `orb list` が失敗 → **期待**: 起動は止まり、`.mount` は書かれず、`orb create` は呼ばれない（T3）。
- **入力**: `orb create` が失敗 → **期待**: `.mount` は残る（T3）。
- **入力**: `fetch-browsers` を CLI で実行し、取得が失敗する → **期待**: 終了コード 1、stderr に `unexpectedly` を含まない（T2）。
- **入力**: `npm view` か `bunx` が戻らない → **期待**: `run_bounded` がそれぞれ 120 秒、900 秒で打ち切る（T1 の `run_bounded` のテストで機構を確かめる）。

### セキュリティ

- **入力**: `browsers/<m>/current` を、外のディレクトリへの symlink にしておく → **期待**: 外のディレクトリは空のまま。`current` は `gen-*` を指す symlink に置き換わる（T4）。
- **入力**: `EVIL=1 PLAYWRIGHT_DOWNLOAD_HOST=http://evil NO_PROXY='*.local, 10.0.0.0/8'` を付けて `fetch-browsers` → **期待**: bunx の環境に `EVIL` と `PLAYWRIGHT_DOWNLOAD_HOST` が無く、`NO_PROXY` は値がそのまま届く（T2）。
- **入力**: `file` が Mach-O を返す → **期待**: 終了コード 1。`browser-store/mcp-0.0.75` は作られない（T2）。

### 互換性

- **入力**: 既存の `bash tests/agent-vm/run.sh`、`run-templates.sh` → **期待**: 変更前からある全テストが PASS のまま（T3〜T6）。
- **入力**: linux のデータで fetch-browsers の script を描画 → **期待**: 空になる（T6）。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘（いずれも実機で再現した指摘）:
  - perl の `{"@playwright/mcp"}` で配列が展開され、id が常に空になる。
  - `tr | head` が SIGPIPE を起こし、`set -e` で止まる。
  - テストで errexit が効いていない。
  - `env -i` が `STUB_LOG` を消す。
  - stub の変数が export されていない。
  - `.chezmoiignore` のターゲット名が違う。
- 対応: 全面的に書き直して反映した。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘:
  - `tr | head` の SIGPIPE。
  - `bin=` の pipefail。
  - テストの抜け（公開済みの扱い、ロックの待ち、`.last-failure` の表示）。
  - `clone_cmd` の根拠を明記すること。
- 対応: 反映した。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘:
  - `$(env | grep)` の語分割と、`MISE_*` の広すぎる許可。
  - `tr | head`。
  - `current` がディレクトリに変えられた場合。
  - `$pw` を無害化していない。
  - `clone_cmd` を引用符なしで展開している。
- 対応:
  - 固定の名前を配列で渡すようにした。
  - `mktemp -u` を使うようにした。
  - `current` がディレクトリなら警告し、`agent-vm rm` を案内する。
  - 理由の文字列を無害化した。
  - `clone_cmd` は `read -a` で受けるようにした。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘:
  - `.chezmoiignore` のターゲット名。
  - bunx の stub のログが失われる。
  - `orb list` が失敗したときの挙動が変わる。
  - perl で 337MB を読み込む。
  - root で走ったときのテストの扱い。
- 対応:
  - script はテンプレートの darwin のガードで扱う。
  - `addfile` を使うようにした。
  - root のときは skip する。
  - 挙動の変更を T3 に明記した。

### resilience-analyzer
- verdict: needs-work
- 主指摘:
  - `ensure_browsers` が errexit の下で止まる。
  - `--force` で公開に失敗したときに旧ストアを戻していない。
  - 掃除の失敗で abort する。
  - CLI では ERR trap が重ねて報告する。
  - ネットワークの待ちに上限が無い。
  - `.meta` の hash が空になりうる。
- 対応:
  - errexit の別プロセスで確かめるテストを足した。
  - 旧ストアを戻すようにした。
  - 掃除は best-effort にした。
  - CLI からは `|| exit` で受ける。
  - `run_bounded` を足した。
  - hash は検査してから書く。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: needs-work
- 主指摘:
  - `--force` のテストが、`build/` に残るログのせいで必ず落ちる。
  - `tofu` の経路では mode が変わらず、TOFU の不一致が起きない。
  - T6 は既存の `render` を使っていない。
  - `kill %1` は確実に効かない。
- 対応:
  - ログはストアの側（`.fetch.log`）に移した。
  - mode を 750 にして、hash が変わったことを assert した。
  - `render` を使うようにした。
  - `$!` で止めるようにした。

### scope-justification-reviewer
- verdict: pass
- 主指摘: low のみ。
  - `run_bounded` の秒数の根拠と、許可リストが spec より狭いことを、前提に書く。
  - busy の経路にかかる時間を注記する。
  - `--override-data` が効くかを実際に確かめる。
  - いずれも反映した。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘:
  - `--force` のテストの `build/` が空にならない。
  - `ensure_machine` の `printf | awk | grep -q` が SIGPIPE を受けると、fail-open になる。
  - `tofu` の経路が空振りしている。
  - `gen-*` の mode が 0700 のまま。
  - `run_bounded` は子プロセスを止めきれない。
- 対応:
  - ログを移した。
  - 判定をパイプを使わない awk にした。
  - mode を 750 に変えた。
  - ストアのルートを 755 にした。
  - `run_bounded` の限界は前提に書いた。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘:
  - `tofu` の経路が空振りしている。
  - 公開に失敗すると `gen-*` が孤児になる。
  - T6 は `render` を使っていない。
  - busy の経路の後始末。
  - 理由の文字列の無害化を確かめていない。
- 対応:
  - 失敗の経路で `gen` を消し、その assert を足した。
  - `render` を使うようにした。
  - `$!` で止めるようにした。
  - パスが読める形で残ることのテストを足した。

### resilience-analyzer
- verdict: needs-work
- 主指摘:
  - `tofu` の経路が空振りしている。
  - busy の経路に競合がある。
  - apply が最大で約 17 分止まる。
  - `current` が dangling になる。
  - `ensure_machine` でパイプを使っている。
- 対応:
  - ロックの取得をファイルで知らせ、テストはそれを待つ。
  - apply から呼ぶときの上限を 30 秒と 300 秒にした。
  - 判定に `-e` を足した。
  - `ensure_machine` の判定を awk だけで行うようにした。

<!-- auto-review: verdict=needs-work; hash=377a9cd93ebed926ee909de8c4370d5a30117907b6de4566662a08767245e26d; design-hash=4f7c6bb9781701a74cc2f43aacf137f5b851dad4a5dee1a586d3c6482cc3f93f; round=1; parent-spec-hash=369753b259efd4af68a6cd5c35a37403650a06f3b5b674095f0604ad41711fa3; at=2026-10-01T13:56:24.413Z; reviewers=logic-validator+scope-justification-reviewer+security-vulnerability-analyzer+data-contract-evolution-evaluator+resilience-analyzer -->
<!-- intent-triage: adopted=30; excluded=0; at=2026-10-01T13:56:24.470Z -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: pass
- 主指摘: low のみ。
  - busy の経路の待ちに上限が無い（上限を付けた）。
  - errexit_run が stderr を捨てている（ファイルに残すようにした）。
  - mode 000 のディレクトリが残る。
  - `%q` を前提にしている。

### scope-justification-reviewer
- verdict: pass
- 主指摘: low のみ。
  - dangling の判定が spec との差分（前提に書いた）。
  - テスト数の記述（件数を書かない形に直した）。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘:
  - 公開に失敗した経路で、`rm -rf "$gen"` が VM の書き込めるツリーを深く消す。spec K3 の不変条件に反する。
  - `npm view` が呼び出し元の cwd と環境で動く。
  - テンプレートで `quote` を使っている。
- 対応:
  - `$gen` は消さずに `forget_machine` に任せ、テストも「1 つ残る」に直した。
  - `npm view` を `env -i` と build の cwd で動かすようにした。
  - `shellQuote` に変えた。

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: low のみ。
  - 無害化のテストが `TMPDIR` の文字に依存する。
  - `bunx` の shim は実機で確かめる。

### resilience-analyzer
- verdict: pass
- 主指摘: low のみ。
  - `exec 8>` が失敗したら止まる（`{ }` で受けるようにした）。
  - ERR trap は CLI のテストで確かめている。
  - `run_bounded` の限界。

<!-- auto-review: verdict=needs-work; hash=e7e5d8dfcb1807b133795d2484bef82b539ae42742368019ad48488788dc1911; design-hash=2a5bc39ac49bdd34cab26429225cd5618ac1e4fc1f6e9b303607a1ba8362f190; round=2; parent-spec-hash=369753b259efd4af68a6cd5c35a37403650a06f3b5b674095f0604ad41711fa3; at=2026-10-01T14:01:30.576Z; reviewers=logic-validator+scope-justification-reviewer+security-vulnerability-analyzer+data-contract-evolution-evaluator+resilience-analyzer -->
<!-- intent-triage: adopted=19; excluded=0; at=2026-10-01T14:01:30.632Z -->

## Reviewer Outputs (Round 4)

### logic-validator
- verdict: pass
- 主指摘: low のみ。
  - Round 3 からの変更は、互いに矛盾していない。
    - `FETCH_ENV` の定義は、それを使う 2 か所より前にある。
    - `build/` は `npm view` の前に作られる。
    - `gen` を消さない処理と、テストの期待が一致している。
    - busy の経路と fd 8 の扱いが合っている。
  - `errexit_run` は、run.sh が export する変数を前提にしている。run.sh の末尾のループで `TMP_ROOT` と `AGENT_VM_STATE_DIR` を export していることは確認済み。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: Round 3 の指摘は閉じた。
  - VM の稼働中に、VM が書き込めるツリーを深く消す経路は残っていない。
  - low: 公開に失敗した `gen` は、`agent-vm rm` を実行するまで残る。clone の分だけディスクを使うが、host や他の VM に影響する経路ではない。

### scope-justification-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### resilience-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=f3ac439fc02f8760f49eed584469dde8eb89c84854bc16919247bfa6fd6e1c60; design-hash=c98e54e75ca9c935a6b08db7850b80bb06f14f314c01a471334c04c9b2a6749e; round=3; parent-spec-hash=369753b259efd4af68a6cd5c35a37403650a06f3b5b674095f0604ad41711fa3; at=2026-10-01T14:23:15.860Z; reviewers=logic-validator+scope-justification-reviewer+security-vulnerability-analyzer+data-contract-evolution-evaluator+resilience-analyzer -->
<!-- intent-triage: adopted=12; excluded=0; at=2026-10-01T14:23:15.882Z -->

<!-- auto-review: verdict=pass; hash=6a0efa34fb6c51fecceb831f9e284cb7916f3076b03364040c34a8a39196d36c; design-hash=c98e54e75ca9c935a6b08db7850b80bb06f14f314c01a471334c04c9b2a6749e; round=4; parent-spec-hash=369753b259efd4af68a6cd5c35a37403650a06f3b5b674095f0604ad41711fa3; at=2026-10-01T14:29:27.282Z; reviewers=logic-validator+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=2; excluded=0; at=2026-10-01T14:29:27.301Z -->
