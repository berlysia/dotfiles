<!-- spec-ref: spec.md -->

# Plan 1: portless の proxy のポートを launcher が割り当てる（#207）

spec の K1〜K12 をすべて実装する。1 本の plan にまとめる。launcher の変更は 1 つの lock と 7 つの関数で、docs と設定は 1〜数行ずつのためである。

前提と決めごと:

- launcher は bash 3.2 互換を保つ（spec の Goal の制約）。CI の macOS は `/bin/bash tests/agent-vm/run.sh` で走らせる。連想配列、`mapfile`、`${var,,}` は使わない。
  - この環境（WSL2 の Linux、bash 5）では bash 3.2 での実行を確かめられない。bash 3.2 での確認は CI の macOS の job が担う。
- テストは `tests/agent-vm/run.sh` に関数を足す。各テストは自分の `AGENT_VM_STATE_DIR` を持つサブシェルで走る（`run.sh` 末尾のループ）。
- 基準: 変更前の `bash tests/agent-vm/run.sh` は、この環境で「698 run, 0 failed」である（research H2）。判定は「failed が 0 のまま、run が増える」とする。
- 新しい名前:
  - 定数 `PROXY_PORT_MIN=17300`、`PROXY_PORT_MAX=17399`。
  - グローバル変数 `PROXY_PORT`（今回の値）と `PROXY_PORT_PREV`（書き換える前の自分の値）。`prepare_machine` が冒頭で空に初期化し、`assign_proxy_port` が置く。launcher は `set -u` で動く（research H6）ので、`prepare_machine` の外から読む関数は `${PROXY_PORT:-}` と `${PROXY_PORT_PREV:-}` で読む。
  - 関数 `valid_proxy_port`、`acquire_port_lock`、`release_port_lock`、`pick_proxy_port`、`assign_proxy_port`、`notice_proxy_port_assignment`、`notice_proxy_port`。
- mac の実機での確認（spec の V30〜V33）は、この plan の実装では実行しない。手順として `docs/agent-vm.md` と PR の本文に残し、人が mac で行う。判定と merge の条件は spec の「mac の実機での確認（V30〜V33）」が正である。

## Files

```
# 編集
home/dot_local/bin/executable_agent-vm
tests/agent-vm/run.sh
home/dot_config/mise/config.toml
home/dot_claude/CLAUDE.md
home/dot_codex/AGENTS.md
docs/agent-vm.md
docs/decisions/0018-agent-vm-orbstack.md
docs/plans/agent-vm/portless/research.md
docs/plans/agent-vm/portless/spec.md
docs/plans/agent-vm/portless/plan-1.md

# 削除
docs/plans/agent-vm/portless/review-notes.md
```

## Tasks

### T1: ポートの割り当てと meta の書き込み（K2、K3）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm:64-70`（`meta_path` の直後に定数と関数を足し、`write_machine_meta` を置き換える）、`:107`（`orb_q`）、`:145-146`（lock の順序のコメント）、`:419-420`（meta の schema のコメント）
- テスト: `tests/agent-vm/run.sh`（`test_meta_rejects_newline_path` の直後に足す。`test_orb_q_closes_every_lock_fd` を書き換える）
- 参照: `home/dot_local/bin/executable_agent-vm:147-159`（`acquire_golden_lock`。`{ exec 7>...; } 2>/dev/null || return 1` と perl の flock。同じ形で fd 6 の lock を作る）
- 参照: `home/dot_local/bin/executable_agent-vm:430`（`write_golden_meta`。lock を取らず、一時ファイルと `mv` で置き換える既存の形）、`:574-588`（`ensure_machine` が golden lock を持つ形）
- 参照: `tests/agent-vm/run.sh:195-204`（別プロセスで lock を持たせて、2 つ目が取れないことを確かめる既存のテストの形）、`:366-377`（`orb_q` のテスト）

- [ ] **Step 1: 失敗するテストを書く**

```bash
test_valid_proxy_port_accepts_only_five_digits_in_range() {
  local v
  for v in 17300 17350 17399; do
    if valid_proxy_port "$v"; then record "PASS $v is a valid proxy port"; else record "FAIL $v is a valid proxy port"; fi
  done
  # 017300 and 041624 are octal to bash arithmetic (041624 is 17300); the digit test must reject them first.
  for v in 17299 17400 "" 0 80 017300 017308 041624 "1730 0" 17300x 18446744073709568916; do
    if valid_proxy_port "$v" 2>"$TMP_ROOT/valid.err"; then record "FAIL '$v' is not a valid proxy port"; else record "PASS '$v' is not a valid proxy port"; fi
    assert_eq "" "$(cat "$TMP_ROOT/valid.err")" "no arithmetic error for '$v'"
  done
  # A value with a newline never reaches a label: the results file is one line per assertion.
  if valid_proxy_port $'17300\n' || valid_proxy_port $'\n17300' || valid_proxy_port $'17300\n17301'; then
    record "FAIL a value with a newline is not a valid proxy port"
  else
    record "PASS a value with a newline is not a valid proxy port"
  fi
}
test_meta_third_argument_writes_the_proxy_port() {
  write_machine_meta agent-a-000000 /tmp/a 17305
  assert_eq 17305 "$(read_meta_field agent-a-000000 proxy_port)" "proxy_port written from the third argument"
  assert_eq /tmp/a "$(read_meta_field agent-a-000000 repo_path)" "repo_path still written"
  assert_eq 1 "$(read_meta_field agent-a-000000 format)" "format still written"
  write_machine_meta agent-a-000000 /tmp/a
  assert_eq "" "$(read_meta_field agent-a-000000 proxy_port || true)" "a two-argument rewrite drops proxy_port (the documented contract)"
  write_machine_meta agent-a-000000 /tmp/a 041624
  assert_eq "" "$(read_meta_field agent-a-000000 proxy_port || true)" "an invalid third argument writes no proxy_port"
}
test_meta_is_replaced_through_a_hidden_temp_file() {
  write_machine_meta agent-a-000000 /tmp/a 17300
  assert_eq "" "$(find "$AGENT_VM_STATE_DIR/machines" -name '.agent-a-000000.*')" "no temp file left"
  ln "$AGENT_VM_STATE_DIR/machines/agent-a-000000" "$TMP_ROOT/held" # a second name for the same file: an in-place write would change what it shows
  write_machine_meta agent-a-000000 /tmp/a 17301
  assert_contains "$(cat "$TMP_ROOT/held")" "proxy_port=17300" "the record is replaced, not rewritten in place"
  assert_eq 17301 "$(read_meta_field agent-a-000000 proxy_port)" "the new record holds the new value"
  : >"$AGENT_VM_STATE_DIR/machines/.agent-z-000000.abc123"
  assert_eq "agent-a-000000" "$(machine_rows | cut -f1)" "a leftover temp file is not listed as a machine"
}
test_assign_first_machine_gets_the_lowest_slot() {
  assign_proxy_port agent-a-000000 /tmp/a
  assert_eq 17300 "$PROXY_PORT" "first machine gets 17300"
  assert_eq "" "$PROXY_PORT_PREV" "no previous port on the first assignment"
  assert_eq 17300 "$(read_meta_field agent-a-000000 proxy_port)" "the record holds the port"
  assert_eq /tmp/a "$(read_meta_field agent-a-000000 repo_path)" "repo_path written"
}
test_assign_skips_ports_held_by_other_records() {
  write_machine_meta agent-b-000000 /tmp/b 17300
  write_machine_meta agent-c-000000 /tmp/c 17302
  : >"$AGENT_VM_STATE_DIR/machines/agent-b-000000.lock"
  assign_proxy_port agent-a-000000 /tmp/a
  assert_eq 17301 "$PROXY_PORT" "lowest free slot between held ones"
}
test_assign_keeps_the_port_across_launches() {
  write_machine_meta agent-a-000000 /tmp/a 17350
  assign_proxy_port agent-a-000000 /tmp/a
  assert_eq 17350 "$PROXY_PORT" "own port kept, not moved to the lowest slot"
  assert_eq 17350 "$PROXY_PORT_PREV" "previous port reported"
}
test_assign_reads_a_record_written_before_this_change() {
  mkdir -p "$AGENT_VM_STATE_DIR/machines"
  printf 'format=1\nrepo_path=/tmp/a\n' >"$AGENT_VM_STATE_DIR/machines/agent-a-000000"
  assign_proxy_port agent-a-000000 /tmp/a
  assert_eq 17300 "$PROXY_PORT" "a record without proxy_port gets a slot"
  assert_eq "" "$PROXY_PORT_PREV" "no previous port for an old record"
}
test_assign_moves_only_the_launching_machine_off_a_shared_port() {
  write_machine_meta agent-a-000000 /tmp/a 17300
  write_machine_meta agent-b-000000 /tmp/b 17300
  assign_proxy_port agent-a-000000 /tmp/a
  assert_eq 17301 "$PROXY_PORT" "launching machine moves off a shared port"
  assert_eq 17300 "$PROXY_PORT_PREV" "the port it held is reported"
  assert_eq 17300 "$(read_meta_field agent-b-000000 proxy_port)" "the other record is untouched"
}
test_assign_ignores_invalid_values_in_any_record() {
  mkdir -p "$AGENT_VM_STATE_DIR/machines"
  printf 'format=1\nrepo_path=/tmp/b\nproxy_port=80\n' >"$AGENT_VM_STATE_DIR/machines/agent-b-000000"
  printf 'format=1\nrepo_path=/tmp/c\nproxy_port=041624\n' >"$AGENT_VM_STATE_DIR/machines/agent-c-000000"
  printf 'format=1\nrepo_path=/tmp/a\nproxy_port=17400\n' >"$AGENT_VM_STATE_DIR/machines/agent-a-000000"
  assign_proxy_port agent-a-000000 /tmp/a
  assert_eq 17300 "$PROXY_PORT" "invalid values hold no slot"
  assert_eq "" "$PROXY_PORT_PREV" "an invalid own value is not a previous port"
}
test_assign_with_a_full_pool_records_no_port() {
  local p status=0
  for ((p = 17300; p <= 17399; p++)); do write_machine_meta "agent-p$p-000000" "/tmp/$p" "$p"; done
  assign_proxy_port agent-a-000000 /tmp/a || status=$?
  assert_eq 0 "$status" "a full pool is not an error"
  assert_eq "" "$PROXY_PORT" "no port when the pool is full"
  assert_eq "" "$(read_meta_field agent-a-000000 proxy_port || true)" "no port recorded"
  assert_eq /tmp/a "$(read_meta_field agent-a-000000 repo_path)" "the record is still written"
}
test_assign_can_take_the_last_slot() {
  local p
  for ((p = 17300; p <= 17398; p++)); do write_machine_meta "agent-p$p-000000" "/tmp/$p" "$p"; done
  assign_proxy_port agent-a-000000 /tmp/a
  assert_eq 17399 "$PROXY_PORT" "the last slot is usable"
}
test_assign_reports_a_lost_port_when_the_pool_is_full() {
  local p
  for ((p = 17300; p <= 17399; p++)); do write_machine_meta "agent-p$p-000000" "/tmp/$p" "$p"; done
  write_machine_meta agent-a-000000 /tmp/a 17300
  assign_proxy_port agent-a-000000 /tmp/a
  assert_eq "" "$PROXY_PORT" "no slot left"
  assert_eq 17300 "$PROXY_PORT_PREV" "the lost port is reported"
  assert_eq "" "$(read_meta_field agent-a-000000 proxy_port || true)" "no port recorded"
}
test_assign_uses_only_the_first_proxy_port_line() {
  mkdir -p "$AGENT_VM_STATE_DIR/machines"
  printf 'format=1\nrepo_path=/tmp/b\nproxy_port=17301\nproxy_port=17300\n' >"$AGENT_VM_STATE_DIR/machines/agent-b-000000"
  assign_proxy_port agent-a-000000 /tmp/a
  assert_eq 17300 "$PROXY_PORT" "only the first proxy_port line holds a slot"
}
test_assign_stops_when_the_port_lock_cannot_be_opened() {
  mkdir -p "$AGENT_VM_STATE_DIR/ports.lock" # a directory in the lock file's place: exec 6> fails
  assert_status 1 "an unopenable port lock stops the launch" -- bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; assign_proxy_port agent-a-000000 /tmp/a"
  assert_status 1 "no record is written without the lock" -- test -f "$AGENT_VM_STATE_DIR/machines/agent-a-000000"
}
test_assign_releases_the_port_lock() {
  assign_proxy_port agent-a-000000 /tmp/a
  if { : >&6; } 2>/dev/null; then record "FAIL fd 6 is closed after assign_proxy_port"; else record "PASS fd 6 is closed after assign_proxy_port"; fi
  local status=0
  bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_port_lock 1" </dev/null >/dev/null 2>&1 || status=$?
  assert_eq 0 "$status" "port lock is free after assign_proxy_port returns"
  assert_status 0 "port lock file is outside machine records" -- test -f "$AGENT_VM_STATE_DIR/ports.lock"
  assert_eq "agent-a-000000" "$(machine_rows | cut -f1)" "ports.lock is not listed as a machine"
}
test_port_lock_excludes_a_second_holder_and_is_independent() {
  bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_port_lock 1 && sleep 3" </dev/null &
  sleep 1
  local status=0
  bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_port_lock 1" </dev/null >/dev/null 2>&1 || status=$?
  assert_eq 1 "$status" "a second holder times out while the port lock is held"
  status=0; try_lock agent-g-000000 || status=$?
  assert_eq 0 "$status" "repo lock unaffected by the port lock"
  wait
}
test_assign_concurrent_launches_get_distinct_ports() {
  local i
  for i in 1 2 3 4 5 6; do
    bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; assign_proxy_port agent-m$i-000000 /tmp/m$i" </dev/null >/dev/null 2>&1 &
  done
  wait
  local ports; ports=$(for i in 1 2 3 4 5 6; do read_meta_field "agent-m$i-000000" proxy_port; done | sort -u | wc -l | tr -d ' ')
  assert_eq 6 "$ports" "six concurrent launches record six distinct ports"
}
```

既存の `test_orb_q_closes_every_lock_fd`（L366-377）は、fd 6 を足して次の形に書き換える。

```bash
test_orb_q_closes_every_lock_fd() {
  orb() { ls /dev/fd >"$TMP_ROOT/fds"; } # replaces the stub for this subshell only
  exec 6>"$TMP_ROOT/l6" 7>"$TMP_ROOT/l7" 8>"$TMP_ROOT/l8" 9>"$TMP_ROOT/l9"
  orb list # positive control: a direct call does see the lock fds, so the listing below can detect a leak
  assert_contains " $(tr '\n' ' ' <"$TMP_ROOT/fds")" " 7 " "control: a direct call inherits fd 7"
  assert_contains " $(tr '\n' ' ' <"$TMP_ROOT/fds")" " 6 " "control: a direct call inherits fd 6"
  orb_q list
  exec 6>&- 7>&- 8>&- 9>&-
  local fds; fds=" $(tr '\n' ' ' <"$TMP_ROOT/fds")"
  assert_not_contains "$fds" " 6 " "fd 6 not inherited"
  assert_not_contains "$fds" " 7 " "fd 7 not inherited"
  assert_not_contains "$fds" " 8 " "fd 8 not inherited"
  assert_not_contains "$fds" " 9 " "fd 9 not inherited"
}
```

6 プロセス同時のテストは、lock の待ち（最大 30 秒、1 秒おきに再試行）の中で終わる。1 回の保持は meta を最大 6 個読んで 1 個書く間だけなので、待つ側は 1〜2 回の再試行で取れる。

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run.sh 2>&1 | tail -30`
期待: 末尾の failed が 1 以上になる。落ち方は次のとおりである。

- `assign_proxy_port` を直接呼ぶ `test_assign_*`（lock を別プロセスで試すものを除く）は、関数が無いので `FAIL test_... (test aborted)` になる。
- `test_valid_proxy_port_accepts_only_five_digits_in_range` は、`FAIL 17300 is a valid proxy port` と、stderr に `command not found` が出るための `FAIL no arithmetic error for '...'` になる。
- `test_assign_releases_the_port_lock`、`test_port_lock_excludes_a_second_holder_and_is_independent`、`test_assign_concurrent_launches_get_distinct_ports`、`test_assign_stops_when_the_port_lock_cannot_be_opened` は、assert の FAIL か `(test aborted)` になる。
- `test_meta_third_argument_writes_the_proxy_port` は `proxy_port written from the third argument` で FAIL になる。
- `test_meta_is_replaced_through_a_hidden_temp_file` は `the record is replaced, not rewritten in place` で FAIL になる（変更前は `>` で直接上書きするので、2 つ目の名前から見える内容も変わる）。
- `test_orb_q_closes_every_lock_fd` は `fd 6 not inherited` で FAIL になる。

- [ ] **Step 3: 最小実装を書く**

`meta_path`（L64）の直後に定数と関数を足し、`write_machine_meta`（L66-70）を置き換える。

```bash
# portless proxy ports (docs/agent-vm.md, #207): one per machine, so two machines never contend for the port a person
# opens on the mac. Above 1023 (no sudo in the VM), clear of portless's app range 4000-4999 and fallback 1355, of
# common dev server ports and of the ephemeral ranges.
PROXY_PORT_MIN=17300
PROXY_PORT_MAX=17399

# The one test for a usable proxy port: five digits without a leading zero, inside the range. The digit test comes
# first because bash arithmetic reads a leading 0 as octal (041624 is 17300; 017308 is an error).
valid_proxy_port() { # value
  [[ "$1" =~ ^[1-9][0123456789][0123456789][0123456789][0123456789]$ ]] || return 1
  [[ "$1" -ge "$PROXY_PORT_MIN" && "$1" -le "$PROXY_PORT_MAX" ]]
}

# Guards the choice of a proxy port across every machine's record. Held by assign_proxy_port only while the records
# are read and one is written: no orb call and no other lock under it, and it is released before the repo lock (fd 9)
# is taken.
acquire_port_lock() { # max_wait_seconds; holds fd 6 until release_port_lock or process exit
  local waited=0
  mkdir -p "$AGENT_VM_STATE_DIR" || return 1
  { exec 6>"$AGENT_VM_STATE_DIR/ports.lock"; } 2>/dev/null || return 1
  until perl -MFcntl=:flock -e 'open(my $f, ">&=", 6) or die "fdopen: $!"; flock($f, LOCK_EX | LOCK_NB) or exit 1'; do
    if [[ "$waited" -ge "$1" ]]; then exec 6>&-; return 1; fi
    sleep 1
    waited=$((waited + 1))
  done
}
release_port_lock() { exec 6>&-; }

pick_proxy_port() { # machine -> the port to record, or nothing when every slot is held. Reads only; caller holds the port lock
  local f m p own="" taken=" "
  for f in "$AGENT_VM_STATE_DIR"/machines/*; do
    [[ -f "$f" && "$f" != *.lock ]] || continue
    m=$(basename "$f")
    p=$(read_meta_field "$m" proxy_port) || continue
    valid_proxy_port "$p" || continue
    if [[ "$m" == "$1" ]]; then own=$p; else taken+="$p "; fi
  done
  if [[ -n "$own" && "$taken" != *" $own "* ]]; then printf '%s\n' "$own"; return 0; fi
  for ((p = PROXY_PORT_MIN; p <= PROXY_PORT_MAX; p++)); do
    if [[ "$taken" != *" $p "* ]]; then printf '%s\n' "$p"; return 0; fi
  done
  return 0 # a full pool is not an error here: the caller sees an empty answer
}

# machines/<m> records: format=1, repo_path, proxy_port (optional). Keys are only ever added and read_meta_field
# ignores the ones it does not know; nothing checks this record's format number. The record is rewritten whole on
# every launch, so a call without the third argument drops proxy_port: assign_proxy_port is the caller that passes a
# port, and a key added later has to be read back and passed in the same way.
write_machine_meta() { # machine repo_path [proxy_port]: takes no lock; written whole through a hidden temp file
  local port_line="" tmp
  case "$2" in *$'\n'*) die "repository path contains a newline; refusing to launch" ;; esac
  mkdir -p "$AGENT_VM_STATE_DIR/machines" || return 1
  if valid_proxy_port "${3:-}"; then port_line="proxy_port=$3"$'\n'; fi
  # Hidden name: machines/* never lists it. Replaced whole so a concurrent reader never sees a half-written record.
  tmp=$(mktemp "$AGENT_VM_STATE_DIR/machines/.$1.XXXXXX") || return 1
  printf 'format=1\nrepo_path=%s\n%s' "$2" "$port_line" >"$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$(meta_path "$1")" || { rm -f "$tmp"; return 1; }
}

# One assignment: under the port lock, read the port this machine held, pick, write. Sets PROXY_PORT (empty when the
# pool is full) and PROXY_PORT_PREV (empty when the record held no valid port) only after the record is written, so a
# port that was not recorded is never announced. Never call it in a subshell: the two globals are its result.
assign_proxy_port() { # machine repo_path
  local prev port
  # Checked before the lock is taken, so the refusal write_machine_meta would make never happens under the lock.
  case "$2" in *$'\n'*) die "repository path contains a newline; refusing to launch" ;; esac
  acquire_port_lock 30 || die "could not take the proxy port lock ($AGENT_VM_STATE_DIR/ports.lock): another agent-vm is holding it, or the state directory is not writable"
  prev=$(read_meta_field "$1" proxy_port) || prev=""
  valid_proxy_port "$prev" || prev=""
  port=$(pick_proxy_port "$1")
  if ! write_machine_meta "$1" "$2" "$port"; then
    release_port_lock
    die "could not write the machine record for $1"
  fi
  release_port_lock
  PROXY_PORT=$port
  PROXY_PORT_PREV=$prev
}
```

`orb_q`（L107）に fd 6 を足す。直前のコメント（L105-106）の `fd 7 golden` を `fd 7 golden, fd 6 proxy port` に直す。

```bash
orb_q() { orb "$@" </dev/null 9>&- 8>&- 7>&- 6>&-; }
```

lock の順序のコメント（L145-146）の末尾に、次の 1 文を足す。

```bash
# The proxy port lock (fd 6) is taken and released by assign_proxy_port before fd 9, and never held with another lock.
```

golden の meta のコメント（L419-420）の `machines/<m> records are a different schema under the same format number.` の直後に、` Their keys are listed at write_machine_meta.` を足す。

T1 の commit の時点では、`prepare_machine` はまだ `write_machine_meta` を 2 つの引数で呼ぶ。割り当ては行われず、meta は変更前と同じ 2 行になる。`assign_proxy_port` への置き換えは T2 で行う。

この実装が `set -euo pipefail` の下で意図どおりに動く根拠:

- `valid_proxy_port` は、桁の判定に通らなければ `|| return 1` で戻り、算術の比較に進まない。空文字、先頭が 0 の値、20 桁の値で算術エラーは出ない（research H13）。数字の括弧式を 4 回並べる書き方は、`{4}` の解釈が regex の実装に依らないようにするためである。`[0-9]` でなく `[0123456789]` と書くのは、範囲の意味が locale に依らないようにするためである。`[[ =~ ]]` の `$` は文字列の末尾にしか合わないので、改行を含む値は通らない。
- `pick_proxy_port` は、枠が無いときも `return 0` で終わる。`port=$(pick_proxy_port "$1")` の代入は、`set -e` で launcher を止めない。空の `port` が「枠なし」を表す。
- `read_meta_field` は、キーが無いか meta が無いと 1 を返す。`p=$(...) || continue` と `prev=$(...) || prev=""` は `||` の左辺なので `set -e` に掛からない。列挙の後に消えた meta は、枠を持たないものとして飛ばされる。
- `write_machine_meta` の中の失敗は、`|| return 1` で呼び出し側に返す。`assign_proxy_port` は `if ! write_machine_meta ...` で受け、lock を放してから `die` する。`if` の条件の中では `set -e` が効かないので、各行に `|| return 1` を明示している。`printf` と `mv` が失敗したときは、一時ファイルを消してから返す。
- 改行を含むパスは、`assign_proxy_port` が lock を取る前に `die` する。`write_machine_meta` の同じ検査（既存の動作）は、2 つの引数で直接呼ぶテストのために残す。
- `acquire_port_lock` の `exec 6>` は `{ ...; } 2>/dev/null || return 1` で包む。state dir に書けないときに `set -e` で落ちず、`assign_proxy_port` の `die` が理由を出す。
- `$'\n'` と C 形式の `for ((...))` は、launcher が既に使っている（L67、`nm_lock_quietly`）。
- `mktemp` はモード 0600 でファイルを作る。変更前の meta は umask に従う（通常 0644）。meta を読むのは同じユーザーの launcher だけなので、読み手は変わらない。
- 既存のテストは `write_machine_meta` を 2 つの引数で呼ぶ。`${3:-}` で読むので、`set -u` で落ちず、`proxy_port` の行を書かない動作になる。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run.sh 2>&1 | tail -5`
期待: 末尾が「N run, 0 failed」で、N は 698 より大きい。

実行: `bash tests/agent-vm/run.sh 2>&1 | grep -cE "^FAIL"`
期待: `0`

実行: `bash tests/agent-vm/run-shell.sh && bash scripts/lint-shell.sh`
期待: どちらも exit 0。`.shellcheckrc` は `quote-safe-variables` を有効にしているので、テストの中の変数の展開は quote する（SC2248）。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): add proxy port assignment and record it in the machine meta"
```

### T2: 割り当ての起動への組み込み、VM への受け渡し、表示、一覧（K4、K5、K6、K11、K12）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm:1472-1484`（`build_launch_script`）、`:1500-1507`（`prepare_machine`）、`:1589-1591`（`run_tool` の `notice_*` の並び）、`:1707-1715`（`machine_rows`）
- テスト: `tests/agent-vm/run.sh`（`test_launch_script_*` の近く）
- 参照: `tests/agent-vm/run.sh:546-556`（既存の `build_launch_script` のテストの形。`PROXY_PORT` を設定せずに呼ぶ）
- 参照: `tests/agent-vm/run.sh:602-614`（`session_exec` を差し替えて `run_tool claude` を通す既存のテストの形。`make_dotfiles_fixture` と `make_flow_repo` を使う）
- 参照: `tests/agent-vm/run.sh:615-624`（`cmd_prewarm` を通す既存のテストの形）、`:646-653`（`cmd_list` のテスト）

- [ ] **Step 1: 失敗するテストを書く**

```bash
test_launch_script_exports_the_proxy_port_after_the_env_file() {
  local cmd
  cmd=$(PROXY_PORT=17305 build_launch_script claude /r /dev/shm/agent-vm.env.x)
  assert_contains "$cmd" "export PORTLESS_PORT=17305 PORTLESS_HTTPS=0; " "proxy port and no-TLS exported"
  assert_not_contains "$cmd" "unset PORTLESS" "nothing unset when a port is assigned"
  local env_at port_at
  env_at=$(awk -v s="$cmd" 'BEGIN { print index(s, "agent-vm.env.x") }')
  port_at=$(awk -v s="$cmd" 'BEGIN { print index(s, "PORTLESS_PORT") }')
  if [[ "$env_at" -gt 0 && "$port_at" -gt "$env_at" ]]; then record "PASS the assignment wins over the env file"; else record "FAIL the assignment wins over the env file ($env_at/$port_at)"; fi
}
test_launch_script_without_a_valid_proxy_port_unsets_the_variables() {
  local cmd v env_at unset_at
  cmd=$(PROXY_PORT="" build_launch_script claude /r /dev/shm/agent-vm.env.x)
  assert_contains "$cmd" "unset PORTLESS_PORT PORTLESS_HTTPS; " "an env file value does not survive without an assigned port"
  assert_not_contains "$cmd" "export PORTLESS" "nothing exported without an assigned port"
  env_at=$(awk -v s="$cmd" 'BEGIN { print index(s, "agent-vm.env.x") }')
  unset_at=$(awk -v s="$cmd" 'BEGIN { print index(s, "unset PORTLESS_PORT") }')
  if [[ "$env_at" -gt 0 && "$unset_at" -gt "$env_at" ]]; then record "PASS the unset comes after the env file"; else record "FAIL the unset comes after the env file ($env_at/$unset_at)"; fi
  # The whole script is compared: "the value does not appear" would miss a quoted or misplaced embedding, and a short
  # value such as 80 can appear by chance in a forwarded host knob. The two allowlisted knobs are unset for that reason.
  unset CLAUDE_CODE_AUTO_COMPACT_WINDOW CLAUDE_CODE_MAX_OUTPUT_TOKENS
  for v in 041624 80 '17300; touch /tmp/pwned' "\$(id)"; do
    cmd=$(PROXY_PORT="$v" build_launch_script claude /r "" 2>/dev/null)
    assert_eq "cd /r; unset PORTLESS_PORT PORTLESS_HTTPS; exec claude" "$cmd" "an invalid PROXY_PORT ('$v') yields only the unset"
  done
  cmd=$(PROXY_PORT=$'17300\n17301' build_launch_script claude /r "" 2>/dev/null)
  assert_eq "cd /r; unset PORTLESS_PORT PORTLESS_HTTPS; exec claude" "$cmd" "a PROXY_PORT with a newline yields only the unset"
}
test_notice_proxy_port_names_the_port_on_stderr_only() {
  local out err
  err=$(PROXY_PORT=17305 notice_proxy_port 2>&1 >/dev/null)
  assert_contains "$err" "http://<app>.localhost:17305" "the notice carries the port"
  assert_contains "$err" "portless run" "the notice names the command"
  out=$(PROXY_PORT=17305 notice_proxy_port 2>/dev/null)
  assert_eq "" "$out" "nothing on stdout"
  err=$(PROXY_PORT="" notice_proxy_port 2>&1)
  assert_eq "" "$err" "silent without an assigned port"
}
test_notice_proxy_port_assignment_shows_a_change_and_a_full_pool() {
  local err
  err=$(PROXY_PORT=17301 PROXY_PORT_PREV=17300 notice_proxy_port_assignment agent-a-000000 2>&1)
  assert_contains "$err" "proxy port for agent-a-000000 changed 17300 -> 17301" "old and new port in fixed positions"
  assert_contains "$err" "recover: run 'portless proxy stop' in the VM" "the recovery step"
  err=$(PROXY_PORT=17300 PROXY_PORT_PREV=17300 notice_proxy_port_assignment agent-a-000000 2>&1)
  assert_eq "" "$err" "silent when the port is kept"
  err=$(PROXY_PORT=17300 PROXY_PORT_PREV="" notice_proxy_port_assignment agent-a-000000 2>&1)
  assert_eq "" "$err" "silent on the first assignment"
  err=$(PROXY_PORT="" PROXY_PORT_PREV=17300 notice_proxy_port_assignment agent-a-000000 2>&1)
  assert_contains "$err" "changed 17300 -> none" "a port lost to a full pool is a change"
  assert_contains "$err" "agent-vm rm <repo>" "the full-pool warning names the recovery that frees a slot"
  err=$(PROXY_PORT="" PROXY_PORT_PREV="" notice_proxy_port_assignment agent-a-000000 2>&1)
  assert_contains "$err" "do not go through portless" "the full-pool warning says what stops working"
  assert_not_contains "$err" "changed" "no change line without a previous port"
}
test_run_tool_hands_the_port_to_the_session_and_names_it() {
  local wt repo m err; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  session_exec() { printf '%s\n' "$2" >"$TMP_ROOT/launch-script"; } # replaces the real orb session in this subshell only
  err=$( (cd "$repo" && PROXY_PORT=99999 STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$m running" run_tool claude) 2>&1 >/dev/null) || true
  assert_eq 17300 "$(read_meta_field "$m" proxy_port)" "the launch records a port"
  assert_contains "$(cat "$TMP_ROOT/launch-script")" "export PORTLESS_PORT=17300 PORTLESS_HTTPS=0; " "the session receives the recorded port"
  assert_contains "$err" "localhost:17300" "the launch names the port on stderr"
  assert_not_contains "$err" "changed" "no change line on the first assignment"
}
test_prepare_machine_ignores_proxy_port_from_the_host_environment() {
  local wt repo m; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  session_exec() { printf '%s\n' "$2" >"$TMP_ROOT/launch-script"; }
  assign_proxy_port() { :; } # replaces the assignment in this subshell only: only the clearing in prepare_machine is left
  (cd "$repo" && PROXY_PORT=17305 PROXY_PORT_PREV=17306 STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$m running" run_tool claude) >/dev/null 2>&1 || true
  assert_contains "$(cat "$TMP_ROOT/launch-script")" "unset PORTLESS_PORT PORTLESS_HTTPS; " "a PROXY_PORT from the host environment is not used"
  assert_not_contains "$(cat "$TMP_ROOT/launch-script")" "export PORTLESS" "nothing exported from the host environment's value"
}
test_prewarm_reports_a_changed_port_and_names_no_url() {
  local wt repo m err; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  write_machine_meta "$m" "$(cd -P "$repo" && pwd -P)" 17300
  write_machine_meta agent-other-000000 /tmp/other 17300
  session_exec() { record "FAIL prewarm must not start a session"; }
  err=$( (cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_STDOUT="v1:old" cmd_prewarm) 2>&1 >/dev/null) || true
  assert_eq 17301 "$(read_meta_field "$m" proxy_port)" "prewarm moves the machine off the shared port"
  assert_contains "$err" "changed 17300 -> 17301" "prewarm shows the recovery for the change it made"
  assert_not_contains "$err" "dev servers: run them" "prewarm does not name a URL to open"
}
test_list_shows_only_a_valid_proxy_port() {
  mkdir -p "$TMP_ROOT/repo-a" "$TMP_ROOT/repo-b" "$TMP_ROOT/repo-c"
  write_machine_meta agent-a-000000 "$TMP_ROOT/repo-a" 17300
  write_machine_meta agent-b-000000 "$TMP_ROOT/repo-b"
  printf 'format=1\nrepo_path=%s\nproxy_port=041624\n' "$TMP_ROOT/repo-c" >"$AGENT_VM_STATE_DIR/machines/agent-c-000000"
  local rows; rows=$(machine_rows)
  assert_contains "$rows" "agent-a-000000	present	$TMP_ROOT/repo-a	17300" "4th column is the proxy port"
  assert_eq "agent-b-000000	present	$TMP_ROOT/repo-b	" "$(printf '%s\n' "$rows" | grep '^agent-b-')" "a record without a port ends in a tab"
  assert_eq "agent-c-000000	present	$TMP_ROOT/repo-c	" "$(printf '%s\n' "$rows" | grep '^agent-c-')" "an invalid stored value is not shown"
}
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run.sh 2>&1 | tail -20`
期待: 末尾の failed が 1 以上になる。`notice_proxy_port` と `notice_proxy_port_assignment` のテストは、関数を `$(...)` の中で呼ぶので止まらず、`command not found` が stderr に入って assert の FAIL になる（`silent ...` の assert は、actual に `command not found` が出る）。`test_prepare_machine_ignores_proxy_port_from_the_host_environment`、`test_run_tool_hands_the_port_to_the_session_and_names_it`、`test_prewarm_reports_a_changed_port_and_names_no_url` も assert の FAIL になる。`build_launch_script` のテストは `proxy port and no-TLS exported` と `an env file value does not survive` で FAIL になる。`machine_rows` のテストは `4th column is the proxy port` で FAIL になる。

- [ ] **Step 3: 最小実装を書く**

`build_launch_script`（L1472-1484）では、env file の `if` の後、既存の `forward_env_exports` の行の前に足す。既存のコメントと行は残す。

```bash
  # After the env file so the assignment wins over a PORTLESS_PORT stored there. Checked again here because the value
  # goes into the script unquoted; without a usable port the variables are unset so an env file value cannot linger.
  if valid_proxy_port "${PROXY_PORT:-}"; then
    script+="; export PORTLESS_PORT=$PROXY_PORT PORTLESS_HTTPS=0"
  else
    script+="; unset PORTLESS_PORT PORTLESS_HTTPS"
  fi
  # After the env file so a host knob wins over a stale value stored there.
  script+="; $(forward_env_exports)exec $tool"
```

`prepare_machine`（L1500-1507）では、関数のコメントを「sets MACHINE, REPO, PROXY_PORT and PROXY_PORT_PREV」に直す。冒頭で 2 つの変数を空にし、`write_machine_meta "$MACHINE" "$REPO"`（L1506）を次の 2 行に置き換える。

```bash
prepare_machine() { # tool -> sets MACHINE, REPO, PROXY_PORT and PROXY_PORT_PREV; leaves the machine bootstrapped
  local wt gen hash out
  PROXY_PORT="" PROXY_PORT_PREV="" # never inherited from the host environment
  check_health
  REPO=$(resolve_repo_root)
  wt=$(resolve_working_tree)
  MACHINE=$(derive_machine_name "$REPO")
  assign_proxy_port "$MACHINE" "$REPO"
  notice_proxy_port_assignment "$MACHINE"
  acquire_lock "$MACHINE" 60 || die "timed out waiting for another session of this repo"
```

`notice_proxy_port_assignment` と `notice_proxy_port` を、`prepare_machine` の前に定義する。

```bash
# Reported from prepare_machine, so prewarm shows it too: a port that moved (spec K12) and a pool with no free slot
# (spec K4). Only the call that rewrote the record knows the port it replaced. The recovery steps sit at fixed
# positions after "recover:" and "free one with:".
notice_proxy_port_assignment() { # machine
  local prev=${PROXY_PORT_PREV:-} port=${PROXY_PORT:-}
  if [[ -n "$prev" && "$prev" != "$port" ]]; then
    step "proxy port for $1 changed $prev -> ${port:-none}; a proxy still running in the VM may listen on $prev, and URLs it prints may be stale. recover: run 'portless proxy stop' in the VM, then start the dev server again"
  fi
  if [[ -z "$port" ]]; then
    step "no free portless proxy port in $PROXY_PORT_MIN-$PROXY_PORT_MAX; dev servers in this machine do not go through portless and can collide with other machines. free one with: agent-vm rm <repo> for a machine you no longer use (agent-vm gc if its repository was deleted)"
  fi
}

# Tells the person at the mac which port this machine's dev servers answer on (spec K11). portless picks the name
# when a dev server starts, so the launcher can only show the port.
notice_proxy_port() {
  if [[ -n "${PROXY_PORT:-}" ]]; then
    step "dev servers: run them with 'portless run <command>'; open http://<app>.localhost:$PROXY_PORT on the mac"
  fi
}
```

`run_tool` の `notice_gh_token_expiry "$MACHINE"`（L1591）の次の行に `notice_proxy_port` を足す。`run_tool` の host の経路（`exec "$tool" "$@"`）は `prepare_machine` より前に抜けるので、この表示は出ない。`cmd_prewarm` は `run_tool` を通らないので、こちらでも出ない。

`machine_rows`（L1707-1715）は 4 列目を出す。

```bash
machine_rows() { # TSV only: machine, state, repo_path, proxy_port (shown only when valid; may be empty). cmd_list prints it; cmd_gc reads columns 1-2
  local f m p
  for f in "$AGENT_VM_STATE_DIR"/machines/*; do
    [[ -f "$f" && "$f" != *.lock ]] || continue
    m=$(basename "$f")
    p=$(read_meta_field "$m" proxy_port || true)
    valid_proxy_port "$p" || p=""
    printf '%s\t%s\t%s\t%s\n' "$m" "$(machine_state "$m")" "$(read_meta_field "$m" repo_path || true)" "$p"
  done
  return 0
}
```

`cmd_gc` の awk は `-F'\t'` で `$1` と `$2` だけを読むので、変わらない。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run.sh 2>&1 | tail -5`
期待: 末尾が「N run, 0 failed」である。

実行: `bash tests/agent-vm/run-shell.sh && bash scripts/lint-shell.sh`
期待: どちらも exit 0。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): hand the proxy port to VM sessions and show it at launch and in list"
```

### T3: portless の導入と agent への指示（K7、K8）

**Files:**

- 編集: `home/dot_config/mise/config.toml:19-50`（`[tools]`）
- 編集: `home/dot_claude/CLAUDE.md:13-21`（Key Commands）
- 編集: `home/dot_codex/AGENTS.md:13-18`（`## Commands`）
- 参照: `tests/agent-vm/run-templates.sh`（mise のファイルが plain TOML で、共有のセットに host のツールチェーンが無いことの検査）

- [ ] **Step 1: 変更**
  - `config.toml` の `"github:k1LoW/mo" = "1.5.5"`（L40）の行の前に、次を足す。

```toml
# Per-machine dev server proxy for agent-vm (docs/agent-vm.md, #207); it starts nothing until `portless run` is used.
portless = "0.15.6"
```

- `CLAUDE.md` の Key Commands の `Worktree` の行（L20）の後に、次を足す。

```markdown
- **Dev server**: `PORTLESS_PORT` が設定されているとき（agent-vm）は `portless run <dev コマンド>` で起動し、表示された URL を使う。ポートを自分で選ばない。`portless` が失敗するときは、ほかのポートで起動し直さずに報告する
```

- `AGENTS.md` の `## Commands` の `Format` の行（L18）の後に、次を足す。

```markdown
- **Dev server**: when `PORTLESS_PORT` is set (agent-vm), start it with `portless run <dev command>` and use the URL it prints. Do not pick a port yourself. If `portless` fails, report it instead of starting the server on another port
```

- [ ] **Step 2: 検査**

実行: `bash tests/agent-vm/run-templates.sh 2>&1 | tail -3`
期待: failed が 0。

実行: `python3 -c 'import tomllib; print(tomllib.load(open("home/dot_config/mise/config.toml","rb"))["tools"]["portless"])'`
期待: `0.15.6`

実行: `grep -c 'PORTLESS_PORT' home/dot_claude/CLAUDE.md home/dot_codex/AGENTS.md`
期待: 2 つのファイルとも `1`。

- [ ] **Step 3: コミット**

```bash
git add home/dot_config/mise/config.toml home/dot_claude/CLAUDE.md home/dot_codex/AGENTS.md
git commit -m "feat(mise): install portless and tell VM agents to start dev servers through it"
```

### T4: docs と ADR、成果物の保存（K9）

**Files:**

- 編集: `docs/agent-vm.md:50-51`（「VM でブラウザを使う」の 2 項）、`:221-255`（mac 実機での確認項目の表）
- 編集: `docs/decisions/0018-agent-vm-orbstack.md:85`（Consequences の項）、`:89-96`（Amended by）
- 編集: `docs/plans/agent-vm/portless/{research,spec,plan-1}.md`（引き継ぎ前の版を置き換える）
- 削除: `docs/plans/agent-vm/portless/review-notes.md`
- 参照: `docs/agent-vm.md:300-305`（2026-10-02 の観測。残す）

- [ ] **Step 1: docs/agent-vm.md の L50-51**
  - 「人が画面を見るとき」と「同じポートの衝突」の 2 項を、次の 5 項に置き換える。
    - **dev server は portless で起動する。**
      - VM の中で `portless run <dev コマンド>` を実行する。例: `portless run pnpm dev`。
      - linked worktree では、ブランチ名が付いて `http://<branch>.<app>.localhost:<port>` になる。
      - 名前は package.json の `name`、無ければ git の根の名前から決まる。`portless <name> <cmd>` の形はブランチ名を付けないので、worktree では使わない。
    - **どの URL を開くか。**
      - mac のブラウザで `http://<app>.localhost:<port>` を開く。
      - `<port>` は machine ごとの proxy のポートである。launcher が起動時に 1 行で表示する。後からは、mac で `agent-vm list` を実行し、その machine の行の 4 列目を見る。
      - `<app>` は、VM の `portless run` が起動時に表示する。後からは、VM で `portless list` を実行する。
      - ポートは machine がある間は変わらない。`agent-vm rm` で作り直すと、別のポートになりうる。
      - `portless list` に出ない dev server は、portless を通っていない。
    - **portless を通さないとき。**
      - 既定の loopback bind（`127.0.0.1`）のまま、mac の `http://localhost:<port>` で開ける。`<machine>.orb.local` は `0.0.0.0` に bind したときにしか届かない。
      - ただし、複数の machine が同じポートを使うと、`localhost` は先に bind した machine に届く。先に bind した側のサーバーを止めても、転送は後から bind した machine に移らず、応答しなくなる（#207）。
      - portless を通せば、人が開くのは machine ごとの proxy のポートだけになり、launcher の割り当てが machine 同士で重なることはない。VM の中のプロセスがほかの machine のポートに直接 bind する場合は防げない（「気をつけること」）。
    - **うまく開けないとき。**
      - launcher が `proxy port for <machine> changed ...` を表示したとき、または表示のポートで開けないときは、VM の中で `portless proxy stop` を実行してから dev server を起動し直す。前に起動した proxy が、古いポートで動き続けていることがある。
      - 17300〜17399 の枠がすべて使われていると、launcher が起動のたびに警告を出す。その machine では portless を使わない（手でも起動しない）。使わなくなった machine を `agent-vm rm <repo>` で消すと、枠が空く。
      - mac で同じポートを別のプログラムが使っている場合は、その machine を `agent-vm rm` で作り直す。
    - **気をつけること。**
      - cookie はホスト名で分かれ、ポートでは分かれない。2 台の machine のアプリが同じ名前（`app.localhost`）だと、同じブラウザのプロファイルでは cookie を共有する。片方の VM の dev server が、もう片方の認証の cookie を受け取る。VM の agent を信頼しない前提では、認証の cookie が、信頼しない VM に渡る。認証つきの dev server を複数の machine で開くときは、ブラウザのプロファイルを分けるか、package.json の `name` を machine の間で重ならないものにする。
      - VM の中のプロセスは、ほかの machine の proxy のポートに直接 bind できる。相手の proxy が動いていない間に bind されると、mac のそのポートは bind した VM に届く。相手の machine からは気づけない。確かめられない dev server の URL に、認証情報を入れない。
      - `agent-vm list` と VM の `portless list` を突き合わせても、奪われていることは分からない。どちらも奪われた側の正しい情報で、奪われていても一致する。
      - 開いた先が想定の machine かどうかの確かめ方は、V31 の手順 5 の結果で決める。比べ方で差が出たら、「mac から届く応答と、`orb -m <machine> curl ...` でその machine の中から見た応答を比べる。違えば奪われている。同じでも、安全の証明にはならない」と書く。差が出なかったら、「確かめる手段が無い」と書く。V31 の実行前の PR では、後者を書いておく。
  - `8a6c0af` が足した文（L51 の 2 文目）は、上の「portless を通さないとき」の 2 つ目の箇条として残る。
- [ ] **Step 2: docs/agent-vm.md の確認項目の表**
  - V29 の行の後に、V30〜V33 の 4 行を足す。
    - V30: 操作「VM で `portless run` でサーバーを起動し、mac の Chrome で `http://<app>.localhost:<port>/` を開く。mac から `127.0.0.1` と `[::1]` に Host を付けて curl し、`lsof` で待ち受けアドレスを見る」、期待「Chrome で開く。待ち受けアドレスは loopback だけである」
    - V31: 操作「2 台の machine でそれぞれ `portless run` でサーバーを起動する。両方で同じポートに直接 bind する。1 台目の proxy を止め、2 台目から 1 台目のポートに bind する。同じ名前のアプリで cookie を見る」、期待「それぞれのポートが自分の machine に届く。直接の bind と 1 台目の停止は、2 台目の URL に影響しない。奪取の再現と cookie の共有は記録する」
    - V32: 操作「linked worktree と main worktree で同時に `portless run` でサーバーを起動する」、期待「`http://<branch>.<app>.localhost:<port>` と `http://<app>.localhost:<port>` が、それぞれの内容を返す」
    - V33: 操作「mac と VM で `mise ls portless` と `portless --version` を実行する。VM で `ss -ltn` と `~/.portless/proxy.log` と `portless list` を見る」、期待「どちらも 0.15.6。proxy は `127.0.0.1` と `[::1]` だけで待ち受ける」
  - 表の下に「V30〜V33 の手順」の小節を足し、spec の「mac の実機での確認（V30〜V33）」の「前提」「先に実行する場合」と、V30〜V33 の操作・判定・記録だけするものを写す。merge の条件（「いつ実行するか」）は PR の本文に書き、docs には写さない。
  - 表の列幅は oxfmt が揃える（Step 5）。
- [ ] **Step 3: ADR-0018**
  - Consequences の L85 の項の末尾に、次を足す。「（2026-10-04 追記）launcher が machine ごとに portless の proxy のポートを割り当て、dev server を portless 経由で開くことで、machine 同士が同じポートを取り合うことを避ける。VM がほかの machine のポートに直接 bind する場合には効かない（`docs/plans/agent-vm/portless/spec.md` の R9）」
  - Amended by の末尾に 1 項を足す。「`docs/plans/agent-vm/portless/spec.md` (2026-10-04、#207) — dev server のポートは、VM ごとの portless の proxy で振り分ける。launcher は machine ごとに 17300〜17399 から proxy のポートを 1 つ割り当てて meta（`proxy_port`）に記録し、`PORTLESS_PORT` と `PORTLESS_HTTPS=0` でセッションに渡す。割り当ての台帳は VM がマウントしない `machines/` に置き、proxy は loopback に bind するので、K1 と K23 の境界は変わらない。portless は host と共有の mise の設定で入る（K5 の軽量セットに 1 つ足す）。VM の中のプロセスがほかの machine の proxy のポートに直接 bind して、mac の `localhost` の転送を奪えることは、既存の性質として受け入れた。この変更で、すべての machine のポートが 1 つの範囲に入る。防ぐには host が mac の側の待ち受けを持つ必要があり、常駐の部品を要するので入れていない」
- [ ] **Step 4: 成果物の保存**
  - workflow dir（`.tmp/sessions/acc72cfa/`）の research.md、spec.md、plan-1.md で、`docs/plans/agent-vm/portless/` の同名のファイルを置き換える。引き継ぎ前の版の先頭にあった「WIP・未承認」の注記は、置き換えで無くなる。
  - ワークフローの帳簿（`<!-- auto-review ... -->` などの marker と Reviewer Outputs）は、そのまま残す。
  - `git rm docs/plans/agent-vm/portless/review-notes.md` を実行する。その内容（クラウドの Round 1 の途中の指摘 8 件）は、spec と plan に反映済みである。
- [ ] **Step 5: 検査**

実行: `npx oxfmt --check --ignore-path .oxfmtignore docs/agent-vm.md docs/decisions/0018-agent-vm-orbstack.md docs/plans/agent-vm/portless home/dot_claude/CLAUDE.md home/dot_codex/AGENTS.md`（repo の `format:check` と同じ整形器）
期待: exit 0。差分が出たら、同じ引数から `--check` を外して整形し、再実行する。`docs/plans/agent-vm/` は `.oxfmtignore` が除外しているので、この検査が実際に見るのは残りの 4 つのファイルである。除外された path を引数に渡したことで失敗する場合は、引数から `docs/plans/agent-vm/portless` を外す。表に長いセルを足すと、既存の V1〜V29 の行も列幅の揃え直しで差分に出る。

実行: `grep -c '^| V3[0-3] ' docs/agent-vm.md`
期待: `4`

実行: `git ls-files docs/plans/agent-vm/portless/`
期待: `plan-1.md`、`research.md`、`spec.md` の 3 行。

- [ ] **Step 6: コミット**

```bash
git add docs/agent-vm.md docs/decisions/0018-agent-vm-orbstack.md docs/plans/agent-vm/portless/
git commit -m "docs(agent-vm): route dev servers through a per-machine portless proxy"
```

### T5: 全体の検査と PR（merge の gate）

- [ ] **Step 1**: 次を実行する。期待はどれも exit 0 で、failed が 0。
  - `bash tests/agent-vm/run.sh`
  - `bash tests/agent-vm/run-shell.sh`
  - `bash tests/agent-vm/run-templates.sh`
  - `bash tests/agent-vm/run-bootstrap.sh`
  - `bash scripts/lint-shell.sh`
- [ ] **Step 2**: 自分の diff を読み直す。確かめる点は次の 4 つ。
  - bash 3.2 で使えない構文（連想配列、`mapfile`、`${var,,}`、`&>>`）が、足した行に無いこと。
  - `acquire_port_lock` と `release_port_lock` の間に、orb を呼ぶ行と、ほかの lock を取る行が無いこと。
  - launcher の中で `write_machine_meta` を呼ぶのが `assign_proxy_port` だけであること（`grep -n 'write_machine_meta' home/dot_local/bin/executable_agent-vm` の結果が、定義・コメント・`assign_proxy_port` の中の 1 か所だけ）。
  - `shopt -s dotglob` が launcher に無いこと（`grep -c dotglob home/dot_local/bin/executable_agent-vm` が `0`）。
- [ ] **Step 3**: `git push -u origin wip/207-portless-plan` で push し、PR を **draft** で作る（`gh pr create --draft`）。本文は `pr-description` skill に従い、次を含める。
  - `Closes #207`。
  - merge の条件: spec の「mac の実機での確認」の「いつ実行するか」の 2 つの条件を、チェックリストとして写す。判定の欄を空欄で置く。欄は 5 つである: V30（表の 3 行のどれに当たったか）、V31、V32、V30 の R11（mac の側の待ち受けアドレスが loopback だけか）、V33 の手順 2（VM の中の待ち受けアドレスが `127.0.0.1` と `[::1]` だけか）。
  - mac の実機での確認が未実行であること。特に、Chrome で URL が開くか（spec R1）と、mac の側の待ち受けアドレス（R11）が分かっていないこと。
  - VM がほかの machine のポートに直接 bind できること（R9）を、既存の性質として受け入れたこと。
  - smoke script と bootstrap を変えない理由（spec K10）。#207 のオーダーは、smoke script を変える見込みと書いていた。
  - mise が host と VM で portless 0.15.6 を実際に入れられるかは、まだ確かめていないこと（spec R4、V33）。
  - bash 3.2 での実行は、CI の macOS の job が確かめること。
  - 文書の後始末（WIP の版の置き換えと `review-notes.md` の削除）を、機能の変更とは別の項目として書く。
- [ ] **Step 4（gate、人が行う）**: PR を draft のままにし、人が mac で V30〜V33 を実行する。spec の 2 つの条件がそろったら、結果を `docs/agent-vm.md` の「確認結果」に日付つきで記録し、R9 の確かめ方の記述（T4 Step 1）を V31 の手順 5 の結果に合わせて直し、PR を ready にする。条件が崩れたら、merge せずに spec を改訂する。この Step は、この plan の実装では実行しない。

## mac の実機での確認手順（V30〜V33）

判定と merge の条件は、spec の「mac の実機での確認（V30〜V33）」が正である。この plan は、その手順を `docs/agent-vm.md`（T4 Step 2）と PR の本文（T5 Step 3）に写す。実機でコマンドの細部を補正するときは、docs の側を直す。判定が変わる補正は、spec を改訂する。

引き継ぎ前の文書と #207 のコメントでは、V24〜V27 と呼んでいた。`docs/agent-vm.md` の表が V29 まで使っているので、番号を振り直した。

## ISO 25010 具体テストケース

### 機能適合性（正確性）

- **入力**: `valid_proxy_port` に 17300、17350、17399 → **期待**: 真
- **入力**: `valid_proxy_port` に 17299、17400、空文字、`0`、`80`、`017300`、`017308`、`041624`、`1730 0`、`17300x`、`18446744073709568916` → **期待**: 偽で、stderr に何も出ない
- **入力**: meta が 1 つも無い状態で `assign_proxy_port agent-a-000000 /tmp/a` → **期待**: `PROXY_PORT=17300`、`PROXY_PORT_PREV` は空、meta に `proxy_port=17300` と `repo_path=/tmp/a`
- **入力**: ほかの meta が 17300 と 17302 を持ち、`.lock` のファイルもある → **期待**: 17301
- **入力**: 自分の meta が 17350 を持ち、ほかに重複なし → **期待**: 17350 のまま、`PROXY_PORT_PREV=17350`
- **入力**: 自分とほかの meta が両方 17300 → **期待**: 自分は 17301、`PROXY_PORT_PREV=17300`、ほかは 17300 のまま
- **入力**: ほかの meta が `80` と `041624`、自分が `17400` → **期待**: 自分は 17300、`PROXY_PORT_PREV` は空
- **入力**: `PROXY_PORT=17305` で `build_launch_script claude /r /dev/shm/agent-vm.env.x` → **期待**: 出力に `export PORTLESS_PORT=17305 PORTLESS_HTTPS=0; ` が含まれ、env file の source より後にある
- **入力**: stub の下で `run_tool claude` → **期待**: meta の `proxy_port` は 17300 で、`session_exec` に渡る script に `export PORTLESS_PORT=17300 PORTLESS_HTTPS=0; ` が含まれる
- **入力**: 17300〜17398 の 99 枠をほかの meta が持つ → **期待**: 17399（範囲の最後の枠が使える）
- **入力**: ほかの meta に `proxy_port=17301` と `proxy_port=17300` の 2 行がこの順にある → **期待**: 自分は 17300（最初の行だけが枠を持つ）
- **入力**: `valid_proxy_port` に、改行を含む値（`17300\n`、`\n17300`、`17300\n17301`）→ **期待**: 偽

### 互換性（共存性）

- **入力**: `write_machine_meta` を 2 つの引数で呼ぶ既存のテスト（`repo_path keeps '='`、`newline path rejected` ほか）→ **期待**: PASS のまま
- **入力**: `proxy_port` の無い meta（`format=1` と `repo_path` の 2 行）に `assign_proxy_port` → **期待**: 17300 が割り当てられる
- **入力**: 3 つの引数で書いた meta を、2 つの引数で書き直す → **期待**: `proxy_port` の行が消える（意図した動作）
- **入力**: ポートあり、ポートなし、`proxy_port=041624` の 3 つの meta で `machine_rows` → **期待**: 順に、4 列目が `17300`、空（行末が tab）、空（行末が tab）
- **入力**: `machines/` に `.agent-z-000000.abc123` と `ports.lock`（state dir の直下）がある状態の `machine_rows` → **期待**: どちらも行に出ない
- **入力**: 既存の `cmd_gc` と `cmd_list` のテスト → **期待**: PASS のまま

### 信頼性（障害許容性）

- **入力**: 17300〜17399 の 100 枠すべてを、ほかの meta が持つ状態で `assign_proxy_port` → **期待**: 関数は 0 で返り、`PROXY_PORT` は空、meta は `proxy_port` なしで書かれる
- **入力**: 100 枠すべてをほかの meta が持ち、自分の meta も 17300 を持つ → **期待**: `PROXY_PORT` は空、`PROXY_PORT_PREV=17300`、meta に `proxy_port` は無い
- **入力**: `ports.lock` の位置に dir がある状態で、別プロセスから `assign_proxy_port` → **期待**: 1 で終わり、meta は書かれない
- **入力**: meta を書いた後、そのファイルに 2 つ目の名前（ハードリンク）を付けてから `write_machine_meta` で書き直す → **期待**: 2 つ目の名前からは古い内容が読める（直接の上書きではなく、置き換えである）
- **入力**: `PROXY_PORT=""`、`PROXY_PORT_PREV=""` で `notice_proxy_port_assignment` → **期待**: stderr に `do not go through portless` と `agent-vm rm <repo>` を含む警告
- **入力**: 6 つの `assign_proxy_port` を別プロセスで同時に実行する → **期待**: 6 つの meta の `proxy_port` がすべて異なる
- **入力**: `assign_proxy_port` の後に、同じシェルで `: >&6` → **期待**: 失敗する（fd 6 は閉じている）
- **入力**: 別プロセスが port lock を 3 秒持つ間に、`acquire_port_lock 1` と repo lock の取得 → **期待**: 前者は 1、後者は 0
- **入力**: fd 6・7・8・9 を開いた状態で `orb_q list` → **期待**: orb の側に 6・7・8・9 のどれも渡らない
- **入力**: `PROXY_PORT=17301`、`PROXY_PORT_PREV=17300` で `notice_proxy_port_assignment agent-a-000000` → **期待**: stderr に `proxy port for agent-a-000000 changed 17300 -> 17301` と `recover: run 'portless proxy stop' in the VM`
- **入力**: 前の値と今回の値が同じ、または前の値が空 → **期待**: 付け替えの行は出ない
- **入力**: `PROXY_PORT=""`、`PROXY_PORT_PREV=17300` → **期待**: `changed 17300 -> none` と枠切れの警告の両方
- **入力**: 自分とほかの meta が両方 17300 の状態で `cmd_prewarm` → **期待**: meta は 17301 になり、stderr に `changed 17300 -> 17301` が出る。`dev servers: run them` は出ない

### セキュリティ（完全性）

- **入力**: env file が先、`export` が後の順の launch script → **期待**: `export` の位置が env file の source より後
- **入力**: `PROXY_PORT=""` で、env file つきの `build_launch_script` → **期待**: `unset PORTLESS_PORT PORTLESS_HTTPS; ` が env file の source より後にあり、`export PORTLESS` は無い
- **入力**: `PROXY_PORT` が `041624`、`80`、`17300; touch /tmp/pwned`、`$(id)`、`17300\n17301` → **期待**: launch script の全体が `cd /r; unset PORTLESS_PORT PORTLESS_HTTPS; exec claude` と一致する
- **入力**: `assign_proxy_port` を何もしない関数に差し替え、host の環境に `PROXY_PORT=17305` を置いて `run_tool claude` → **期待**: launch script に `unset PORTLESS_PORT PORTLESS_HTTPS; ` があり、`export PORTLESS` は無い（`prepare_machine` の冒頭の初期化が効いている）
- 直接 bind する経路（spec R9）は、テストの対象にしない。

### 使用性

- **入力**: `PROXY_PORT=17305` で `notice_proxy_port` → **期待**: stderr に `http://<app>.localhost:17305` と `portless run` を含む 1 行。stdout は空
- **入力**: `PROXY_PORT=""` で `notice_proxy_port` → **期待**: 何も出ない
- **入力**: stub の下で `run_tool claude` → **期待**: stderr に `localhost:17300` を含み、`changed` を含まない

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘: plan のテストと実装を launcher の複製に当てて実行した結果は 792 run, 0 failed で、既存のテストの退行は 0。blocking は 1 件: T1 のテストの quote なしの `agent-m$i-000000` と T2 の単引用符の `'$(id)'` が shellcheck（SC2248、SC2016）に掛かり、`lint-shell.sh` が exit 1 になる。minor は、Step 2 の期待の書き方、置き換えを検査していない一時ファイルのテスト、枠切れの戻り値、テストの label、oxfmt の対象。

### scope-justification-reviewer
- verdict: pass
- 主指摘: spec の K1〜K12 と確認の節は plan に落ちており、spec に無い作業は無い。minor は、T1 の commit message、T1 での lint、`orb_q` の直前のコメント、L419 の指示の書き方、T5 の gate の欄。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: lock の形と関数の分担は既存の流儀と一貫し、T1 だけを当てた launcher も動く。minor は、`notice_proxy_port_assignment` の名前が枠切れの警告を含む中身に合わないこと、T1 の時点で事実と違うコメント、改行の検査の位置。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: 境界を破る経路と注入の余地は無い。minor は、`prepare_machine` の空初期化を検証できていないテスト、launch script を完全一致で比べること、失敗時の一時ファイル、docs の言い切りと R9・R10 の写し方。

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: 実装は spec の K3・K12 と一致し、契約の穴は無い。minor は、T1 の時点のコメント、失敗時の一時ファイル、部分一致で弱い assert、境界のテスト（最後の枠、枠切れで失うポート、`proxy_port` の行が 2 つ、lock を開けない場合）。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

<!-- parent-spec-hash は plan-review-automation hook が auto-review marker 生成時に挿入する。手で編集しない。 -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: pass
- 主指摘: plan のテストと実装を launcher の複製に当てて実行した。T1 だけで 767 run, 0 failed、T1 と T2 で 802 run, 0 failed。shellcheck と `lint-shell.sh` はどちらの状態でも exit 0 で、前回の blocking は解消。足したテストは変異（初期化の行を消す、直接の上書きに戻す）で落ちることを確かめた。minor 1 件（T2 Step 2 の期待の書き方）は反映した。bash 3.2 での実行は未確認で、CI の macOS が担う。

### scope-justification-reviewer
- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=3c2063df3a073b21dedb1951a11428de5b0e92e108bed7c1a65f08dcdf07bdf7; design-hash=43d178f826f8c8b26e1140c15b2beef525ffd80189ef7ee6c62b2bd86d6c3a7b; round=1; parent-spec-hash=a0a147a1a66b04bb6dfeb243bb98d63a031be2c9ee398799bfb2d64a8e4a7813; at=2026-10-04T10:06:52.927Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

<!-- auto-review: verdict=pass; hash=ee00aff377533a9c1ebb1caf11a71afe0aedaf5178b1ca6b24eccd01cb0fa836; design-hash=b8c169d6f139c8996c0659f18c4999765cba9a9e4a0778255ea932fc9316d61f; round=2; parent-spec-hash=a0a147a1a66b04bb6dfeb243bb98d63a031be2c9ee398799bfb2d64a8e4a7813; at=2026-10-04T10:31:23.212Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=25; excluded=0; at=2026-10-04T10:31:23.231Z -->
