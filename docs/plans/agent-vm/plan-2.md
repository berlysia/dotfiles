<!-- spec-ref: spec.md -->

# Plan 2: ログ回収と git 面検査（host 側）

spec の K9（outbox の取り込み）・K13（host で実行されるが `git diff` に出ない面の検査）と、Architecture の手順 4・5・9（起動時の catch-up、終了時の取り込みと検査）、`agent-vm sync [--inspect]` / `agent-vm restore-git [repo]` を、plan-1 で実装済みの launcher（`home/dot_local/bin/executable_agent-vm`）に追加する。

plan-1 と同じ共通制約に従う（bash 3.2、`set -euo pipefail` 下で関数末尾に `[[ … ]] && …` を置かない、lock 保持中の外部コマンドは `9>&-`、本番コードにテスト専用分岐を置かない、`orb`/`op`/`chezmoi` は stub）。追加の制約:
- outbox（VM が書ける）内のファイルは、bash のリダイレクトでは読まない（読む瞬間に symlink へ差し替えられると host 上の別ファイルを読んでしまうため）。代わりに perl の読み取り helper `outbox_read` で読む。helper は、親ディレクトリの realpath が outbox の tree root 配下にあることを確かめたうえで、`O_NOFOLLOW` で開いて通常ファイルであることを fstat で確かめる。サイズ取得と、指定オフセット・長さの読み出しはこの helper が行い、比較は `outbox_read … | cmp -s - dest` で行う（`stat` の書式と `cmp -n` の有無は macOS と Linux で違うが、この方式はその違いに依存しない）。
- `outbox_read` に残る競合: realpath の確認から `sysopen` までの間に、途中のディレクトリを symlink に差し替えられる余地は残る（`O_NOFOLLOW` が効くのは最後の要素だけ）。成功しても起きるのは「host 上の別の `*.jsonl` が host の `~/.claude/projects` に写る」ことだけで、VM はその写しを読めず持ち出し経路にならないので、受容する。
- lock 中の `9>&-` は、lock を解放した後も生き残りうる子プロセス（`orb` や `rsync` 等、plan-1 の範囲）に付ける規則とする。本 plan で lock 中に起動する git / perl / awk / find / shasum / sort / cmp は、関数が戻る前に必ず終了するので付けない。
- VM が書ける repo の `.git` に対して git を repo 文脈で実行するとき（`ls-files`、および plan-1 の `resolve_repo_root` の `rev-parse`）は、`-c core.fsmonitor= -c core.hooksPath=/dev/null --no-optional-locks` を付ける。VM が置いた設定が host 上でプログラムを起動しないようにするため。設定値の読み取りは `git config --file`（include を辿らず、プログラムも起動しない）で行う。
- 取り込み先はテストで差し替えられるよう `AGENT_VM_CLAUDE_PROJECTS_DIR`（既定 `~/.claude/projects`）と `AGENT_VM_CODEX_SESSIONS_DIR`（既定 `~/.codex/sessions`）で上書きできる。終了時の lock 待ち上限は `AGENT_VM_FINISH_WAIT`（既定 60 秒）。
- 終了コード: 0 = 正常、3 = git 面に差分、4 = ログが host の写しと食い違い取り込まなかった、5 = 終了時に lock が取れず処理を省略。spec が数値を定めているのは K13 の「終了コードで知らせる」だけだが、K9（食い違いの警告）と K1（lock 取得失敗の警告）も同じく「人の対応が要る状態」なので、スクリプトや CI から区別できるよう番号を分ける。重なったときは 3 > 4 を優先する（host 権限で実行されうる改変のほうが、取り込めなかったログより重いため。4 の警告行は常に表示される）。5 は取り込みも検査もしていない状態なので、3・4 とは同時に起きない。ツール自体が非 0 で終わった場合は、その値を優先する（利用者がまず知りたいのはツールの結果で、3〜5 の内容は stderr に残る）。

## Files

```
# 編集
home/dot_local/bin/executable_agent-vm
tests/agent-vm/run.sh
```

## Tasks

### T1: outbox の取り込み（K9）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`、テスト: `tests/agent-vm/run.sh`
- 参照: `home/dot_local/bin/executable_agent-vm` の `forget_machine`（`ingested/<machine>` を掃除対象に含む。本タスクがその中身を作る）
- 参照: spec K9（取り込み規則 4 分岐、`.ingested` は host 側、symlink 無視、食い違いは警告して取り込まない）

- [ ] **Step 1: 失敗するテスト**

```bash
setup_ingest() { # -> sets OB (outbox claude dir) and HP (host projects dir)
  export AGENT_VM_CLAUDE_PROJECTS_DIR="$TMP_ROOT/host-projects" AGENT_VM_CODEX_SESSIONS_DIR="$TMP_ROOT/host-codex"
  OB="$AGENT_VM_STATE_DIR/outbox/agent-i-000000/claude-projects/-repo"
  HP="$AGENT_VM_CLAUDE_PROJECTS_DIR/-repo"
  mkdir -p "$OB" "$AGENT_VM_STATE_DIR/build"
}
test_ingest_copies_new_and_appends_growth() {
  setup_ingest
  printf 'a\n' >"$OB/s.jsonl"
  ingest_outbox agent-i-000000 2>/dev/null
  assert_eq "a" "$(cat "$HP/s.jsonl")" "new log copied"
  printf 'b\n' >>"$OB/s.jsonl"
  ingest_outbox agent-i-000000 2>/dev/null
  assert_eq "$(printf 'a\nb')" "$(cat "$HP/s.jsonl")" "appended tail only"
}
test_ingest_refuses_rewritten_prefix() {
  setup_ingest
  printf 'a\n' >"$OB/s.jsonl"; ingest_outbox agent-i-000000 2>/dev/null
  printf 'X\nlonger\n' >"$OB/s.jsonl"
  local status=0 err; err=$(ingest_outbox agent-i-000000 2>&1) || status=$?
  assert_eq 4 "$status" "divergence reported by status"
  assert_contains "$err" "agent-vm sync --inspect" "recover hint names the command"
  assert_eq "a" "$(cat "$HP/s.jsonl")" "host copy untouched"
  status=0; ingest_outbox agent-i-000000 2>/dev/null || status=$?
  assert_eq 4 "$status" "still reported on the next run (not recorded)"
}
test_ingest_refuses_truncation() {
  setup_ingest
  printf 'abc\n' >"$OB/s.jsonl"; ingest_outbox agent-i-000000 2>/dev/null
  printf 'a\n' >"$OB/s.jsonl"
  local status=0; ingest_outbox agent-i-000000 2>/dev/null || status=$?
  assert_eq 4 "$status" "truncation reported"
  assert_eq "abc" "$(cat "$HP/s.jsonl")" "host copy untouched"
}
test_ingest_ignores_symlinks_and_non_jsonl() {
  setup_ingest
  printf 'secret\n' >"$TMP_ROOT/outside.jsonl"
  ln -s "$TMP_ROOT/outside.jsonl" "$OB/link.jsonl"
  printf 'x\n' >"$OB/notes.txt"
  ingest_outbox agent-i-000000 2>/dev/null
  assert_status 1 "symlinked log ignored" -- test -e "$HP/link.jsonl"
  assert_status 1 "non-jsonl ignored" -- test -e "$HP/notes.txt"
}
test_ingest_ignores_symlinked_tree_root() {
  export AGENT_VM_CLAUDE_PROJECTS_DIR="$TMP_ROOT/host-projects" AGENT_VM_CODEX_SESSIONS_DIR="$TMP_ROOT/host-codex"
  mkdir -p "$AGENT_VM_STATE_DIR/outbox/agent-i-000000" "$AGENT_VM_STATE_DIR/build" "$TMP_ROOT/elsewhere/-repo"
  printf 'x\n' >"$TMP_ROOT/elsewhere/-repo/s.jsonl"
  ln -s "$TMP_ROOT/elsewhere" "$AGENT_VM_STATE_DIR/outbox/agent-i-000000/claude-projects"
  ingest_outbox agent-i-000000 2>/dev/null
  assert_status 1 "symlinked root not followed" -- test -e "$AGENT_VM_CLAUDE_PROJECTS_DIR/-repo/s.jsonl"
}
test_ingest_recopies_after_host_deletion_and_tolerates_bad_records() {
  setup_ingest
  printf 'a\n' >"$OB/s.jsonl"; ingest_outbox agent-i-000000 2>/dev/null
  rm "$HP/s.jsonl"
  printf 'garbage line without tabs\n' >>"$AGENT_VM_STATE_DIR/ingested/agent-i-000000"
  ingest_outbox agent-i-000000 2>/dev/null
  assert_eq "a" "$(cat "$HP/s.jsonl")" "re-copied after host deletion"
  assert_eq "format=1" "$(head -1 "$AGENT_VM_STATE_DIR/ingested/agent-i-000000")" "record header"
}
test_ingest_handles_codex_sessions_tree() {
  setup_ingest
  mkdir -p "$AGENT_VM_STATE_DIR/outbox/agent-i-000000/codex-sessions/2026/09"
  printf 'c\n' >"$AGENT_VM_STATE_DIR/outbox/agent-i-000000/codex-sessions/2026/09/r.jsonl"
  ingest_outbox agent-i-000000 2>/dev/null
  assert_eq "c" "$(cat "$AGENT_VM_CODEX_SESSIONS_DIR/2026/09/r.jsonl")" "codex session ingested"
}
```

- [ ] **Step 2: 失敗を確認** — 期待: 7 件 FAIL。

- [ ] **Step 3: 最小実装**（launcher 先頭の既定値群に 2 行追加し、関数群を `env_files_for` の前に置く）

```bash
CLAUDE_PROJECTS_DIR="${AGENT_VM_CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"
CODEX_SESSIONS_DIR="${AGENT_VM_CODEX_SESSIONS_DIR:-$HOME/.codex/sessions}"
```

```bash
# Reads a file inside a VM-writable tree without following symlinks.
# usage: outbox_read size|range <tree_root> <relpath> [offset length]; exit 2 = refused
OUTBOX_READ_PL='
use strict; use Fcntl qw(O_RDONLY O_NOFOLLOW O_NONBLOCK); use Cwd qw(realpath); use File::Basename qw(dirname);
my ($mode, $root, $rel, $off, $len) = @ARGV;
my $rroot = realpath($root); exit 2 unless defined $rroot;
my $rdir = realpath(dirname("$root/$rel")); exit 2 unless defined $rdir;
exit 2 unless $rdir eq $rroot || index($rdir, "$rroot/") == 0;
# O_NONBLOCK: opening a planted FIFO returns at once instead of hanging; fstat then rejects it.
sysopen(my $fh, "$root/$rel", O_RDONLY | O_NOFOLLOW | O_NONBLOCK) or exit 2;
my @st = stat($fh); exit 2 unless -f _;
if ($mode eq "size") { print $st[7], "\n"; exit 0 }
exit 2 unless $mode eq "range";
binmode $fh; binmode STDOUT;
sysseek($fh, $off, 0) or exit 2 if $off > 0;
my $left = $len;
while ($left > 0) {
  my $n = sysread($fh, my $buf, $left > 65536 ? 65536 : $left);
  exit 2 unless defined $n; last if $n == 0;
  print $buf; $left -= $n;
}
exit 0;
'
outbox_read() { perl -e "$OUTBOX_READ_PL" "$@"; }

file_size() { wc -c <"$1" | tr -d ' '; } # host-owned files only
ingested_path() { printf '%s/ingested/%s\n' "$AGENT_VM_STATE_DIR" "$1"; }

ingested_lookup() { # machine key -> "osize hsize" from the host-side record (malformed lines ignored)
  local f
  f=$(ingested_path "$1")
  if [[ ! -f "$f" ]]; then return 0; fi
  awk -F'\t' -v k="$2" 'NR > 1 && NF == 3 && $1 == k && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ { r = $2 " " $3 } END { if (r != "") print r }' "$f"
}

ingest_tree() { # machine subdir dest mode(apply|inspect); uses INGEST_RECORDS / INGEST_DIVERGED
  local src="$AGENT_VM_STATE_DIR/outbox/$1/$2" dest=$3 mode=$4 rel key osize hsize prev
  # The outbox is VM-writable: never follow a symlinked tree root.
  if [[ ! -d "$src" || -L "$src" ]]; then return 0; fi
  while IFS= read -r -d '' rel; do
    rel=${rel#./}
    case "$rel" in *$'\t'* | *$'\n'*) step "skipping a log with an unsupported name under $2"; continue ;; esac
    key="$2/$rel"
    if ! osize=$(outbox_read size "$src" "$rel"); then
      step "skipping a log that is not a regular file inside the outbox: $key"
      continue
    fi
    hsize=0
    if [[ -f "$dest/$rel" ]]; then hsize=$(file_size "$dest/$rel"); fi
    prev=$(ingested_lookup "$1" "$key")
    if [[ "$mode" == apply && "$prev" == "$osize $hsize" ]]; then
      printf '%s\t%s\t%s\n' "$key" "$osize" "$hsize" >>"$INGEST_RECORDS"
      continue
    fi
    if [[ ! -f "$dest/$rel" ]]; then
      if [[ "$mode" == inspect ]]; then printf 'new\t%s\n' "$key"; continue; fi
      mkdir -p "$(dirname "$dest/$rel")"
      outbox_read range "$src" "$rel" 0 "$osize" >"$dest/$rel" || { rm -f "$dest/$rel"; continue; }
      hsize=$osize
    elif [[ "$osize" -gt "$hsize" ]] && outbox_read range "$src" "$rel" 0 "$hsize" | cmp -s - "$dest/$rel"; then
      if [[ "$mode" == inspect ]]; then printf 'append\t%s\n' "$key"; continue; fi
      outbox_read range "$src" "$rel" "$hsize" "$((osize - hsize))" >>"$dest/$rel" || continue
      hsize=$osize
    elif [[ "$osize" -eq "$hsize" ]] && outbox_read range "$src" "$rel" 0 "$osize" | cmp -s - "$dest/$rel"; then
      if [[ "$mode" == inspect ]]; then continue; fi
    else
      # Not recorded, so it is reported again on every run until someone looks at it.
      if [[ "$mode" == inspect ]]; then printf 'diverged\t%s\t(outbox %s bytes, host %s bytes)\n' "$key" "$osize" "$hsize"; continue; fi
      printf '%s\n' "$key" >>"$INGEST_DIVERGED"
      step "log diverged from the host copy, not ingested: $key"
      continue
    fi
    printf '%s\t%s\t%s\n' "$key" "$osize" "$hsize" >>"$INGEST_RECORDS"
  done < <(cd "$src" && find . -type f -name '*.jsonl' -print0)
}

# Sets the INGEST_RECORDS / INGEST_DIVERGED globals that ingest_tree appends to.
ingest_outbox() { # machine -> 0, or 4 when some logs diverged from their host copies
  local tmp status=0 repo
  mkdir -p "$AGENT_VM_STATE_DIR/build" "$AGENT_VM_STATE_DIR/ingested"
  tmp=$(mktemp -d "$AGENT_VM_STATE_DIR/build/ingest.XXXXXX")
  INGEST_RECORDS="$tmp/records"
  INGEST_DIVERGED="$tmp/diverged"
  : >"$INGEST_RECORDS"
  : >"$INGEST_DIVERGED"
  ingest_tree "$1" claude-projects "$CLAUDE_PROJECTS_DIR" apply
  ingest_tree "$1" codex-sessions "$CODEX_SESSIONS_DIR" apply
  { printf 'format=1\n'; cat "$INGEST_RECORDS"; } >"$(ingested_path "$1")"
  if [[ -s "$INGEST_DIVERGED" ]]; then
    repo=$(read_meta_field "$1" repo_path 2>/dev/null) || repo="<repo of $1>"
    step "recover: cd $repo && agent-vm sync --inspect"
    status=4
  fi
  rm -rf "$tmp"
  return "$status"
}

inspect_outbox() { # machine -> prints new/append/diverged lines without writing anything
  ingest_tree "$1" claude-projects "$CLAUDE_PROJECTS_DIR" inspect
  ingest_tree "$1" codex-sessions "$CODEX_SESSIONS_DIR" inspect
}
```

- [ ] **Step 4: 通過を確認** — 実行: `bash tests/agent-vm/run.sh` / 期待: `0 failed`。
- [ ] **Step 5: コミット** — `feat(agent-vm): ingest VM session logs by verified append into host history`

### T2: git 面のマニフェストと差分検出（K13）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`、テスト: `tests/agent-vm/run.sh`
- 参照: spec K13（監視対象・realpath と `core.hooksPath` 先の hash・版上げ時は新しい種類だけ baseline 追加・差分のある項目は baseline を更新しない）
- 参照: git-config(1)（`--get-regexp` は section と key を小文字化した正規名で照合する。`--null` で `名前\n値\0` を出す）

- [ ] **Step 1: 失敗するテスト**

```bash
make_git_repo() { # -> repo path with one commit
  local repo="$TMP_ROOT/g-repo"
  mkdir -p "$repo" && git -C "$repo" init -q
  git -C "$repo" -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -q --allow-empty -m init
  (cd -P "$repo" && pwd -P)
}
surface_status() { # machine repo -> exit status of check_git_surfaces
  local s=0; check_git_surfaces "$1" "$2" >/dev/null 2>&1 || s=$?; printf '%s\n' "$s"
}
test_first_check_baselines_silently() {
  local repo; repo=$(make_git_repo)
  assert_eq 0 "$(surface_status agent-g-000000 "$repo")" "first run is clean"
  assert_status 0 "baseline written" -- test -f "$AGENT_VM_STATE_DIR/snapshots/agent-g-000000/baseline"
}
test_added_hook_is_reported_until_resolved() {
  local repo; repo=$(make_git_repo); surface_status agent-g-000000 "$repo" >/dev/null
  printf '#!/bin/sh\necho pwned\n' >"$repo/.git/hooks/post-checkout"
  local out; out=$(check_git_surfaces agent-g-000000 "$repo" 2>&1) || true
  assert_contains "$out" "added" "added hook reported"
  assert_contains "$out" "post-checkout" "names the hook"
  assert_contains "$out" "recover: agent-vm restore-git" "recover hint"
  assert_eq 3 "$(surface_status agent-g-000000 "$repo")" "still reported on the next check"
}
test_changed_hook_and_redirected_hooks_dir_are_reported() {
  local repo; repo=$(make_git_repo)
  printf '#!/bin/sh\n' >"$repo/.git/hooks/pre-commit"; surface_status agent-g-000000 "$repo" >/dev/null
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  assert_eq 3 "$(surface_status agent-g-000000 "$repo")" "changed hook content"
  local repo2="$TMP_ROOT/g2"; mkdir -p "$repo2" && git -C "$repo2" init -q; repo2=$(cd -P "$repo2" && pwd -P)
  surface_status agent-g-000001 "$repo2" >/dev/null
  mkdir -p "$TMP_ROOT/evil-hooks"; printf '#!/bin/sh\n' >"$TMP_ROOT/evil-hooks/pre-push"
  rm -rf "$repo2/.git/hooks"; ln -s "$TMP_ROOT/evil-hooks" "$repo2/.git/hooks"
  assert_eq 3 "$(surface_status agent-g-000001 "$repo2")" "hooks dir replaced by a symlink"
}
test_exec_config_keys_are_reported_but_benign_keys_are_not() {
  local repo; repo=$(make_git_repo); surface_status agent-g-000000 "$repo" >/dev/null
  git -C "$repo" config branch.main.remote origin
  assert_eq 0 "$(surface_status agent-g-000000 "$repo")" "benign config ignored"
  git -C "$repo" config core.fsmonitor "sh -c 'echo pwned'"
  assert_eq 3 "$(surface_status agent-g-000000 "$repo")" "core.fsmonitor reported"
}
test_hookspath_target_contents_are_hashed() {
  local repo; repo=$(make_git_repo)
  mkdir -p "$repo/tools/hooks"; printf '#!/bin/sh\n' >"$repo/tools/hooks/pre-commit"
  git -C "$repo" config core.hooksPath tools/hooks
  surface_status agent-g-000000 "$repo" >/dev/null
  printf '#!/bin/sh\necho changed\n' >"$repo/tools/hooks/pre-commit"
  assert_eq 3 "$(surface_status agent-g-000000 "$repo")" "hooksPath target change reported"
}
test_untracked_envrc_reported_tracked_not() {
  local repo; repo=$(make_git_repo); surface_status agent-g-000000 "$repo" >/dev/null
  printf 'export X=1\n' >"$repo/.envrc"
  assert_eq 3 "$(surface_status agent-g-000000 "$repo")" "untracked .envrc reported"
  local repo2="$TMP_ROOT/g3"; mkdir -p "$repo2" && git -C "$repo2" init -q; repo2=$(cd -P "$repo2" && pwd -P)
  printf 'export X=1\n' >"$repo2/.envrc"; git -C "$repo2" add .envrc
  git -C "$repo2" -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -q -m envrc
  surface_status agent-g-000002 "$repo2" >/dev/null
  printf 'export X=2\n' >"$repo2/.envrc"
  assert_eq 0 "$(surface_status agent-g-000002 "$repo2")" "tracked .envrc left to git diff"
}
test_version_bump_adopts_only_new_kinds() {
  local repo; repo=$(make_git_repo)
  printf '#!/bin/sh\n' >"$repo/.git/hooks/pre-commit"
  surface_status agent-g-000000 "$repo" >/dev/null
  local b="$AGENT_VM_STATE_DIR/snapshots/agent-g-000000/baseline"
  # Simulate a future version 2 that starts monitoring "untracked": the version-1 baseline has none.
  GIT_SURFACE_MONITORED=2
  surface_kinds_since() { if [[ "$1" -lt 2 ]]; then echo untracked; else echo; fi; }
  { printf 'format=1\nmonitored=1\n'; grep -v -e '^untracked' -e '^format=' -e '^monitored=' "$b"; } >"$b.tmp" && mv "$b.tmp" "$b"
  printf 'export X=1\n' >"$repo/.envrc"
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  printf '#!/bin/sh\n' >"$repo/.git/hooks/post-merge"
  local out; out=$(check_git_surfaces agent-g-000000 "$repo" 2>&1) || true
  assert_not_contains "$out" ".envrc" "new-kind item adopted silently"
  assert_contains "$out" "changed	hookfile	.git/hooks/pre-commit" "old-kind change still reported"
  assert_contains "$out" "added	hookfile	.git/hooks/post-merge" "old-kind addition still reported"
  assert_contains "$(cat "$b")" "monitored=2" "baseline moves to the new version"
}
test_rebaseline_keeps_reporting_the_same_diff_and_clears_after_fix() {
  local repo; repo=$(make_git_repo)
  printf '#!/bin/sh\n' >"$repo/.git/hooks/pre-commit"; surface_status agent-g-000000 "$repo" >/dev/null
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  printf '#!/bin/sh\n' >"$repo/.git/hooks/post-checkout"
  local d="$AGENT_VM_STATE_DIR/snapshots/agent-g-000000/diff" first second
  surface_status agent-g-000000 "$repo" >/dev/null; first=$(cat "$d")
  surface_status agent-g-000000 "$repo" >/dev/null; second=$(cat "$d")
  assert_eq "$first" "$second" "identical diff on the next check (no baseline corruption)"
  assert_not_contains "$(cat "$AGENT_VM_STATE_DIR/snapshots/agent-g-000000/baseline")" "changed	" "no diff lines leaked into the baseline"
  printf '#!/bin/sh\n' >"$repo/.git/hooks/pre-commit"; rm "$repo/.git/hooks/post-checkout"
  assert_eq 0 "$(surface_status agent-g-000000 "$repo")" "clean once the changes are undone"
}
test_symlinked_git_dir_is_reported() {
  local repo; repo=$(make_git_repo); surface_status agent-g-000000 "$repo" >/dev/null
  mv "$repo/.git" "$TMP_ROOT/moved-git"; ln -s "$TMP_ROOT/moved-git" "$repo/.git"
  local out; out=$(check_git_surfaces agent-g-000000 "$repo" 2>&1) || true
  assert_contains "$out" "changed	gitdir	.git" ".git replaced by a symlink reported"
}
test_ls_files_does_not_run_planted_fsmonitor() {
  local repo; repo=$(make_git_repo); surface_status agent-g-000000 "$repo" >/dev/null
  git -C "$repo" config core.fsmonitor "touch $TMP_ROOT/fsmonitor-ran; false"
  printf 'export X=1\n' >"$repo/.envrc"
  surface_status agent-g-000000 "$repo" >/dev/null
  assert_status 1 "planted fsmonitor not executed" -- test -e "$TMP_ROOT/fsmonitor-ran"
}
test_fetch_time_exec_keys_are_monitored() {
  local repo; repo=$(make_git_repo); surface_status agent-g-000000 "$repo" >/dev/null
  git -C "$repo" config url."ext::sh -c touch% /tmp/x".insteadOf https://example.com/
  assert_eq 3 "$(surface_status agent-g-000000 "$repo")" "url.*.insteadOf reported"
}
```

- [ ] **Step 2: 失敗を確認** — 期待: 11 件 FAIL。

- [ ] **Step 3: 最小実装**

```bash
GIT_SURFACE_MONITORED=1
# Canonical (lowercased) git config names that make git run a program, now or on a later fetch/clone.
EXEC_CONFIG_RE='^(core\.(hookspath|fsmonitor|sshcommand|pager|editor|askpass|gitproxy|alternaterefscommand)|sequence\.editor|filter\..*|diff\..*\.textconv|diff\.external|merge\..*\.driver|alias\..*|include\.path|includeif\..*|credential\..*|gpg\.program|gpg\..*\.program|remote\..*\.(uploadpack|receivepack)|url\..*\.insteadof|protocol\..*|uploadpack\.packobjectshook)$'

# Kinds first monitored in each version; a baseline taken at version N adopts, without reporting,
# items of kinds introduced after N. Add a line here when a version adds kinds.
surface_kinds_since() { # version -> kinds introduced after that version
  local v=$1 kinds=""
  if [[ "$v" -lt 1 ]]; then kinds="gitdir hooksdir hookfile hooklink config attributes untracked"; fi
  printf '%s\n' "$kinds"
}

sha_of_file() { shasum -a 256 <"$1" | cut -c1-64; }
sha_of_str() { printf '%s' "$1" | shasum -a 256 | cut -c1-64; }

hash_hook_dir() { # resolved_dir label
  local f rel
  if [[ ! -d "$1" ]]; then return 0; fi
  while IFS= read -r -d '' f; do
    rel=${f#"$1"/}
    if [[ -L "$f" ]]; then
      printf 'hooklink\t%s/%s\t%s\n' "$2" "$rel" "$(readlink "$f")"
    else
      printf 'hookfile\t%s/%s\t%s\n' "$2" "$rel" "$(sha_of_file "$f")"
    fi
  done < <(find "$1" -mindepth 1 \( -type f -o -type l \) -print0)
}

git_surface_items() { # repo_root -> unsorted "kind<TAB>name<TAB>value" lines
  local repo=$1 hooks hp f name kv k v
  # A symlinked .git would redirect every path below; record it so the change is reported.
  if [[ -L "$repo/.git" ]]; then printf 'gitdir\t.git\tsymlink:%s\n' "$(readlink "$repo/.git")"; else printf 'gitdir\t.git\tdir\n'; fi
  hooks=$(cd -P "$repo/.git/hooks" 2>/dev/null && pwd -P) || hooks=absent
  printf 'hooksdir\t.git/hooks\t%s\n' "$hooks"
  if [[ "$hooks" != absent ]]; then hash_hook_dir "$hooks" .git/hooks; fi
  hp=$(git config --file "$repo/.git/config" --get core.hooksPath 2>/dev/null) || hp=""
  if [[ -n "$hp" ]]; then
    case "$hp" in /*) ;; *) hp="$repo/$hp" ;; esac
    hp=$(cd -P "$hp" 2>/dev/null && pwd -P) || hp=""
    if [[ -n "$hp" ]]; then hash_hook_dir "$hp" hookspath; fi
  fi
  for f in "$repo/.git/config" "$repo"/.git/worktrees/*/config.worktree; do
    if [[ ! -f "$f" ]]; then continue; fi
    name=${f#"$repo/"}
    while IFS= read -r -d '' kv; do
      k=${kv%%$'\n'*}
      v=""
      if [[ "$kv" == *$'\n'* ]]; then v=${kv#*$'\n'}; fi
      printf 'config\t%s:%s\t%s\n' "$name" "$k" "$(sha_of_str "$v")"
    done < <(git config --file "$f" --null --get-regexp "$EXEC_CONFIG_RE" 2>/dev/null || true)
  done
  if [[ -f "$repo/.git/info/attributes" ]]; then
    printf 'attributes\t.git/info/attributes\t%s\n' "$(sha_of_file "$repo/.git/info/attributes")"
  fi
  for name in .envrc mise.local.toml .mise.local.toml; do
    # Repo-context git on a VM-writable .git: neutralize settings that would run programs on the host.
    if [[ -f "$repo/$name" ]] && ! git -c core.fsmonitor= -c core.hooksPath=/dev/null --no-optional-locks -C "$repo" ls-files --error-unmatch -- "$name" >/dev/null 2>&1; then
      printf 'untracked\t%s\t%s\n' "$name" "$(sha_of_file "$repo/$name")"
    fi
  done
}

git_surface_manifest() { # repo_root -> "format=1", "monitored=N", then sorted items
  printf 'format=1\nmonitored=%s\n' "$GIT_SURFACE_MONITORED"
  git_surface_items "$1" | LC_ALL=C sort
}

surface_dir() { printf '%s/snapshots/%s\n' "$AGENT_VM_STATE_DIR" "$1"; }

# Prints "added|changed|removed<TAB>kind<TAB>name" for monitored items that differ from the baseline.
# Items of kinds first monitored after the baseline's version are not differences (they are adopted).
surface_diff() { # baseline_file current_manifest_file
  local newkinds
  newkinds=$(surface_kinds_since "$(sed -n 's/^monitored=//p' "$1")")
  awk -F'\t' -v newkinds=" $newkinds " '
    FNR == NR { if (NF == 3) b[$1 FS $2] = $3; next }
    NF == 3 {
      k = $1 FS $2; seen[k] = 1
      if (!(k in b)) { if (index(newkinds, " " $1 " ") == 0) print "added" FS k; next }
      if (b[k] != $3) print "changed" FS k
    }
    END { for (k in b) if (!(k in seen)) print "removed" FS k }' "$1" "$2" | LC_ALL=C sort
}

# New baseline: current values for items without a difference (and for newly monitored kinds),
# baseline values kept for changed/removed items, added items left out so they keep being reported.
surface_rebaseline() { # baseline_file current_manifest_file diff_file -> new baseline on stdout
  printf 'format=1\nmonitored=%s\n' "$GIT_SURFACE_MONITORED"
  # Files are read in the order baseline, diff, current: the diff must be loaded before current is walked.
  awk -F'\t' '
    FILENAME == ARGV[1] { if (NF == 3) b[$1 FS $2] = $3; next }
    FILENAME == ARGV[2] { d[$2 FS $3] = $1; next }
    NF == 3 {
      k = $1 FS $2; seen[k] = 1
      if (!(k in d)) print $0
      else if (d[k] == "changed") print k FS b[k]
    }
    END { for (k in b) if (!(k in seen)) print k FS b[k] }' "$1" "$3" "$2" | LC_ALL=C sort
}

# Copies used by restore-git, taken only from a clean state. A path check cannot pin what cp reads
# (the VM may swap .git/hooks between check and copy), so the copies are validated by content instead:
# restore-git only writes back a copy whose hash equals the baseline entry (see restore_surface_item).
save_surface_copies() { # repo_root dir
  rm -rf "$2/files"
  mkdir -p "$2/files/hooks"
  if [[ -d "$1/.git/hooks" && ! -L "$1/.git/hooks" ]]; then cp -pPR "$1/.git/hooks/." "$2/files/hooks/"; fi
  if [[ -f "$1/.git/info/attributes" ]]; then cp -p "$1/.git/info/attributes" "$2/files/attributes"; fi
}

check_git_surfaces() { # machine repo_root -> 0 clean, 3 when a monitored item differs from the baseline
  local dir
  dir=$(surface_dir "$1")
  mkdir -p "$dir"
  git_surface_manifest "$2" >"$dir/current"
  if [[ ! -f "$dir/baseline" ]]; then
    mv "$dir/current" "$dir/baseline"
    save_surface_copies "$2" "$dir"
    return 0
  fi
  surface_diff "$dir/baseline" "$dir/current" >"$dir/diff"
  surface_rebaseline "$dir/baseline" "$dir/current" "$dir/diff" >"$dir/baseline.new"
  mv "$dir/baseline.new" "$dir/baseline"
  if [[ ! -s "$dir/diff" ]]; then
    save_surface_copies "$2" "$dir"
    return 0
  fi
  step "files that git runs on the host changed since the last check (not visible in git diff):"
  sed 's/^/  /' "$dir/diff" >&2
  step "recover: agent-vm restore-git $2"
  return 3
}
```

- [ ] **Step 4: 通過を確認** — 期待: `0 failed`。
- [ ] **Step 5: コミット** — `feat(agent-vm): detect changes to host-executed git surfaces against a baseline`

### T3: restore-git（K13）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`、テスト: `tests/agent-vm/run.sh`
- 参照: spec K13（`restore-git` は `machines/<m>` の `repo_path` と引数の realpath が一致するスナップショットだけ、差分表示と確認の後に戻す）

- [ ] **Step 1: 失敗するテスト**

```bash
test_restore_git_undoes_hook_config_and_envrc_changes() {
  local repo m; repo=$(make_git_repo); m=$(derive_machine_name "$repo")
  write_machine_meta "$m" "$repo"
  printf '#!/bin/sh\n' >"$repo/.git/hooks/pre-commit"
  check_git_surfaces "$m" "$repo" 2>/dev/null
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  printf '#!/bin/sh\necho pwned\n' >"$repo/.git/hooks/post-checkout"
  git -C "$repo" config core.fsmonitor "sh -c 'echo pwned'"
  printf 'export X=1\n' >"$repo/.envrc"
  printf 'y\n' | cmd_restore_git "$repo" >/dev/null 2>&1
  assert_eq "#!/bin/sh" "$(cat "$repo/.git/hooks/pre-commit")" "changed hook restored"
  assert_status 1 "added hook removed" -- test -e "$repo/.git/hooks/post-checkout"
  assert_status 1 "added exec config unset" -- git -C "$repo" config --get core.fsmonitor
  assert_status 0 ".envrc quarantined" -- test -f "$repo/.envrc.agent-vm-quarantine"
  assert_eq 0 "$(surface_status "$m" "$repo")" "clean after restore"
}
test_restore_git_fixes_symlinked_hooks_dir_before_files() {
  local repo m; repo=$(make_git_repo); m=$(derive_machine_name "$repo")
  write_machine_meta "$m" "$repo"
  printf '#!/bin/sh\n' >"$repo/.git/hooks/pre-commit"
  check_git_surfaces "$m" "$repo" 2>/dev/null
  local outside="$TMP_ROOT/outside-hooks"; mkdir -p "$outside"
  printf 'keep\n' >"$outside/victim"
  rm -rf "$repo/.git/hooks"; ln -s "$outside" "$repo/.git/hooks"
  printf '#!/bin/sh\n' >"$outside/post-checkout"
  cp "$outside/victim" "$outside/pre-commit"
  printf 'y\n' | cmd_restore_git "$repo" >/dev/null 2>&1 || true
  assert_eq "keep" "$(cat "$outside/victim")" "file outside the repo untouched"
  assert_eq "keep" "$(cat "$outside/pre-commit")" "same-named file outside the repo not overwritten"
  assert_status 0 "file outside the repo not deleted" -- test -e "$outside/post-checkout"
  assert_status 1 "hooks dir is a real directory again" -- test -L "$repo/.git/hooks"
}
test_restore_git_skips_a_tampered_saved_copy() {
  local repo m; repo=$(make_git_repo); m=$(derive_machine_name "$repo")
  write_machine_meta "$m" "$repo"
  printf '#!/bin/sh\n' >"$repo/.git/hooks/pre-commit"
  check_git_surfaces "$m" "$repo" 2>/dev/null
  # simulate a copy captured through a swapped-in symlink: content differs from the baseline hash
  printf '#!/bin/sh\necho planted\n' >"$AGENT_VM_STATE_DIR/snapshots/$m/files/hooks/pre-commit"
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  printf 'y\n' | cmd_restore_git "$repo" >/dev/null 2>&1 || true
  assert_status 1 "tampered copy not written back (file left removed)" -- test -e "$repo/.git/hooks/pre-commit"
}
test_restore_git_refuses_symlinked_git_dir() {
  local repo m; repo=$(make_git_repo); m=$(derive_machine_name "$repo")
  write_machine_meta "$m" "$repo"; check_git_surfaces "$m" "$repo" 2>/dev/null
  mv "$repo/.git" "$TMP_ROOT/moved-git"; ln -s "$TMP_ROOT/moved-git" "$repo/.git"
  assert_status 1 "symlinked .git refused" -- bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; printf 'y\n' | cmd_restore_git '$repo'"
}
test_restore_git_does_nothing_without_yes() {
  local repo m; repo=$(make_git_repo); m=$(derive_machine_name "$repo")
  write_machine_meta "$m" "$repo"; check_git_surfaces "$m" "$repo" 2>/dev/null
  printf '#!/bin/sh\n' >"$repo/.git/hooks/post-checkout"
  printf 'n\n' | cmd_restore_git "$repo" >/dev/null 2>&1
  assert_status 0 "hook left in place" -- test -f "$repo/.git/hooks/post-checkout"
}
test_restore_git_refuses_snapshot_of_another_path() {
  local repo m; repo=$(make_git_repo); m=$(derive_machine_name "$repo")
  write_machine_meta "$m" "/somewhere/else"
  assert_status 1 "path mismatch refused" -- bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; printf 'y\n' | cmd_restore_git '$repo'"
}
```

- [ ] **Step 2: 失敗を確認** — 期待: 6 件 FAIL。

- [ ] **Step 3: 最小実装**

```bash
saved_copy_matches_baseline() { # dir kind name saved_path -> 0 when the copy's content is the baseline's
  local want got
  want=$(awk -F'\t' -v k="$2" -v n="$3" '$1 == k && $2 == n { print $3 }' "$1/baseline")
  if [[ -z "$want" ]]; then return 1; fi
  if [[ "$2" == hooklink ]]; then
    [[ -L "$4" ]] || return 1
    got=$(readlink "$4")
  else
    [[ -f "$4" && ! -L "$4" ]] || return 1
    got=$(sha_of_file "$4")
  fi
  [[ "$got" == "$want" ]]
}

restore_config_key() { # repo config_relpath key
  # Exec settings are only removed, never re-added from a saved copy: that copy could have been captured
  # while the VM was changing the file, and dropping a program-running setting is the safe direction.
  if git config --file "$1/$2" --get-all "$3" >/dev/null 2>&1; then
    git config --file "$1/$2" --unset-all "$3"
    step "removed $3 from $2; re-add it by hand if it was your own setting"
  fi
}

restore_surface_item() { # repo dir change kind name
  local repo=$1 dir=$2 change=$3 kind=$4 name=$5 rel
  case "$kind" in
    hooksdir)
      # Only recreate the directory; its files are restored one by one (hash-checked) by their own diff lines.
      if [[ -L "$repo/.git/hooks" ]]; then rm -f "$repo/.git/hooks"; fi
      mkdir -p "$repo/.git/hooks"
      ;;
    hookfile | hooklink)
      case "$name" in
        .git/hooks/*)
          rel=${name#.git/hooks/}
          # Re-check right before touching anything: never operate through a symlinked hooks dir.
          if [[ -L "$repo/.git/hooks" ]]; then die "refusing to restore $name: .git/hooks is a symlink"; fi
          case "$rel" in */*) die "refusing to restore nested hook path $name" ;; esac
          rm -f "$repo/.git/hooks/$rel"
          if [[ "$change" != added ]] && saved_copy_matches_baseline "$dir" "$kind" "$name" "$dir/files/hooks/$rel"; then
            cp -pP "$dir/files/hooks/$rel" "$repo/.git/hooks/$rel"
          elif [[ "$change" != added ]]; then
            step "not restoring $name: the saved copy does not match the recorded baseline (left removed)"
          fi
          ;;
        *) step "cannot restore $name (outside .git); the core.hooksPath change is restored instead" ;;
      esac
      ;;
    config) restore_config_key "$repo" "${name%%:*}" "${name#*:}" ;;
    attributes)
      rm -f "$repo/.git/info/attributes"
      if [[ "$change" != added ]] && saved_copy_matches_baseline "$dir" attributes "$name" "$dir/files/attributes"; then
        cp -p "$dir/files/attributes" "$repo/.git/info/attributes"
      elif [[ "$change" != added ]]; then
        step "not restoring $name: the saved copy does not match the recorded baseline (left removed)"
      fi
      ;;
    # Renamed rather than deleted: the file may hold the user's own work, and the rename is enough
    # to stop direnv/mise from loading it (both look up the exact file name).
    untracked) if [[ -f "$repo/$name" && ! -L "$repo/$name" ]]; then mv "$repo/$name" "$repo/$name.agent-vm-quarantine"; fi ;;
  esac
}

cmd_restore_git() { # [repo]
  local repo m dir answer change kind name
  repo=$(cd "${1:-.}" && resolve_repo_root)
  m=$(derive_machine_name "$repo")
  [[ "$(read_meta_field "$m" repo_path 2>/dev/null || true)" == "$repo" ]] || die "no snapshot recorded for $repo"
  dir=$(surface_dir "$m")
  [[ -f "$dir/baseline" ]] || die "no snapshot recorded for $repo"
  git_surface_manifest "$repo" >"$dir/current"
  surface_diff "$dir/baseline" "$dir/current" >"$dir/diff"
  if [[ ! -s "$dir/diff" ]]; then echo "nothing to restore"; return 0; fi
  sed 's/^/  /' "$dir/diff"
  printf 'restore these to the last clean snapshot (untracked files are renamed to *.agent-vm-quarantine)? [y/N] '
  read -r answer
  if [[ "$answer" != y && "$answer" != Y ]]; then return 0; fi
  # A symlinked .git redirects every path below it; that needs a human, not an automatic restore.
  if [[ -L "$repo/.git" ]]; then die "$repo/.git is a symlink; move it aside and restore the repository manually"; fi
  # The hooks directory is fixed first so no per-file operation can run through a symlinked hooks dir.
  { grep "	hooksdir	" "$dir/diff" || true; grep -v "	hooksdir	" "$dir/diff" || true; } >"$dir/diff.ordered"
  while IFS=$'\t' read -r change kind name; do
    restore_surface_item "$repo" "$dir" "$change" "$kind" "$name"
  done <"$dir/diff.ordered"
  # Exit 3 when something could not be restored (e.g. a saved copy failed its hash check), so the caller knows.
  check_git_surfaces "$m" "$repo"
}
```

- [ ] **Step 4: 通過を確認** — 期待: `0 failed`。
- [ ] **Step 5: コミット** — `feat(agent-vm): restore host-executed git surfaces from the last clean snapshot`

### T4: 起動・終了フローへの組み込みと sync（手順 4・5・9）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`（`prepare_machine` / `run_tool` / `main` / `show_help`）、テスト: `tests/agent-vm/run.sh`
- 参照: `home/dot_local/bin/executable_agent-vm` の `prepare_machine`（lock 取得直後に手順 4・5 を差し込む）と `run_tool`（`session_exec` の後に手順 9）
- 参照: spec K1（終了時は fd 9 を開き直して取り直す、60 秒で取れなければ警告と `recover: agent-vm sync <repo>`）

- [ ] **Step 1: 失敗するテスト**

```bash
test_session_logs_are_ingested_after_the_session() {
  local wt repo; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  export AGENT_VM_CLAUDE_PROJECTS_DIR="$TMP_ROOT/host-projects" AGENT_VM_CODEX_SESSIONS_DIR="$TMP_ROOT/host-codex"
  notice_orphan_env() { :; }
  session_exec() { mkdir -p "$AGENT_VM_STATE_DIR/outbox/$1/claude-projects/-r"; printf 'x\n' >"$AGENT_VM_STATE_DIR/outbox/$1/claude-projects/-r/s.jsonl"; }
  (cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" run_tool claude) 2>/dev/null
  assert_eq "x" "$(cat "$AGENT_VM_CLAUDE_PROJECTS_DIR/-r/s.jsonl")" "ingested on exit"
}
test_git_surface_change_during_session_sets_exit_code() {
  local wt repo; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  notice_orphan_env() { :; }
  session_exec() { printf '#!/bin/sh\n' >"$REPO/.git/hooks/post-checkout"; }
  local status=0
  (cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" run_tool claude) 2>/dev/null || status=$?
  assert_eq 3 "$status" "exit code 3 when git surfaces changed"
}
test_tool_failure_status_wins() {
  local wt repo; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  notice_orphan_env() { :; }
  session_exec() { printf '#!/bin/sh\n' >"$REPO/.git/hooks/post-checkout"; return 7; }
  local status=0
  (cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" run_tool claude) 2>/dev/null || status=$?
  assert_eq 7 "$status" "tool status preferred"
}
test_finish_reports_lock_timeout_with_recover_hint() {
  local wt repo m; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  notice_orphan_env() { :; }
  session_exec() {
    bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_lock '$m' 1 && exec sleep 5" </dev/null >/dev/null 2>&1 &
    sleep 1
  }
  local status=0 err
  err=$(cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" AGENT_VM_FINISH_WAIT=1 run_tool claude 2>&1) || status=$?
  assert_eq 5 "$status" "exit code 5 on lock timeout"
  assert_contains "$err" "recover: agent-vm sync" "recover hint"
  wait
}
test_sync_inspect_lists_divergence_without_writing() {
  local repo m; repo=$(make_flow_repo); m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  export AGENT_VM_CLAUDE_PROJECTS_DIR="$TMP_ROOT/host-projects" AGENT_VM_CODEX_SESSIONS_DIR="$TMP_ROOT/host-codex"
  mkdir -p "$AGENT_VM_STATE_DIR/outbox/$m/claude-projects/-r" "$AGENT_VM_CLAUDE_PROJECTS_DIR/-r"
  printf 'abc\n' >"$AGENT_VM_CLAUDE_PROJECTS_DIR/-r/s.jsonl"
  printf 'XYZ\n' >"$AGENT_VM_STATE_DIR/outbox/$m/claude-projects/-r/s.jsonl"
  local out; out=$(cd "$repo" && cmd_sync --inspect 2>&1)
  assert_contains "$out" "diverged" "divergence listed"
  assert_eq "abc" "$(cat "$AGENT_VM_CLAUDE_PROJECTS_DIR/-r/s.jsonl")" "inspect writes nothing"
}
test_main_dispatches_sync_and_restore_git() {
  cmd_sync() { echo "sync $*"; }; cmd_restore_git() { echo "restore-git $*"; }
  assert_eq "sync --inspect" "$(main sync --inspect)" "sync"
  assert_eq "restore-git /r" "$(main restore-git /r)" "restore-git"
}
```

- [ ] **Step 2: 失敗を確認** — 期待: 6 件 FAIL。

- [ ] **Step 3: 最小実装**

plan-1 の `resolve_repo_root` の git 呼び出しを次に置き換える（`sync` / `restore-git` は VM が設定を書き換えた直後の repo で最初に実行されるため）:

```bash
  common=$(git -c core.fsmonitor= -c core.hooksPath=/dev/null --no-optional-locks rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || die "not inside a git repository"
```

`prepare_machine` の `acquire_lock …` の直後（`out=$(build_staging …)` の前）に手順 4・5 を追加する:

```bash
  # Steps 4-5: report git-surface changes left by an earlier session (including a crashed one)
  # and catch up on logs it did not get to ingest. Findings are reported, the launch continues.
  check_git_surfaces "$MACHINE" "$REPO" || true
  ingest_outbox "$MACHINE" || true
```

関数を追加し、`run_tool` を置き換える:

```bash
finish_session() { # machine repo -> 0, 3 (git surfaces), 4 (log divergence), 5 (lock timeout)
  local status=0
  if ! acquire_lock "$1" "${AGENT_VM_FINISH_WAIT:-60}"; then
    step "skipped log ingestion and git checks: another session of this repo holds the lock"
    step "recover: agent-vm sync $2 (the next launch also runs them)"
    return 5
  fi
  ingest_outbox "$1" || status=4
  check_git_surfaces "$1" "$2" || status=3
  release_lock
  return "$status"
}

run_tool() { # tool args...
  local tool=$1 envf script status=0 finish=0
  shift
  prepare_machine "$tool"
  notice_orphan_env "$MACHINE"
  if [[ "$tool" == codex ]]; then ensure_codex_auth "$MACHINE"; fi
  envf=$(inject_secrets "$MACHINE")
  script=$(build_launch_script "$tool" "$REPO" "$envf" "$@")
  set_title "[vm:$MACHINE] $REPO"
  # Step 9 also runs when the launcher is interrupted while the session is open.
  trap 'set_title "$REPO"; finish_session "$MACHINE" "$REPO" || true; exit 130' INT TERM
  session_exec "$MACHINE" "$script" || status=$?
  trap - INT TERM
  set_title "$REPO"
  finish_session "$MACHINE" "$REPO" || finish=$?
  if [[ "$status" -ne 0 ]]; then return "$status"; fi
  return "$finish"
}

cmd_sync() { # [--inspect]
  local repo m status=0
  repo=$(resolve_repo_root)
  m=$(derive_machine_name "$repo")
  if [[ "${1:-}" == --inspect ]]; then
    inspect_outbox "$m"
    return 0
  fi
  acquire_lock "$m" 60 || die "timed out waiting for another session of this repo"
  ingest_outbox "$m" || status=4
  check_git_surfaces "$m" "$repo" || status=3
  release_lock
  return "$status"
}
```

`main` の case に `sync) shift; cmd_sync "$@" ;;` と `restore-git) shift; cmd_restore_git "$@" ;;` を追加し、`show_help` に次の 2 行を加える:

```
  agent-vm sync [--inspect]         Ingest session logs and check git surfaces now
  agent-vm restore-git [repo]       Undo reported changes to host-executed git files
```

- [ ] **Step 4: 通過を確認** — 期待: `0 failed`。`shellcheck --severity=warning` が警告 0。
- [ ] **Step 5: コミット** — `feat(agent-vm): ingest logs and check git surfaces around each session`

## ISO 25010 具体テストケース

### セキュリティ（完全性）

- **入力**: outbox の jsonl の先頭行を書き換え（長さは増加） → **期待**: host の写しは変更されず終了コード 4、次回も再報告（T1）
- **入力**: outbox に host のファイルへの symlink `link.jsonl`、または tree root 自体が symlink → **期待**: 取り込まれない（T1）
- **入力**: VM セッション中に `.git/hooks/post-checkout` を追加 → **期待**: 終了コード 3、差分に `added` と hook 名、`recover: agent-vm restore-git` を表示（T2・T4）
- **入力**: `.git/hooks` を外部ディレクトリへの symlink に置換 → **期待**: 差分として報告（T2）
- **入力**: `core.fsmonitor` を追加 → **期待**: 報告。`branch.main.remote` の追加は報告しない（T2）
- **入力**: 版 0 の baseline で `.envrc` が新たに監視対象になる → **期待**: 報告せず baseline に追加。同時に起きた既存 hook の変更は報告（T2）
- **入力**: `restore-git` に別パスの記録しかない repo → **期待**: 終了コード 1 で何も戻さない（T3）

### 機能適合性（機能正確性）

- **入力**: outbox の jsonl に 1 行追記 → **期待**: host の写しの末尾に同じ 1 行だけが追加（T1）
- **入力**: host の写しを削除し、`ingested/<m>` に不正な行を追加 → **期待**: 再コピーされ、記録の 1 行目は `format=1`（T1）
- **入力**: `restore-git` に `y` → **期待**: 変更 hook は元の内容、追加 hook は削除、追加 exec config は未設定、`.envrc` は `.envrc.agent-vm-quarantine`、再検査で差分 0（T3）

### 使用性（運用操作性）

- **入力**: 終了時に別プロセスが lock を 5 秒保持、待ち上限 1 秒 → **期待**: 終了コード 5、`recover: agent-vm sync` を表示（T4）
- **入力**: ツールが 7 で終了し git 面も変化 → **期待**: 終了コード 7（T4）
- **入力**: `agent-vm sync --inspect` → **期待**: `diverged` 行を表示し、host の写しは変わらない（T4）

対象外: 性能効率（取り込みと検査の所要時間は spec V4 の warm 起動 3 秒の計測に含めて mac 実機で測る）。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: blocker
- 主指摘: `surface_rebaseline` の awk が読むファイル順（baseline, diff, current）と規則（ARGV[3] を diff とみなす）が食い違い、差分が出るたびに baseline へ不正な行が永久に残る。既存テストは差分ありの 2 回目以降を確かめていない。版 0 の新規種類に hookfile を含めるとテストの前提と矛盾する。restore の条件式の優先順位。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘: 終了コード 4・5 と「ツールの終了コード優先」の根拠、untracked を削除でなく改名する根拠を plan に書くべき。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: 既存の単一ファイル構成と state 配置に整合。`ingest_outbox` が global を設定することをコメントに書くとよい。

### security-vulnerability-analyzer
- verdict: blocker
- 主指摘: restore は `added hookfile` を `changed hooksdir` より先に処理し、symlink に差し替えられた `.git/hooks` を辿って repo 外のファイルを消す・上書きしうる。`find` と読み込みの間に symlink へ差し替える TOCTOU。`git ls-files` は VM が置いた `core.fsmonitor` を host で実行しうる。`core.gitproxy`・`remote.*.uploadpack`・`url.*.insteadof` 等が監視対象に無い。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: 食い違い時の recover 行に対象 repo が無い。git 面の差分とログの食い違いが同時に起きたときの終了コードの優先が暗黙。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: pass
- 主指摘: Round 1 の 3 件は解消し、テスト件数も一致。lock 中の `9>&-` 規則と本 plan のコードが食い違う点、worktree の config.worktree を restore で戻さない点を明記するとよい（反映済み）。

### scope-justification-reviewer
- verdict: pass
- 主指摘: 根拠の不足は解消。追加分はすべて Round 1 の指摘への対応で、scope の逸脱なし。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: 埋め込み perl helper・gitdir・git の防御フラグは既存構造に整合。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: Round 1 は解消。`resolve_repo_root` の `git rev-parse` が防御フラグ無しで、復旧コマンド（sync / restore-git）の先頭で走る。`outbox_read` は途中ディレクトリの差し替え競合が残る。`save_surface_copies` の確認と cp の間の競合。

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: recover 行と終了コードの優先順位はコードと一致。gitdir 追加は未実装のため移行の問題なし。

<!-- auto-review: verdict=blocker; hash=198b4ad595aeac6165245f6c9cc3f4156feadcf3ecbf007d1c34b956f059ce87; design-hash=f2a41194e4ab6980bb13563ed53926b57db0068e8ff454e5e83416e8d386b811; round=1; parent-spec-hash=38b06a1ecf916f3e230bbc5c3985ce0f516438f7b4a7950d29c58ab34ab06f8e; at=2026-09-28T15:39:05.876Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=14; excluded=0; at=2026-09-28T15:39:05.893Z -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: pass
- 主指摘: realpath 比較・hardened `rev-parse`・コメント追加に誤りなし。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: `save_surface_copies` の確認は同じパス文字列を再解決するだけで、確認と cp の間の symlink 差し替えは防げない（同時に動く別セッションが仕込んだ hook を「正常な状態のコピー」にでき、restore が書き戻す）。`outbox_read` が FIFO を開くと止まる。→ 反映: コピーは内容 hash で検証（restore は baseline の hash と一致するコピーだけを書き戻す、テスト追加）、`O_NONBLOCK` で開いて fstat で通常ファイル以外を拒否。

### scope-justification-reviewer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=0c0c5e7b3e819c214fd5ebb13e34e8e46fa6e76e979d50abbdfc27e8a9680ae1; design-hash=6787328dc54437ac214f31a01eb084f8b10de9f8a97ccbd84551b563c1074a34; round=2; parent-spec-hash=38b06a1ecf916f3e230bbc5c3985ce0f516438f7b4a7950d29c58ab34ab06f8e; at=2026-09-28T15:49:50.476Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=5; excluded=0; at=2026-09-28T15:49:50.493Z -->

## Reviewer Outputs (Round 4)

### logic-validator
- verdict: needs-work
- 主指摘: 改ざんコピーのテストが、存在しないファイルへの `grep` の終了コード 2 で正しい実装でも失敗する（→ `test -e` に変更）。ほかの restore テストと baseline 参照の awk は正しい。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: FIFO は解消、baseline が実行時の改変を取り込まないことも確認。ただし hash 照合は hook だけで、config と attributes の保存コピーは無条件に書き戻される（→ config は外すだけで再追加しない、attributes は baseline の hash と一致したときだけ戻す、config の保存コピー自体を廃止）。

### scope-justification-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=e4880ff026d4d4fe279c537fabe16426b32049106768bbae1c393badc4a97801; design-hash=58a6fcfc72f2de65f1eeb094496a996ec9f1d2eb3676585261eab7b0bd443a60; round=3; parent-spec-hash=38b06a1ecf916f3e230bbc5c3985ce0f516438f7b4a7950d29c58ab34ab06f8e; at=2026-09-28T15:52:38.662Z; reviewers=logic-validator+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=2; excluded=0; at=2026-09-28T15:52:38.680Z -->

## Reviewer Outputs (Round 5)

### logic-validator
- verdict: pass
- 主指摘: 改ざんコピーのテストは `test -e` で正しく判定。`restore_config_key` は引数 3 つで、保存 config への参照は残っていない。既存の restore テストも通る。

### security-vulnerability-analyzer
- verdict: pass（Round 4 は解消、minor 2 件は反映済み）
- 主指摘: exec 系設定は外すだけ、hook と attributes は baseline の hash と一致した保存コピーだけを戻すことを確認。restore 後の再検査の結果を `|| true` で捨てていた点（→ 戻しきれないとき終了コード 3 を返す）と、外していないキーにも「外した」と表示していた点（→ 実在するときだけ外して表示）を反映。

### scope-justification-reviewer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=10a0d8c85905a62abca819419bb0f5ea38064104d5d1f73b660de2cb188c21e3; design-hash=048c9cb3036f15428879d52b5509a8693b7a095172130970305dd85d8b5b7350; round=4; parent-spec-hash=95a0fa3a0ffb18b339e4336bd35d1744ff2966373282db17c2b43f395f49a2b9; at=2026-09-28T16:06:35.867Z; reviewers=logic-validator+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=2; excluded=0; at=2026-09-28T16:06:35.883Z -->

<!-- auto-review: verdict=pass; hash=36e68e57c111536aaffc5b37eaf4776eeab1c992e2cd25550831474122e4befc; design-hash=619cd02b7d5f2f8708c531f026f53bb0068bd17828fb6beacc1aa8c93197a2de; round=5; parent-spec-hash=34a1ddc3b9669296fa9387fc587f25c25cffe7efcb918cbc6fc5ab05da33a858; at=2026-09-28T16:41:27.261Z; reviewers=logic-validator+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=2; excluded=0; at=2026-09-28T16:41:27.278Z -->
