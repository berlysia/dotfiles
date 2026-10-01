<!-- spec-ref: spec.md -->

# Plan: agent-vm の gh を repo 単位の fine-grained PAT で認証する (Execution layer)

spec.md（承認済み）の K1〜K15 を実装する。T0 は mac 実機での確認ゲートで、ユーザーが実行する。T0 に通らなければ T1 以降に進まず spec を改訂する（spec R5）。

前提:

- launcher は macOS の `/bin/bash` 3.2 で動く。`mapfile`、`declare -A`、`${var,,}` は使わない。正規表現は変数に入れて `[[ $s =~ $RE ]]` で使う。
- `x=$(f)` の中では errexit が効かないので、各ステップに `|| die` を付け、`local x=$(f)` は使わない（`executable_agent-vm:5-8`）。
- テストは `tests/agent-vm/run.sh` の既存の仕組みを使う。各 `test_*` 関数は、launcher を `AGENT_VM_LIB=1` で source した subshell の中で実行され、`TMP_ROOT`、`STUB_LOG`、`AGENT_VM_STATE_DIR`、`AGENT_VM_CONFIG_DIR` がテストごとに用意される（`run.sh` 末尾のループ）。`op`、`curl`、`open` はテストの中でシェル関数として定義して差し替える（関数は PATH 上の stub より優先される）。`jq` と `perl` は実物を使う（CI の ubuntu-latest と macos-latest に入っている）。
- 実行: `bash tests/agent-vm/run.sh`（CI と同じく macOS では `/bin/bash`）。
- 行番号は 2026-10-01 時点のもので、別の作業（shellcheck の整理）で数行ずれていることがある。関数名で場所を特定する。その作業がコミットされるまで実装を始めない（同じファイルを編集しているため）。
- テスト専用の差し替え `AGENT_VM_TTY`（入力元）と `AGENT_VM_NOW`（時計）は、テストで launcher を source したときだけ効く。`AGENT_VM_LIB=1 . launcher` の前置き代入は source が終わると消えるので、source 中に `GH_TEST_MODE=${AGENT_VM_LIB:+1}` として写しておき、それで判定する（環境から `GH_TEST_MODE` を渡されても、launcher が読み込みのたびに代入し直すので効かない）。docs には書かない。
- fd 9（ロック）: `cmd_env_gh` はロックを取らず、`notice_gh_token_expiry` が呼ばれる時点ではロックは解放済み（`prepare_machine` の末尾の `release_lock`）。spec K12 に合わせて、新しく呼ぶ長く走りうる外部コマンド（`op`、`curl`、`git`、`open`）には `9>&-` を付ける。`jq`、`perl`、`grep`、`mktemp`、`mv` は fd 9 が開いていない文脈でしか呼ばれないので付けない。
- 正規表現の範囲（`[A-Za-z]` など）を locale に左右されないよう、入口の関数（`cmd_env_gh`、`notice_gh_token_expiry`）で `local LC_ALL=C` を宣言する（bash の動的スコープで、呼び出し先の関数にも効く）。

## Files

```
# 編集
home/dot_local/bin/executable_agent-vm
tests/agent-vm/run.sh
docs/agent-vm.md
docs/decisions/0018-agent-vm-orbstack.md

# 新規作成（session の成果物を永続化する）
docs/plans/agent-vm-gh-token/research.md
docs/plans/agent-vm-gh-token/spec.md
docs/plans/agent-vm-gh-token/plan-1.md
```

## Tasks

### T0: mac 実機での確認ゲート（ユーザーが実行する）

**Files:** なし（確認だけ）

- 参照: spec.md R5、K2、K3、K5、K10

ユーザーに次を実行してもらい、結果を受け取る。`<vault>` は `Personal` と `Formal` の両方で行う。

- [ ] **Step 1: 1Password**

```bash
op item template get "API Credential" | jq '.fields[] | {id, type, label}'
op vault get Personal >/dev/null && echo ok-personal
op vault get Formal  >/dev/null && echo ok-formal
printf '%s' dummy-value | jq -Rs '{title: "agent-vm-gh gate-test", category: "API_CREDENTIAL", fields: [{id: "credential", type: "CONCEALED", label: "credential", value: .}]}' \
  | op item create --vault <vault> --format json - | jq -r .id
op read "op://<vault>/<上の id>/credential"            # dummy-value が出ること
printf 'X=op://<vault>/<上の id>/credential\n' | op inject  # X=dummy-value が出ること
op item delete <上の id> --vault <vault>
# 失敗時に値が漏れないこと: 存在しない vault に作ろうとして、stderr に dummy-value が出ないこと
printf '%s' dummy-value | jq -cRs '{title: "x", category: "API_CREDENTIAL", fields: [{id: "credential", type: "CONCEALED", label: "credential", value: .}]}' \
  | op item create --vault no-such-vault --format json - 2>&1 | grep -c dummy-value   # 0
```

期待: template の秘密のフィールドの id が `credential`。両方の vault で作成、`op read`、`op inject` が通る。id が 26 文字の小文字英数字。失敗時の出力に値が含まれない。

- [ ] **Step 2: curl と jq**

```bash
curl --version | head -1   # 7.55 以上
command -v jq
```

- [ ] **Step 3: GitHub（任意の自分の repo で 1 回）**

spec K2 の権限（contents=read、pull_requests=write、issues=write、actions=read）で、その repo だけを選んだ PAT を作成画面から手で作り、次を確かめる。

token をコマンド行に書くとシェルの履歴に残るので、非表示で読み込んでから使う。

```bash
# 中断しても GH_TOKEN がシェルに残らないよう、ここから unset までを bash の subshell（`bash` と打って入る）で行い、最後に exit する
read -rs GH_TOKEN && export GH_TOKEN   # PAT を貼り付ける（表示されず、履歴にも残らない）
gh api -i repos/<owner>/<repo> | grep -i -E '^HTTP|github-authentication-token-expiration'
# 他者（Renovate など）の open な PR がある repo なら:
gh pr merge <number> --auto --squash   # 拒否されるかどうか
gh pr view <number> --json autoMergeRequest   # 成功していたら必ず gh pr merge --disable-auto <number> で戻し、null に戻ったことを確かめる
unset GH_TOKEN
```

あわせて、同じ名前で 2 本目の PAT を作ろうとして、作成画面が拒否するかを見る。確認後、作った PAT は削除する。

判定:

- 通った場合: T1 へ進む。
- `credential` が違う場合: spec K5 と本 plan の field 名を直してから進む。
- id での参照が解決できない場合: 中止して spec を改訂する。
- auto-merge が有効にできた場合: spec K2 を改訂する（権限を減らすか、残るリスクとして書くか）。spec の hash が変わるので、本 plan も承認し直す。
- 期限ヘッダの有無と、同名 PAT の拒否の有無: 結果を `.tmp/sessions/0803a013/research.md` に追記するだけで進む（spec.md は変えない。変えると hash が変わり承認が外れる）。T6 で research.md を docs/plans へ複写するときに一緒に残る。

### T1: 純粋な補助関数（repo 名、vault、日時、URL）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`（`env_files_for` の直前、500 行付近に新しい節を足す）
- テスト: `tests/agent-vm/run.sh`（`test_no_env_files_means_no_op_call` の後に追加）
- 参照: `home/dot_local/bin/executable_agent-vm:43-49`（`derive_machine_name`。PAT 名の元）、`:83-85`（perl の利用）

- [ ] **Step 1: 失敗するテストを書く**

```bash
test_gh_repo_from_url_accepts_three_github_forms() {
  assert_eq "Owner/Repo" "$(gh_repo_from_url git@github.com:Owner/Repo.git)" "scp form with .git"
  assert_eq "Owner/Repo" "$(gh_repo_from_url ssh://git@github.com/Owner/Repo)" "ssh url"
  assert_eq "Owner/Repo" "$(gh_repo_from_url https://github.com/Owner/Repo/)" "https with trailing slash"
  assert_status 1 "other host rejected" -- gh_repo_from_url git@gitlab.com:Owner/Repo.git
  assert_status 1 "nested path rejected" -- gh_repo_from_url https://github.com/a/b/c
  assert_status 1 "dot-dot rejected" -- gh_repo_from_url https://github.com/../Repo
  assert_status 1 "control character rejected" -- gh_repo_from_url "$(printf 'https://github.com/O/R\033[2J')"
}
test_gh_same_repo_ignores_case() {
  assert_status 0 "case-insensitive match" -- gh_same_repo Owner/Repo owner/repo
  assert_status 1 "different repo" -- gh_same_repo Owner/Repo Owner/Other
}
test_gh_vault_days_maps_only_the_two_vaults() {
  assert_eq 90 "$(gh_vault_days Personal)" "Personal is 90 days"
  assert_eq 30 "$(gh_vault_days Formal)" "Formal is 30 days"
  assert_status 1 "lowercase rejected" -- gh_vault_days personal
  assert_status 1 "unknown rejected" -- gh_vault_days Shared
}
test_gh_pat_name_and_expiry_use_utc() {
  # 1767225600 = 2026-01-01T00:00:00Z
  assert_eq "repo-abc123-2601010000" "$(gh_pat_name agent-repo-abc123 1767225600)" "pat name"
  assert_eq "2026-04-01" "$(gh_utc %Y-%m-%d 1767225600 90)" "expiry after 90 days"
  local longest; longest=$(gh_pat_name agent-aaaaaaaaaaaaaaaaaaaa-abcdef 1767225600)
  if [[ ${#longest} -le 40 ]]; then record "PASS pat name fits 40 chars"; else record "FAIL pat name fits 40 chars (${#longest})"; fi
}
test_gh_template_url_fills_name_expiry_and_permissions() {
  local url; url=$(gh_template_url repo-abc123-2601010000 Owner/Repo 30)
  assert_contains "$url" "https://github.com/settings/personal-access-tokens/new?name=repo-abc123-2601010000&" "name"
  assert_contains "$url" "&expires_in=30&" "expiry"
  assert_contains "$url" "Owner%2FRepo" "description is url-encoded"
  assert_contains "$url" "contents=read&pull_requests=write&issues=write&actions=read" "permissions"
  assert_not_contains "$url" "contents=write" "no push permission"
  assert_not_contains "$url" "target_name" "no target_name"
}
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run.sh`
期待: 上の 5 テストが `FAIL ... (test aborted)` または `command not found` 由来の FAIL。他の既存テストは PASS のまま。

- [ ] **Step 3: 最小実装を書く**

```bash
# --- gh token (agent-vm env gh) ---------------------------------------------------------------
# A per-repo fine-grained PAT reaches the VM as GH_TOKEN through the repo env file (spec: docs/plans/agent-vm-gh-token).
# AGENT_VM_LIB is set only while the tests source this file (a prefix assignment to `.`); remember it so the
# test-only overrides (AGENT_VM_NOW, AGENT_VM_TTY) work in the tests and nowhere else.
GH_TEST_MODE=${AGENT_VM_LIB:+1}
# The vault decides the token's lifetime; this table is the only place that pairs them.
GH_VAULT_DAYS="Personal:90 Formal:30"
GH_WARN_DAYS=7
GH_REPO_RE='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
GH_ANY_LINE_RE='^[[:space:]]*(export[[:space:]]+)?GH_TOKEN='
GH_AUTO_LINE_RE='^GH_TOKEN=op://[A-Za-z0-9_.-]+/[a-z0-9]{26}/credential$'
GH_ITEM_ID_RE='^[a-z0-9]{26}$'
GH_PAT_RE='^github_pat_[A-Za-z0-9_]{1,250}$'
GH_PAT_NAME_RE='^[a-z0-9-]{1,40}$'
GH_DATE_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}$'

gh_vault_days() { # vault -> days; 1 when the vault is not in GH_VAULT_DAYS (case-sensitive)
  local pair
  for pair in $GH_VAULT_DAYS; do
    if [[ "${pair%%:*}" == "$1" ]]; then printf '%s\n' "${pair#*:}"; return 0; fi
  done
  return 1
}

gh_valid_repo() { # owner/repo -> 0 when safe to show and to put into an API path
  [[ "$1" =~ $GH_REPO_RE ]] || return 1
  case "${1%%/*}" in . | ..) return 1 ;; esac
  case "${1#*/}" in . | ..) return 1 ;; esac
  return 0
}

gh_lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
gh_same_repo() { [[ "$(gh_lower "$1")" == "$(gh_lower "$2")" ]]; } # GitHub names are case-insensitive

gh_repo_from_url() { # origin url -> owner/repo for the three github.com forms; 1 for anything else
  local path
  case "$1" in
    git@github.com:*) path=${1#git@github.com:} ;;
    ssh://git@github.com/*) path=${1#ssh://git@github.com/} ;;
    https://github.com/*) path=${1#https://github.com/} ;;
    *) return 1 ;;
  esac
  path=${path%/}
  path=${path%.git}
  gh_valid_repo "$path" || return 1
  printf '%s\n' "$path"
}

gh_now() { # epoch seconds; AGENT_VM_NOW fixes the clock, only when sourced for tests
  if [[ -n "$GH_TEST_MODE" && -n "${AGENT_VM_NOW:-}" ]]; then printf '%s\n' "$AGENT_VM_NOW"; else date +%s; fi
}
gh_utc() { # strftime_format epoch [days_to_add] -> UTC time (macOS date has no GNU -d)
  perl -MPOSIX -e 'print strftime($ARGV[0], gmtime($ARGV[1] + 86400 * $ARGV[2])), "\n"' "$1" "$2" "${3:-0}"
}
gh_pat_name() { # machine epoch -> <base>-<hash>-<YYMMDDHHMM>, at most 38 characters
  local stamp
  stamp=$(gh_utc %y%m%d%H%M "$2") || return 1
  printf '%s-%s\n' "${1#agent-}" "$stamp"
}

gh_template_url() { # pat_name owner/repo days -> creation page with name, expiry and permissions filled in
  perl -e '
    sub enc { my $s = shift; $s =~ s/([^A-Za-z0-9_.~-])/sprintf("%%%02X", ord $1)/ge; $s }
    my ($name, $repo, $days) = @ARGV;
    my $desc = "agent-vm GH_TOKEN for $repo. Select only this repository and keep the expiration.";
    printf "https://github.com/settings/personal-access-tokens/new?name=%s&description=%s&expires_in=%d"
      . "&contents=read&pull_requests=write&issues=write&actions=read\n", enc($name), enc($desc), $days;
  ' "$1" "$2" "$3"
}
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run.sh`
期待: 全テスト PASS（`N run, 0 failed`）。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): add helpers for repo names, vault lifetimes and the PAT template url"
```

### T2: 状態ファイルと env ファイルの読み書き

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`（T1 の節に続けて）
- テスト: `tests/agent-vm/run.sh`
- 参照: `home/dot_local/bin/executable_agent-vm:59-66`（`read_meta_field`。key=value の読み方の前例）、`:780-786`（env ファイルを umask 077 で作る前例）、spec K8、K9

- [ ] **Step 1: 失敗するテストを書く**

```bash
gh_put_state() { # machine content: write a state file fixture
  mkdir -p "$AGENT_VM_CONFIG_DIR/repos"; printf '%b' "$2" >"$AGENT_VM_CONFIG_DIR/repos/$1.gh"
}
gh_bytes() { cat "$1"; printf x; } # file content with its trailing newlines kept (strip the x after $(...))
gh_mode() { perl -e 'printf "%o", (stat $ARGV[0])[2] & 0777' "$1"; }
GH_NEW_LINE=GH_TOKEN=op://Formal/zyxwvutsrqponmlkjihgfedcba/credential
test_gh_read_state_classifies_absent_ok_broken() {
  gh_read_state agent-s-000000; assert_eq absent "$GH_STATE" "absent"
  gh_put_state agent-s-000000 'v=1\r\nrepo=Owner/Repo\nvault=Formal\npat_name=s-000000-2601010000\nexpires=2026-01-31\nrepo=Evil/Other\nextra=x\n'
  gh_read_state agent-s-000000
  assert_eq ok "$GH_STATE" "ok with CRLF, duplicate and unknown keys"
  assert_eq "Owner/Repo" "$GH_STATE_REPO" "first repo wins"
  assert_eq "Formal" "$GH_STATE_VAULT" "vault"
  assert_eq "2026-01-31" "$GH_STATE_EXPIRES" "expires"
  gh_put_state agent-s-000000 'v=1\nrepo=Owner/Repo\nvault=Formal\npat_name=s-000000-2601010000\n'
  gh_read_state agent-s-000000; assert_eq broken "$GH_STATE" "missing key is broken"
  gh_put_state agent-s-000000 'v=1\nrepo=Owner/Repo\nvault=personal\npat_name=s\nexpires=2026-01-31\n'
  gh_read_state agent-s-000000; assert_eq broken "$GH_STATE" "bad vault is broken"
  gh_put_state agent-s-000000 'v=2\nrepo=Owner/Repo\nvault=Formal\npat_name=s\nexpires=2026-01-31\n'
  gh_read_state agent-s-000000; assert_eq broken "$GH_STATE" "unknown version is broken"
  local bad
  for bad in 'repo=a/b/c' 'repo=../x' 'pat_name=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 'expires=2026-1-1' 'vault=Formal ' 'v='; do
    gh_put_state agent-s-000000 "$bad\nv=1\nrepo=Owner/Repo\nvault=Formal\npat_name=s\nexpires=2026-01-31\n"
    gh_read_state agent-s-000000
    if [[ "$bad" == 'vault=Formal ' ]]; then assert_eq ok "$GH_STATE" "trailing space trimmed ($bad)"
    else assert_eq broken "$GH_STATE" "first value wins and is checked ($bad)"; fi
  done
  gh_put_state agent-s-000000 ''
  gh_read_state agent-s-000000; assert_eq broken "$GH_STATE" "empty file is broken"
  gh_put_state agent-s-000000 '  v=1  \nnoequals\nrepo=Owner/Repo\nvault=Formal\npat_name=s\nexpires=2026-01-31'
  gh_read_state agent-s-000000; assert_eq ok "$GH_STATE" "padded lines, a line without =, no final newline"
}
test_gh_write_state_roundtrips_with_mode_600() {
  gh_write_state agent-w-000000 Owner/Repo Personal w-000000-2601010000 2026-04-01
  gh_read_state agent-w-000000
  assert_eq "ok Owner/Repo Personal w-000000-2601010000 2026-04-01" \
    "$GH_STATE $GH_STATE_REPO $GH_STATE_VAULT $GH_STATE_PAT_NAME $GH_STATE_EXPIRES" "roundtrip"
  assert_eq 600 "$(gh_mode "$AGENT_VM_CONFIG_DIR/repos/agent-w-000000.gh")" "mode 600"
  assert_eq "" "$(find "$AGENT_VM_CONFIG_DIR/repos" -name '*.tmp.*')" "no temp file left"
  printf 'extra=1\n' >>"$AGENT_VM_CONFIG_DIR/repos/agent-w-000000.gh"
  gh_write_state agent-w-000000 Owner/Repo Formal w-000000-2601020000 2026-02-01
  assert_not_contains "$(cat "$AGENT_VM_CONFIG_DIR/repos/agent-w-000000.gh")" "extra=1" "unknown keys dropped on rewrite"
}
test_gh_scan_env_classifies_lines() {
  local f="$TMP_ROOT/e.env"
  gh_scan_env "$f"; assert_eq none "$GH_ENV" "missing file"
  printf 'A=op://v/a/x\n' >"$f"; gh_scan_env "$f"; assert_eq none "$GH_ENV" "no GH_TOKEN"
  printf 'A=1\nGH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxyz/credential\n' >"$f"; gh_scan_env "$f"
  assert_eq "auto Formal abcdefghijklmnopqrstuvwxyz" "$GH_ENV $GH_ENV_VAULT $GH_ENV_ID" "auto line parsed"
  printf 'export GH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxyz/credential\n' >"$f"; gh_scan_env "$f"
  assert_eq manual "$GH_ENV" "export is manual"
  printf 'GH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxyz/credential\nGH_TOKEN=x\n' >"$f"; gh_scan_env "$f"
  assert_eq manual "$GH_ENV" "two lines are manual"
  printf 'GH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxyz/credential\r\n' >"$f"; gh_scan_env "$f"
  assert_eq crlf "$GH_ENV" "CRLF detected before the format check"
  local line
  for line in '  GH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxyz/credential' \
    'GH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxy/credential' 'GH_TOKEN=op://Formal/ABCDEFGHIJKLMNOPQRSTUVWXYZ/credential' \
    'GH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxyz/credential ' 'GH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxyz/password'; do
    printf '%s\n' "$line" >"$f"; gh_scan_env "$f"; assert_eq manual "$GH_ENV" "not the auto form: '$line'"
  done
  printf '# GH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxyz/credential\nGH_TOKEN_X=1\nA=1\r\n' >"$f"; gh_scan_env "$f"
  assert_eq none "$GH_ENV" "comment, GH_TOKEN_X and a CR on another line are not GH_TOKEN lines"
  mkdir -p "$TMP_ROOT/dir.env"; gh_scan_env "$TMP_ROOT/dir.env"
  assert_eq unreadable "$GH_ENV" "a directory is not an env file"
  if [[ "$(id -u)" -ne 0 ]]; then
    chmod 000 "$f"; gh_scan_env "$f"; chmod 600 "$f"
    assert_eq unreadable "$GH_ENV" "unreadable file is not 'none'"
  fi
}
test_gh_rewrite_env_replaces_in_place_or_appends() {
  local f="$TMP_ROOT/r.env"
  printf 'A=op://v/a/x\r\nGH_TOKEN=op://Personal/abcdefghijklmnopqrstuvwxyz/credential\n# note\n' >"$f"; chmod 644 "$f"
  gh_rewrite_env "$f" "$GH_NEW_LINE"
  assert_eq "$(printf 'A=op://v/a/x\r\n%s\n# note\nx' "$GH_NEW_LINE")" "$(gh_bytes "$f")" "replaced in place, other bytes kept"
  assert_eq 600 "$(gh_mode "$f")" "rewritten file is 600"
  printf 'A=1' >"$f"
  gh_rewrite_env "$f" "$GH_NEW_LINE"
  assert_eq "$(printf 'A=1\n%s\nx' "$GH_NEW_LINE")" "$(gh_bytes "$f")" "newline added before appending, appended line ends with a newline"
  printf 'GH_TOKEN=old' >"$f"
  gh_rewrite_env "$f" "$GH_NEW_LINE"
  assert_eq "$(printf '%sx' "$GH_NEW_LINE")" "$(gh_bytes "$f")" "last line without newline stays without newline"
  printf '\tGH_TOKEN=old\n' >"$f"
  gh_rewrite_env "$f" "$GH_NEW_LINE"
  assert_eq "$(printf '%s\nx' "$GH_NEW_LINE")" "$(gh_bytes "$f")" "leading whitespace matches the scan's definition"
  gh_rewrite_env "$TMP_ROOT/new/n.env" "$GH_NEW_LINE"
  assert_eq 600 "$(gh_mode "$TMP_ROOT/new/n.env")" "new file is 600"
}
test_gh_rewrite_env_leaves_the_file_alone_on_failure() {
  if [[ "$(id -u)" -eq 0 ]]; then record "PASS unreadable env file kept (skipped: running as root)"; return 0; fi
  local f="$TMP_ROOT/u.env" status=0
  printf 'A=1\nB=2\n' >"$f"; chmod 000 "$f"
  gh_rewrite_env "$f" "$GH_NEW_LINE" 2>/dev/null || status=$?
  chmod 600 "$f"
  assert_eq 1 "$status" "unreadable file is an error"
  assert_eq "$(printf 'A=1\nB=2\nx')" "$(gh_bytes "$f")" "content untouched"
  assert_eq "" "$(find "$TMP_ROOT" -maxdepth 1 -name '*.tmp.*')" "no temp file left"
}
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run.sh`
期待: 上の 5 テストが FAIL。他は PASS。

- [ ] **Step 3: 最小実装を書く**

```bash
gh_state_path() { printf '%s/repos/%s.gh\n' "$AGENT_VM_CONFIG_DIR" "$1"; }
gh_env_path() { printf '%s/repos/%s.env.1password\n' "$AGENT_VM_CONFIG_DIR" "$1"; }

gh_trim() { # string -> without surrounding whitespace and a trailing CR
  local s=${1%$'\r'}
  s=${s#"${s%%[![:space:]]*}"}
  printf '%s' "${s%"${s##*[![:space:]]}"}"
}

gh_read_state() { # machine -> GH_STATE=absent|ok|broken and GH_STATE_{REPO,VAULT,PAT_NAME,EXPIRES}
  # Plain key=value lines; never sourced. The first occurrence of a key wins; unknown keys are ignored.
  local f line key v="" repo="" vault="" pat="" exp="" seen=" "
  f=$(gh_state_path "$1")
  GH_STATE=absent GH_STATE_REPO="" GH_STATE_VAULT="" GH_STATE_PAT_NAME="" GH_STATE_EXPIRES=""
  if [[ ! -f "$f" ]]; then return 0; fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=$(gh_trim "$line")
    case "$line" in *=*) ;; *) continue ;; esac
    key=${line%%=*}
    case "$seen" in *" $key "*) continue ;; esac
    seen="$seen$key "
    case "$key" in
      v) v=${line#*=} ;; repo) repo=${line#*=} ;; vault) vault=${line#*=} ;;
      pat_name) pat=${line#*=} ;; expires) exp=${line#*=} ;;
    esac
  done <"$f"
  GH_STATE=broken
  if [[ "$v" != 1 ]] || ! gh_valid_repo "$repo" || ! gh_vault_days "$vault" >/dev/null; then return 0; fi
  if ! [[ "$pat" =~ $GH_PAT_NAME_RE && "$exp" =~ $GH_DATE_RE ]]; then return 0; fi
  GH_STATE=ok GH_STATE_REPO=$repo GH_STATE_VAULT=$vault GH_STATE_PAT_NAME=$pat GH_STATE_EXPIRES=$exp
}

gh_write_atomic() { # target command...: the command's stdout -> a same-directory temp file (mode 600) -> mv
  # The command runs to completion before mv, so a failing producer leaves the target untouched; readers see
  # the old or the new content, never a partial one. Runs in the caller's shell: it sets and then clears the
  # INT/TERM trap, so callers must not rely on a trap of their own across this call (cmd_env_gh sets none).
  local target=$1 dir tmp
  shift
  dir=$(dirname "$target")
  mkdir -p "$dir" || return 1
  tmp=$(umask 077 && mktemp "$dir/.$(basename "$target").tmp.XXXXXX") || return 1
  # shellcheck disable=SC2064 # expand now: remove this call's temp file if the user interrupts
  trap "rm -f '$tmp'; exit 130" INT TERM
  if "$@" >"$tmp" && mv "$tmp" "$target"; then trap - INT TERM; return 0; fi
  rm -f "$tmp"
  trap - INT TERM
  return 1
}

gh_state_lines() { # owner/repo vault pat_name expires -> the state file content
  printf 'v=1\nrepo=%s\nvault=%s\npat_name=%s\nexpires=%s\n' "$1" "$2" "$3" "$4"
}
gh_write_state() { # machine owner/repo vault pat_name expires
  gh_write_atomic "$(gh_state_path "$1")" gh_state_lines "$2" "$3" "$4" "$5"
}

gh_scan_env() { # env file -> GH_ENV=none|auto|manual|crlf|unreadable, and GH_ENV_VAULT / GH_ENV_ID for an auto line
  # An auto line is the exact form agent-vm env gh writes; anything else is the user's and is never rewritten.
  local line count=0 matched=""
  GH_ENV=none GH_ENV_VAULT="" GH_ENV_ID=""
  if [[ ! -e "$1" ]]; then return 0; fi
  # Unreadable (or not a regular file) must not look like "no GH_TOKEN line": env gh would then go on and fail
  # only after the user created a PAT.
  if [[ ! -f "$1" || ! -r "$1" ]]; then GH_ENV=unreadable; return 0; fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ $GH_ANY_LINE_RE ]] || continue
    case "$line" in *$'\r'*) GH_ENV=crlf; return 0 ;; esac
    count=$((count + 1))
    matched=$line
  done <"$1"
  if [[ "$count" -eq 0 ]]; then return 0; fi
  if [[ "$count" -eq 1 && "$matched" =~ $GH_AUTO_LINE_RE ]]; then
    matched=${matched#GH_TOKEN=op://}
    GH_ENV=auto GH_ENV_VAULT=${matched%%/*}
    matched=${matched#*/}
    GH_ENV_ID=${matched%%/*}
  else
    GH_ENV=manual
  fi
}

gh_env_content() { # env file, new GH_TOKEN line -> the rewritten content on stdout; fails if the file is unreadable
  # Leading whitespace is [^\S\n] to match the [[:space:]] of GH_ANY_LINE_RE, so scan and rewrite agree on
  # which line is the GH_TOKEN line. Only the first one is replaced; gh_scan_env refuses files with two.
  perl -e '
    my ($f, $new) = @ARGV; my $c = "";
    if (-e $f) { -f $f or exit 1; open(my $h, "<", $f) or exit 1; local $/; $c = <$h>; close $h }
    my $done = 0;
    $c =~ s{^[^\S\n]*(?:export[^\S\n]+)?GH_TOKEN=[^\n]*}{$done = 1; $new}me;
    if (!$done) { $c .= "\n" if length($c) && substr($c, -1) ne "\n"; $c .= "$new\n" }
    print $c;
  ' "$1" "$2"
}
gh_rewrite_env() { # env file, new GH_TOKEN line: replace the GH_TOKEN line where it is, or append; keep other bytes
  gh_write_atomic "$1" gh_env_content "$1" "$2"
}
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run.sh`
期待: 全テスト PASS。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): read and write the gh state file and the GH_TOKEN env line"
```

### T3: 起動時の期限の警告

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`（`notice_orphan_env` の後に関数を足し、`run_tool` の `notice_orphan_env "$MACHINE"` の次の行で呼ぶ）
- テスト: `tests/agent-vm/run.sh`
- 参照: `home/dot_local/bin/executable_agent-vm:737-744`（`notice_orphan_env` は常に 0 を返す）、`:641-643`（呼び出し位置）、spec K11

- [ ] **Step 1: 失敗するテストを書く**

```bash
gh_put_auto_env() { # machine vault: write an env file with an auto GH_TOKEN line
  mkdir -p "$AGENT_VM_CONFIG_DIR/repos"
  printf 'GH_TOKEN=op://%s/abcdefghijklmnopqrstuvwxyz/credential\n' "$2" >"$AGENT_VM_CONFIG_DIR/repos/$1.env.1password"
}
test_gh_notice_only_when_near_expiry_or_unknown() {
  export AGENT_VM_NOW=1767225600 # 2026-01-01
  local m=agent-n-000000 out
  gh_put_auto_env "$m" Formal
  gh_put_state "$m" 'v=1\nrepo=O/R\nvault=Formal\npat_name=n-000000-2512010000\nexpires=2026-03-01\n'
  assert_eq "" "$(notice_gh_token_expiry "$m" 2>&1)" "far expiry is silent"
  gh_put_state "$m" 'v=1\nrepo=O/R\nvault=Formal\npat_name=n-000000-2512010000\nexpires=2026-01-08\n'
  assert_contains "$(notice_gh_token_expiry "$m" 2>&1)" "expires on 2026-01-08; renew with: agent-vm env gh" "within 7 days"
  gh_put_state "$m" 'v=1\nrepo=O/R\nvault=Formal\npat_name=n-000000-2512010000\nexpires=2025-12-31\n'
  assert_contains "$(notice_gh_token_expiry "$m" 2>&1)" "expired on 2025-12-31" "expired"
  rm -f "$AGENT_VM_CONFIG_DIR/repos/$m.gh"
  assert_contains "$(notice_gh_token_expiry "$m" 2>&1)" "expiry for this repo is unknown" "auto line without state"
  printf 'export GH_TOKEN=x\n' >"$AGENT_VM_CONFIG_DIR/repos/$m.env.1password"
  assert_eq "" "$(notice_gh_token_expiry "$m" 2>&1)" "hand-written line is silent"
  printf 'GH_TOKEN=op://v/i/f\n' >"$AGENT_VM_CONFIG_DIR/env.1password"
  assert_contains "$(notice_gh_token_expiry "$m" 2>&1)" "every machine gets the same token" "global GH_TOKEN warned"
  assert_status 0 "never fails" -- notice_gh_token_expiry "$m"
}
test_gh_notice_survives_a_broken_state_file() {
  local m=agent-b-000000
  gh_put_auto_env "$m" Personal
  gh_put_state "$m" 'garbage\n'
  assert_contains "$(notice_gh_token_expiry "$m" 2>&1)" "is broken" "broken state reported"
  assert_status 0 "launch not blocked" -- notice_gh_token_expiry "$m"
}
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run.sh`
期待: 上の 2 テストが FAIL。

- [ ] **Step 3: 最小実装を書く**

```bash
notice_gh_token_expiry() { # machine: speak only when the token is near or past expiry, or its expiry is unknown
  local m=$1 today soon LC_ALL=C
  if grep -Eq "$GH_ANY_LINE_RE" "$AGENT_VM_CONFIG_DIR/env.1password" 2>/dev/null; then
    step "GH_TOKEN is set in env.1password, so every machine gets the same token; move it to this repo with: agent-vm env gh"
  fi
  gh_scan_env "$(gh_env_path "$m")"
  if [[ "$GH_ENV" != auto ]]; then return 0; fi
  gh_read_state "$m"
  if [[ "$GH_STATE" != ok ]]; then
    step "GH_TOKEN expiry for this repo is unknown ($(gh_state_path "$m") is $GH_STATE); re-register with: agent-vm env gh"
    return 0
  fi
  today=$(gh_utc %Y-%m-%d "$(gh_now)") || return 0
  soon=$(gh_utc %Y-%m-%d "$(gh_now)" "$GH_WARN_DAYS") || return 0
  if [[ "$GH_STATE_EXPIRES" < "$today" ]]; then
    step "GH_TOKEN for this repo expired on $GH_STATE_EXPIRES; renew with: agent-vm env gh"
  elif ! [[ "$GH_STATE_EXPIRES" > "$soon" ]]; then
    step "GH_TOKEN for this repo expires on $GH_STATE_EXPIRES; renew with: agent-vm env gh"
  fi
  return 0
}
```

`run_tool` の `notice_orphan_env "$MACHINE"` の次の行に `notice_gh_token_expiry "$MACHINE"` を足す。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run.sh`
期待: 全テスト PASS（既存の run_tool 系のテストも PASS のまま）。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): warn at launch when the repo's GH_TOKEN is near expiry"
```

### T4: `agent-vm env gh` 本体

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`（T3 の関数の後に `cmd_env_gh` と補助関数、`main` の `env` の振り分けに `gh`、`show_help` に 1 行）
- テスト: `tests/agent-vm/run.sh`
- 参照: `home/dot_local/bin/executable_agent-vm:35-41`（hardened な git 呼び出し）、`:517`（`</dev/null 9>&-`）、`:689-695`（`env` の振り分け）、`tests/agent-vm/run.sh:289-294`（秘密が argv に出ない検査）、spec Architecture 手順 0〜11、K4〜K13

- [ ] **Step 1: 失敗するテストを書く**

```bash
gh_fixture_repo() { # origin_url -> a git repo with that origin
  local repo="$TMP_ROOT/ghrepo"
  mkdir -p "$repo" && git -C "$repo" init -q
  if [[ -n "${1:-}" ]]; then git -C "$repo" remote add origin "$1"; fi
  printf '%s\n' "$repo"
}
gh_fake_tools() { # replace op / curl / open with recording functions
  # GH_TEST_OP_FAIL_ON: op fails when its arguments contain this text. LEAK: a token reached a child's environment.
  op() {
    printf 'op %s\n' "$*" >>"$STUB_LOG"
    if [[ -n "$(printenv GH_PAT 2>/dev/null)" ]]; then printf 'LEAK GH_PAT exported to op\n' >>"$STUB_LOG"; fi
    if [[ -n "${GH_TEST_OP_FAIL_ON:-}" && "$*" == *"$GH_TEST_OP_FAIL_ON"* ]]; then cat >/dev/null; return 1; fi
    case "$1 $2" in
      "item create") cat >>"$STUB_LOG.stdin"; printf '{"id":"%s"}\n' "${GH_TEST_ID:-zyxwvutsrqponmlkjihgfedcba}" ;;
      "read "*) printf 'secret-from-op\n' ;;
      "whoami --format") printf '{"url":"https://my.example.1password.com"}\n' ;;
    esac
  }
  curl() {
    printf 'curl %s\n' "$*" >>"$STUB_LOG"
    if [[ -n "$(printenv GH_PAT 2>/dev/null)" ]]; then printf 'LEAK GH_PAT exported to curl\n' >>"$STUB_LOG"; fi
    cat >>"$STUB_LOG.stdin"; printf '%s' "${GH_TEST_HTTP:-200}"
  }
  open() { printf 'open %s\n' "$*" >>"$STUB_LOG"; }
}
gh_tty() { printf '%b' "$1" >"$TMP_ROOT/tty"; export AGENT_VM_TTY="$TMP_ROOT/tty"; }
gh_assert_no_token_at_rest() { # token string: nowhere on disk except the stub's stdin capture
  assert_eq "" "$(grep -rlF "$1" "$AGENT_VM_CONFIG_DIR" "$AGENT_VM_STATE_DIR" "$TMP_ROOT" 2>/dev/null | grep -v '/stub\.log\.stdin$' | grep -v '/tty$' || true)" "token not written to disk"
}
GH_TEST_PAT=github_pat_ABCdef123_secretTail
test_env_gh_first_registration_writes_env_and_state() {
  export AGENT_VM_NOW=1767225600
  local repo m out; repo=$(gh_fixture_repo git@github.com:Owner/Repo.git); m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  gh_fake_tools; gh_tty "Owner/Repo\nFormal\n$GH_TEST_PAT\n"
  export GH_PAT=preexisting-exported-value # a user environment that already exports the name must not leak the token
  out=$(cd "$repo" && cmd_env_gh 2>&1)
  assert_not_contains "$(cat "$STUB_LOG")" "LEAK" "token not exported to children"
  assert_contains "$(cat "$STUB_LOG")" "curl -q " "curl ignores ~/.curlrc"
  assert_contains "$(cat "$STUB_LOG")" "-H @-" "header read from stdin"
  gh_assert_no_token_at_rest "$GH_TEST_PAT"
  assert_contains "$out" "expires_in=30" "Formal gives 30 days"
  assert_eq "GH_TOKEN=op://Formal/zyxwvutsrqponmlkjihgfedcba/credential" "$(cat "$AGENT_VM_CONFIG_DIR/repos/$m.env.1password")" "env line"
  gh_read_state "$m"
  assert_eq "ok Owner/Repo Formal 2026-01-31" "$GH_STATE $GH_STATE_REPO $GH_STATE_VAULT $GH_STATE_EXPIRES" "state"
  assert_not_contains "$(cat "$STUB_LOG")" "$GH_TEST_PAT" "token never in argv"
  assert_contains "$(cat "$STUB_LOG.stdin")" "Authorization: Bearer $GH_TEST_PAT" "token reaches curl on stdin"
  assert_contains "$(cat "$STUB_LOG.stdin")" "\"value\":\"$GH_TEST_PAT\"" "token reaches op on stdin"
  assert_not_contains "$out" "$GH_TEST_PAT" "token never printed"
  assert_contains "$(cat "$STUB_LOG")" "op vault get Formal" "vault checked"
  assert_contains "$out" "vault Formal of 1Password account https://my.example.1password.com" "account shown before the PAT is created"
  assert_contains "$(cat "$STUB_LOG")" "op read op://Formal/zyxwvutsrqponmlkjihgfedcba/credential" "reference read back"
}
test_env_gh_renewal_prints_cleanup_and_keeps_vault() {
  export AGENT_VM_NOW=1767225600
  local repo m out; repo=$(gh_fixture_repo https://github.com/Owner/Repo); m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  gh_put_auto_env "$m" Personal
  gh_put_state "$m" "v=1\nrepo=Owner/Repo\nvault=Personal\npat_name=${m#agent-}-2510010000\nexpires=2026-01-03\n"
  gh_fake_tools; gh_tty "$GH_TEST_PAT\n"
  out=$(cd "$repo" && cmd_env_gh 2>&1)
  assert_contains "$out" "expires_in=90" "Personal kept, 90 days"
  assert_contains "$out" "${m#agent-}-2510010000" "old PAT name shown"
  assert_contains "$out" "op item delete --archive abcdefghijklmnopqrstuvwxyz --vault Personal" "old item archive command"
  assert_contains "$out" "agent-vm-gh " "title check advised"
  assert_contains "$out" "pat_name=${m#agent-}-2601010000" "state lines shown before writing"
}
test_env_gh_refuses_before_any_pat_is_created() {
  local repo m; repo=$(gh_fixture_repo git@github.com:Owner/Repo.git); m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  gh_fake_tools
  # recorded repo differs from origin
  gh_put_state "$m" "v=1\nrepo=Owner/Other\nvault=Personal\npat_name=x-1\nexpires=2026-01-03\n"; gh_tty "$GH_TEST_PAT\n"
  local status=0; (cd "$repo" && cmd_env_gh) >/dev/null 2>&1 || status=$?
  assert_eq 1 "$status" "origin mismatch dies"
  assert_not_contains "$(cat "$STUB_LOG")" "item create" "nothing saved on origin mismatch"
  rm -f "$AGENT_VM_CONFIG_DIR/repos/$m.gh"
  # hand-written GH_TOKEN line
  mkdir -p "$AGENT_VM_CONFIG_DIR/repos"; printf 'export GH_TOKEN=abc\n' >"$AGENT_VM_CONFIG_DIR/repos/$m.env.1password"
  gh_tty "Owner/Repo\nPersonal\n$GH_TEST_PAT\n"
  local out; out=$(cd "$repo" && (cmd_env_gh) 2>&1) || true
  assert_contains "$out" "agent-vm env edit" "manual line explained"
  assert_not_contains "$out" "personal-access-tokens/new" "no creation page opened"
  assert_not_contains "$(cat "$STUB_LOG")" "item create" "nothing saved"
}
test_env_gh_vault_mismatch_needs_explicit_vault() {
  local repo m out; repo=$(gh_fixture_repo git@github.com:Owner/Repo.git); m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  gh_put_auto_env "$m" Formal
  gh_put_state "$m" "v=1\nrepo=Owner/Repo\nvault=Personal\npat_name=x-1\nexpires=2026-01-03\n"
  gh_fake_tools; gh_tty "$GH_TEST_PAT\n"
  out=$(cd "$repo" && (cmd_env_gh) 2>&1) || true
  assert_contains "$out" "--vault" "asks for --vault"
  assert_not_contains "$(cat "$STUB_LOG")" "item create" "nothing saved"
}
test_env_gh_repo_change_does_not_inherit_vault() {
  export AGENT_VM_NOW=1767225600
  local repo m out; repo=$(gh_fixture_repo git@github.com:New/Name.git); m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  gh_put_state "$m" "v=1\nrepo=Old/Name\nvault=Personal\npat_name=x-1\nexpires=2026-01-03\n"
  gh_fake_tools; gh_tty "New/Name\nFormal\n$GH_TEST_PAT\n"
  out=$(cd "$repo" && cmd_env_gh --repo New/Name 2>&1)
  assert_contains "$out" "Old/Name" "previous repo shown"
  assert_contains "$out" "expires_in=30" "vault chosen again, not inherited"
}
test_env_gh_rejects_bad_token_and_failed_check() {
  local repo out; repo=$(gh_fixture_repo git@github.com:Owner/Repo.git)
  gh_fake_tools
  gh_tty "Owner/Repo\nPersonal\nghp_classicToken\n"
  out=$(cd "$repo" && (cmd_env_gh) 2>&1) || true
  assert_contains "$out" "github_pat_" "classic token rejected"
  assert_not_contains "$out" "ghp_classicToken" "rejected input not echoed"
  assert_not_contains "$(cat "$STUB_LOG")" "curl" "no request with a bad token"
  : >"$STUB_LOG"
  gh_tty "Owner/Repo\nPersonal\n$GH_TEST_PAT\n"
  out=$(cd "$repo" && (GH_TEST_HTTP=404 cmd_env_gh) 2>&1) || true
  assert_contains "$out" "HTTP 404" "status shown"
  assert_contains "$out" "delete the PAT named" "created PAT mentioned"
  assert_not_contains "$out" "$GH_TEST_PAT" "token not printed on failure"
  assert_not_contains "$(cat "$STUB_LOG")" "item create" "nothing saved after a failed check"
  gh_assert_no_token_at_rest "$GH_TEST_PAT"
}
test_env_gh_refuses_other_unsafe_starts() {
  local repo m out; repo=$(gh_fixture_repo git@github.com:Owner/Repo.git); m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  gh_fake_tools; mkdir -p "$AGENT_VM_CONFIG_DIR/repos"
  printf 'GH_TOKEN=op://v/i/f\n' >"$AGENT_VM_CONFIG_DIR/env.1password"; gh_tty "Owner/Repo\nPersonal\n$GH_TEST_PAT\n"
  out=$(cd "$repo" && (cmd_env_gh) 2>&1) || true
  assert_contains "$out" "env.1password sets GH_TOKEN" "global GH_TOKEN refused"
  rm -f "$AGENT_VM_CONFIG_DIR/env.1password"
  printf 'GH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxyz/credential\r\n' >"$AGENT_VM_CONFIG_DIR/repos/$m.env.1password"
  out=$(cd "$repo" && (cmd_env_gh) 2>&1) || true
  assert_contains "$out" "CRLF" "CRLF refused"
  rm -f "$AGENT_VM_CONFIG_DIR/repos/$m.env.1password"
  gh_put_state "$m" 'garbage\n'
  out=$(cd "$repo" && (cmd_env_gh) 2>&1) || true
  assert_contains "$out" "is broken" "broken state refused"
  export AGENT_VM_NOW=1767225600
  gh_put_state "$m" "v=1\nrepo=Owner/Repo\nvault=Personal\npat_name=${m#agent-}-2601010000\nexpires=2026-01-03\n"; gh_tty "$GH_TEST_PAT\n"
  out=$(cd "$repo" && (cmd_env_gh) 2>&1) || true
  assert_contains "$out" "wait a minute" "same-minute PAT name refused"
  rm -f "$AGENT_VM_CONFIG_DIR/repos/$m.gh"; gh_tty "Owner/Repo\nPersonal\n$GH_TEST_PAT\n"
  out=$(cd "$repo" && (GH_TEST_OP_FAIL_ON="vault get" cmd_env_gh) 2>&1) || true
  assert_contains "$out" "vault Personal is not available" "missing vault refused"
  assert_not_contains "$out" "personal-access-tokens/new" "before the creation page"
  git -C "$repo" remote remove origin
  gh_put_state "$m" "v=1\nrepo=Owner/Repo\nvault=Personal\npat_name=x-1\nexpires=2026-01-03\n"; gh_tty "$GH_TEST_PAT\n"
  out=$(cd "$repo" && (cmd_env_gh) 2>&1) || true
  assert_contains "$out" "origin cannot be parsed" "unparseable origin refused when a repo is recorded"
  assert_not_contains "$(cat "$STUB_LOG")" "item create" "nothing saved in any of these cases"
}
test_env_gh_failures_after_the_pat_name_what_to_delete() {
  export AGENT_VM_NOW=1767225600
  local repo m out; repo=$(gh_fixture_repo git@github.com:Owner/Repo.git); m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  gh_fake_tools; gh_tty "Owner/Repo\nFormal\n$GH_TEST_PAT\n"
  out=$(cd "$repo" && (GH_TEST_OP_FAIL_ON="read op://" cmd_env_gh) 2>&1) || true
  assert_contains "$out" "zyxwvutsrqponmlkjihgfedcba in vault Formal" "new item's id and vault shown"
  assert_contains "$out" "${m#agent-}-2601010000" "PAT name shown"
  assert_status 1 "env not written" -- test -e "$AGENT_VM_CONFIG_DIR/repos/$m.env.1password"
  : >"$STUB_LOG"; gh_tty "Owner/Repo\nFormal\n$GH_TEST_PAT\n"
  out=$(cd "$repo" && (GH_TEST_ID=short cmd_env_gh) 2>&1) || true
  assert_contains "$out" "agent-vm-gh ${m#agent-}-2601010000" "item title to look for"
}
test_env_gh_vault_switch_and_same_repo_update() {
  export AGENT_VM_NOW=1767225600
  local repo m out; repo=$(gh_fixture_repo git@github.com:Owner/Repo.git); m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  gh_put_auto_env "$m" Formal
  gh_put_state "$m" "v=1\nrepo=Owner/Repo\nvault=Formal\npat_name=x-1\nexpires=2026-01-03\n"
  gh_fake_tools; gh_tty "$GH_TEST_PAT\n"
  out=$(cd "$repo" && GH_TEST_OP_FAIL_ON=whoami cmd_env_gh --vault Personal 2>&1)
  assert_contains "$out" "of 1Password account (unknown)" "a failing op whoami does not stop the command"
  assert_contains "$out" "from vault Formal to Personal; the new token expires in 90 days" "switch shown with the new lifetime"
  assert_contains "$out" "--vault Formal" "old item archived from the old vault"
  gh_put_auto_env "$m" Personal
  gh_put_state "$m" "v=1\nrepo=Owner/Repo\nvault=Personal\npat_name=x-1\nexpires=2026-01-03\n"
  gh_tty "owner/repo\n$GH_TEST_PAT\n"
  out=$(cd "$repo" && cmd_env_gh --repo owner/repo 2>&1)
  assert_not_contains "$out" "vault for this repo's token" "same repo (case-insensitive) is an update: vault not asked again"
  assert_contains "$out" "expires_in=90" "recorded vault kept"
}
test_env_gh_state_write_failure_prints_lines_to_write() {
  export AGENT_VM_NOW=1767225600
  local repo out; repo=$(gh_fixture_repo git@github.com:Owner/Repo.git)
  gh_fake_tools; gh_write_state() { return 1; }
  gh_tty "Owner/Repo\nPersonal\n$GH_TEST_PAT\n"
  out=$(cd "$repo" && (cmd_env_gh) 2>&1) || true
  assert_contains "$out" "expires=2026-04-01" "lines shown"
  assert_contains "$out" "do not re-run" "told not to re-run"
  assert_not_contains "$out" "$GH_TEST_PAT" "token not printed on failure"
}
test_main_dispatches_env_gh() {
  cmd_env_gh() { echo "env-gh $*"; }
  assert_eq "env-gh --vault Formal" "$(main env gh --vault Formal)" "env gh"
}
```

die は `exit` するので、die を期待する呼び出しはすべて `( ... )` の subshell で実行する（テストの環境では `AGENT_VM_LIB=1` のため ERR trap は張られていない）。tty の代わりのファイルは fd 3 で 1 回だけ開くので、repo 名、vault、token の順に 1 行ずつ読まれる（`$(gh_ask ...)` の subshell も同じ open file description を共有する）。

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run.sh`
期待: 上の 11 テストが FAIL。

T4 は大きいので、Step 1〜4 を次の 3 グループに分けて Red→Green を繰り返す（コミットは T4 の最後に 1 回）。

1. 入口の検査と repo / vault の決定: `test_env_gh_refuses_before_any_pat_is_created`、`test_env_gh_refuses_other_unsafe_starts`、`test_env_gh_vault_mismatch_needs_explicit_vault`、`test_env_gh_repo_change_does_not_inherit_vault`、`test_main_dispatches_env_gh`。実装は `gh_origin_repo`、`gh_ask`、`gh_decide_repo`、`gh_decide_vault`、`cmd_env_gh` の手順 0〜3 と、`main` / `show_help`。
2. token と外部呼び出し: `test_env_gh_rejects_bad_token_and_failed_check`、`test_env_gh_failures_after_the_pat_name_what_to_delete`。実装は `gh_abort`、`gh_read_token`、`gh_check_token`、`gh_create_item`、手順 4〜8。
3. 書き込みと片付け: `test_env_gh_first_registration_writes_env_and_state`、`test_env_gh_renewal_prints_cleanup_and_keeps_vault`、`test_env_gh_vault_switch_and_same_repo_update`、`test_env_gh_state_write_failure_prints_lines_to_write`。実装は `gh_print_cleanup`、手順 9〜11。

- [ ] **Step 3: 最小実装を書く**

```bash
gh_origin_repo() { # repo_root -> owner/repo from origin; empty when absent or not a github.com URL
  local url
  # Same hardening as resolve_repo_root: .git/config is writable from the VM.
  url=$(git -C "$1" -c core.fsmonitor= -c core.hooksPath=/dev/null --no-optional-locks remote get-url origin 2>/dev/null </dev/null 9>&- 3<&-) || return 0
  gh_repo_from_url "$url" || true
}

gh_ask() { # prompt -> one trimmed line from fd 3 (the tty opened by cmd_env_gh)
  local answer
  printf 'agent-vm: %s ' "$1" >&2
  IFS= read -r answer <&3 || die "could not read the answer"
  gh_trim "$answer"
}

gh_abort() { # message: a PAT may already exist on GitHub from here on
  die "$1; delete the PAT named $GH_PENDING_PAT at https://github.com/settings/personal-access-tokens if you generated it"
}

gh_decide_repo() { # repo_root arg_repo -> sets GH_REPO and GH_REPO_CHANGED (1 when not the recorded repo)
  local origin answer
  origin=$(gh_origin_repo "$1")
  if [[ -n "$2" ]] && ! gh_valid_repo "$2"; then die "--repo must be OWNER/REPO"; fi
  if [[ "$GH_STATE" == ok && -z "$2" ]]; then
    if [[ -z "$origin" ]]; then
      die "origin cannot be parsed; this repo is recorded as $GH_STATE_REPO. If it moved, fix origin on the host (git remote set-url origin ...) and run: agent-vm env gh --repo OWNER/REPO"
    fi
    if ! gh_same_repo "$origin" "$GH_STATE_REPO"; then
      die "origin points to $origin but this repo is recorded as $GH_STATE_REPO. If that is intended, fix origin on the host and run: agent-vm env gh --repo OWNER/REPO"
    fi
    GH_REPO=$GH_STATE_REPO GH_REPO_CHANGED=0
    return 0
  fi
  if [[ "$GH_STATE" == ok ]] && gh_same_repo "$2" "$GH_STATE_REPO"; then GH_REPO_CHANGED=0; else GH_REPO_CHANGED=1; fi
  if [[ "$GH_STATE" == ok && "$GH_REPO_CHANGED" == 1 ]]; then step "this repo was recorded as $GH_STATE_REPO"; fi
  step "origin can be rewritten from inside the VM; type the name you checked on the host"
  answer=$(gh_ask "GitHub repository for this machine (OWNER/REPO):")
  gh_valid_repo "$answer" || die "not an OWNER/REPO name"
  if [[ -n "$2" ]] && ! gh_same_repo "$answer" "$2"; then die "the typed name does not match --repo"; fi
  if [[ -n "$origin" ]] && ! gh_same_repo "$answer" "$origin"; then die "the typed name does not match origin ($origin)"; fi
  GH_REPO=$answer
}

gh_decide_vault() { # arg_vault -> sets GH_VAULT (needs GH_STATE, GH_ENV, GH_REPO_CHANGED)
  local answer
  if [[ -n "$1" ]]; then
    GH_VAULT=$1
  elif [[ "$GH_STATE" == ok && "$GH_REPO_CHANGED" == 0 ]]; then
    if [[ "$GH_ENV" == auto && "$GH_ENV_VAULT" != "$GH_STATE_VAULT" ]]; then
      die "the env file uses vault $GH_ENV_VAULT but the state file says $GH_STATE_VAULT; pass --vault Personal or --vault Formal"
    fi
    GH_VAULT=$GH_STATE_VAULT
  else
    if [[ "$GH_ENV" == auto ]]; then step "the current token is in vault $GH_ENV_VAULT"; fi
    answer=$(gh_ask "vault for this repo's token (Personal: 90 days / Formal: 30 days):")
    GH_VAULT=$answer
  fi
  gh_vault_days "$GH_VAULT" >/dev/null || die "vault must be Personal or Formal (case-sensitive)"
  if [[ "$GH_ENV" == auto && "$GH_ENV_VAULT" != "$GH_VAULT" ]]; then
    step "the token moves from vault $GH_ENV_VAULT to $GH_VAULT; the new token expires in $(gh_vault_days "$GH_VAULT") days"
  fi
}

gh_read_token() { # -> GH_PAT (not exported), read hidden from fd 3, trimmed and validated
  local raw
  printf 'agent-vm: paste the generated token (input is hidden): ' >&2
  IFS= read -rs raw <&3 || gh_abort "could not read the token"
  printf '\n' >&2
  raw=$(gh_trim "$raw")
  [[ "$raw" =~ $GH_PAT_RE ]] || gh_abort "the input is not a fine-grained token (github_pat_...); nothing was saved"
  GH_PAT=$raw
}

gh_check_token() { # owner/repo: the token in GH_PAT must see the repository before anything is saved
  local code
  code=$(printf 'Authorization: Bearer %s\n' "$GH_PAT" |
    curl -q -sS --max-time 15 -o /dev/null -w '%{http_code}' -H @- "https://api.github.com/repos/$1" 9>&-) || code=000
  # -q must come first: it stops curl from reading ~/.curlrc, where verbose/trace settings would print the header.
  case "$code" in
    200) return 0 ;;
    000) gh_abort "could not reach GitHub (HTTP 000); nothing was saved" ;;
    401) gh_abort "GitHub rejected the token (HTTP 401: invalid or expired); nothing was saved" ;;
    403 | 404) gh_abort "the token cannot see $1 (HTTP $code); check that only this repository was selected; nothing was saved" ;;
    *) gh_abort "unexpected HTTP $code from GitHub; nothing was saved" ;;
  esac
}

gh_create_item() { # vault title -> item id; the token travels from GH_PAT through stdin only
  local id
  id=$(printf '%s' "$GH_PAT" |
    jq -cRs --arg title "$2" '{title: $title, category: "API_CREDENTIAL",
      fields: [{id: "credential", type: "CONCEALED", label: "credential", value: .}]}' |
    op item create --vault "$1" --format json - 9>&- | jq -r .id) || return 1
  [[ "$id" =~ $GH_ITEM_ID_RE ]] || return 1
  printf '%s\n' "$id"
}

gh_print_cleanup() { # machine old_pat_name new_lines: what the user still has to do by hand
  local env_files id_hits=""
  step "clean up the previous token by hand:"
  if [[ -n "$2" ]]; then
    step "  - delete the PAT named $2 at https://github.com/settings/personal-access-tokens"
  fi
  if [[ "$GH_ENV" == auto ]]; then
    step "  - archive the previous 1Password item after checking its title starts with 'agent-vm-gh ':"
    step "    op item delete --archive $GH_ENV_ID --vault $GH_ENV_VAULT"
    env_files="$AGENT_VM_CONFIG_DIR/env.1password $(gh_env_path "$1")"
    # shellcheck disable=SC2086 # two fixed paths, split on purpose
    id_hits=$(grep -l -F "$GH_ENV_ID" $env_files 2>/dev/null || true)
    if [[ -n "$id_hits" ]]; then
      step "    first remove the lines that still mention it (op inject would fail at launch): $id_hits"
    fi
  fi
  step "the state file $(gh_state_path "$1") is written next with these lines;"
  step "if that fails or is interrupted, do not re-run: write them into the file by hand"
  printf '%s\n' "$3" >&2
}

cmd_env_gh() { # [--repo OWNER/REPO] [--vault Personal|Formal]
  # The token lives only in GH_PAT, a function-local, never-exported variable: drop any exported GH_PAT the
  # user's environment brought, so op / jq / curl never inherit it. LC_ALL=C keeps [A-Za-z] ranges ASCII.
  { set +x; } 2>/dev/null # xtrace would print the expanded Authorization header
  unset GH_PAT
  local GH_PAT="" LC_ALL=C
  local arg_repo="" arg_vault="" root m tty tool days now pat_name expires url id ref lines old_pat="" account
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo) [[ $# -ge 2 ]] || die "--repo needs OWNER/REPO"; arg_repo=$2; shift 2 ;;
      --vault) [[ $# -ge 2 ]] || die "--vault needs Personal or Formal"; arg_vault=$2; shift 2 ;;
      *) die "usage: agent-vm env gh [--repo OWNER/REPO] [--vault Personal|Formal]" ;;
    esac
  done
  for tool in op jq curl perl; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required for agent-vm env gh"
  done
  root=$(resolve_repo_root)
  m=$(derive_machine_name "$root")
  # 0. state, 1. env files: refuse before any PAT exists
  gh_read_state "$m"
  if [[ "$GH_STATE" == broken ]]; then
    die "the state file $(gh_state_path "$m") is broken; delete it and re-run (you will type the repo and choose the vault again)"
  fi
  if grep -Eq "$GH_ANY_LINE_RE" "$AGENT_VM_CONFIG_DIR/env.1password" 2>/dev/null; then
    die "env.1password sets GH_TOKEN for every machine; remove that line first"
  fi
  gh_scan_env "$(gh_env_path "$m")"
  case "$GH_ENV" in
    crlf) die "$(gh_env_path "$m") has CRLF line endings around GH_TOKEN; convert it to LF first" ;;
    unreadable) die "$(gh_env_path "$m") cannot be read; fix its permissions first" ;;
    manual) die "a hand-written GH_TOKEN line exists; remove it with agent-vm env edit, then re-run" ;;
  esac
  tty=/dev/tty
  if [[ -n "$GH_TEST_MODE" && -n "${AGENT_VM_TTY:-}" ]]; then tty=$AGENT_VM_TTY; fi # test-only input file
  if ! (: <"$tty") 2>/dev/null; then die "cannot open $tty for input"; fi
  exec 3<"$tty"
  # 2. repo, 2b. vault and lifetime
  gh_decide_repo "$root" "$arg_repo"
  gh_decide_vault "$arg_vault"
  days=$(gh_vault_days "$GH_VAULT") || die "unknown vault"
  op vault get "$GH_VAULT" >/dev/null </dev/null 9>&- 3<&- || die "1Password vault $GH_VAULT is not available"
  # op uses its default account, as inject_secrets does; show which one before the user creates a PAT, so a
  # default that moved to another account (with a vault of the same name) does not store the token there silently.
  account=$(op whoami --format json </dev/null 9>&- 3<&- | jq -r '.url // empty') || account=""
  step "the token will be saved in vault $GH_VAULT of 1Password account ${account:-(unknown)}"
  # 3. names and dates, computed once
  now=$(gh_now)
  pat_name=$(gh_pat_name "$m" "$now") || die "could not compute the PAT name"
  if [[ "$GH_STATE" == ok ]]; then old_pat=$GH_STATE_PAT_NAME; fi
  if [[ "$pat_name" == "$old_pat" ]]; then die "a PAT named $pat_name was registered this minute; wait a minute and re-run"; fi
  expires=$(gh_utc %Y-%m-%d "$now" "$days") || die "could not compute the expiry date"
  # 4. creation page
  url=$(gh_template_url "$pat_name" "$GH_REPO" "$days") || die "could not build the creation URL"
  step "create the token at: $url"
  step "select only $GH_REPO under Repository access (for an organization repository choose it as the resource owner), keep the expiration, then Generate"
  if [[ "$(uname -s)" == Darwin ]] && command -v open >/dev/null 2>&1; then open "$url" </dev/null 9>&- 3<&- || true; fi
  GH_PENDING_PAT=$pat_name
  # 5. token, 6. check
  gh_read_token
  exec 3<&-
  gh_check_token "$GH_REPO"
  # 7. item, 8. read back
  id=$(gh_create_item "$GH_VAULT" "agent-vm-gh $pat_name") ||
    gh_abort "could not create the 1Password item or read its id; if an item titled 'agent-vm-gh $pat_name' exists in vault $GH_VAULT, delete it"
  GH_PAT=""
  ref="op://$GH_VAULT/$id/credential"
  op read "$ref" >/dev/null </dev/null 9>&- || gh_abort "the new item $id in vault $GH_VAULT cannot be read back; delete it"
  # 9. env
  gh_rewrite_env "$(gh_env_path "$m")" "GH_TOKEN=$ref" ||
    gh_abort "could not update $(gh_env_path "$m"); delete the new item $id in vault $GH_VAULT"
  # 10. cleanup and the state lines, before writing the state
  lines=$(gh_state_lines "$GH_REPO" "$GH_VAULT" "$pat_name" "$expires")
  gh_print_cleanup "$m" "$old_pat" "$lines"
  # 11. state
  gh_write_state "$m" "$GH_REPO" "$GH_VAULT" "$pat_name" "$expires" ||
    die "could not write $(gh_state_path "$m"); GH_TOKEN is already registered, so do not re-run: write the lines above into it by hand"
  step "registered GH_TOKEN for $GH_REPO (vault $GH_VAULT, expires $expires)"
}
```

`main` の `env` の振り分けに `gh) shift 2; cmd_env_gh "$@" ;;` を足す。`show_help` の `agent-vm env adopt` の行の次に `  agent-vm env gh [--repo R] [--vault V]  Register or renew this repo's GH_TOKEN (fine-grained PAT)` を足す。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run.sh`、続けて `shellcheck home/dot_local/bin/executable_agent-vm`
期待: 全テスト PASS。shellcheck は、既存と同じ種類の style 警告（SC2250 など、`~/.shellcheckrc` の enable=all 由来）以外を新しく出さない。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): add env gh to register and renew a per-repo fine-grained PAT"
```

### T5: `env adopt` が状態ファイルも移す

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm` の `cmd_env_adopt`
- テスト: `tests/agent-vm/run.sh`
- 参照: spec K14、既存の `test_*adopt*` テスト（`grep -n adopt tests/agent-vm/run.sh`）

- [ ] **Step 1: 失敗するテストを書く**

```bash
test_env_adopt_moves_the_gh_state_file() {
  local repo new; repo=$(make_flow_repo); new=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  write_machine_meta agent-gone-000000 "$TMP_ROOT/does-not-exist"
  mkdir -p "$AGENT_VM_CONFIG_DIR/repos"
  : >"$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.env.1password"
  : >"$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.gh"
  (cd "$repo" && cmd_env_adopt agent-gone-000000) 2>/dev/null
  assert_status 0 "state moved" -- test -f "$AGENT_VM_CONFIG_DIR/repos/$new.gh"
  assert_status 1 "old state gone" -- test -e "$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.gh"
}
test_env_adopt_refuses_when_a_gh_state_file_is_in_the_way() {
  local repo new out; repo=$(make_flow_repo); new=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  write_machine_meta agent-gone-000000 "$TMP_ROOT/does-not-exist"
  mkdir -p "$AGENT_VM_CONFIG_DIR/repos"
  : >"$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.env.1password"
  : >"$AGENT_VM_CONFIG_DIR/repos/$new.gh"
  out=$(cd "$repo" && (cmd_env_adopt agent-gone-000000) 2>&1) || true
  assert_contains "$out" "$new.gh" "path named"
  assert_status 0 "env file not moved" -- test -f "$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.env.1password"
}
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run.sh`
期待: 上の 2 テストが FAIL。

- [ ] **Step 3: 最小実装を書く**

`cmd_env_adopt` を次にする（既存の 3 行目までは変えない）。

```bash
cmd_env_adopt() { # old_machine
  local old=$1 new
  [[ -n "$old" ]] || die "usage: agent-vm env adopt <machine>"
  orphaned_env_machines | grep -qx "$old" || die "$old is not an orphaned env file (its repo still exists or it has no env file)"
  new=$(derive_machine_name "$(resolve_repo_root)")
  [[ ! -e "$AGENT_VM_CONFIG_DIR/repos/$new.env.1password" ]] || die "this repo already has an env file"
  # Checked before anything moves, so a refusal leaves both machines as they were.
  [[ ! -e "$(gh_state_path "$new")" ]] || die "this repo already has a gh state file ($(gh_state_path "$new")); if it is left over, delete it and retry"
  mv "$AGENT_VM_CONFIG_DIR/repos/$old.env.1password" "$AGENT_VM_CONFIG_DIR/repos/$new.env.1password"
  if [[ -f "$(gh_state_path "$old")" ]]; then mv "$(gh_state_path "$old")" "$(gh_state_path "$new")"; fi
  step "adopted env file of $old for $new"
}
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run.sh`
期待: 全テスト PASS。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): move the gh state file along with env adopt"
```

### T6: docs と ADR、成果物の永続化

**Files:**

- 編集: `docs/agent-vm.md`（「4. 秘密の渡し方」の末尾に小節を足す）
- 編集: `docs/decisions/0018-agent-vm-orbstack.md`（`## Amended by` に 1 行）
- 新規作成: `docs/plans/agent-vm-gh-token/{research,spec,plan-1}.md`（`.tmp/sessions/0803a013/` から複写）
- 参照: spec K15、`docs/decisions/0018-agent-vm-orbstack.md:73-76`

- [ ] **Step 1: `docs/agent-vm.md` に「### gh の token」を足す**

spec K15 の docs 項目をすべて書く（使い方、初回の repo 名の入力と vault の選択、期限 Personal 90 日 / Formal 30 日、`--vault` と `--repo`、vault を読める人は token も読めること、失効手順と状態ファイルが無いときの手掛かり、更新後の片付けと見逃したときの探し方（adopt 前の machine 名も）、同時に実行しないこと、`GH_TOKEN` は VM の全プロセスから読めること、`agent-vm rm` は PAT・item・状態ファイルを消さないこと、状態ファイルだけが残ったら手で消してよいこと、archive した item にも token が残ること、public repo の選び忘れと全 repo を対象にした token は検証で止められないこと、`gh pr merge` は host で行うこと、`op` は既定のアカウントを使い、保存先のアカウントが PAT を作る前に表示されること、`OP_ACCOUNT` と `OP_SERVICE_ACCOUNT_TOKEN` が設定されていない前提であること）。

- [ ] **Step 2: ADR-0018 の Amended by に 1 行足す**

```markdown
- `docs/plans/agent-vm-gh-token/spec.md` (2026-10-01) — gh の token は K7（全 VM 共通の長期 token は注入しない）の例外として、repo ごとの fine-grained PAT を tool の起動時に `GH_TOKEN` で注入する。token は repo ごとに分かれ、権限は pull_requests / issues の write と contents / actions の read に絞る。残るリスクは、VM の中の agent が期限（Personal 90 日、Formal 30 日）まで token を読めることである。R21 は bootstrap の話なので変わらない
```

- [ ] **Step 3: 成果物を複写する**

```bash
mkdir -p docs/plans/agent-vm-gh-token
cp .tmp/sessions/0803a013/research.md .tmp/sessions/0803a013/spec.md .tmp/sessions/0803a013/plan-1.md docs/plans/agent-vm-gh-token/
```

- [ ] **Step 4: 確認**

実行: `bash tests/agent-vm/run.sh && bash tests/agent-vm/run-bootstrap.sh && bash tests/agent-vm/run-templates.sh && bash tests/agent-vm/run-shell.sh`
期待: すべて `0 failed`。`git ls-files docs/plans/agent-vm-gh-token` は未追跡（add 前）、`git status` に 3 ファイルと docs 2 ファイルが出る。

- [ ] **Step 5: コミット**

```bash
git add docs/agent-vm.md docs/decisions/0018-agent-vm-orbstack.md docs/plans/agent-vm-gh-token
git commit -m "docs(agent-vm): document env gh and record the GH_TOKEN exception to ADR-0018 K7"
```

## ISO 25010 具体テストケース

### セキュリティ（機密性・完全性）

- **入力**: tty に `github_pat_ABCdef123_secretTail` を与えて `cmd_env_gh` を最後まで実行 → **期待**: `$STUB_LOG`（全 argv）に `github_pat_ABCdef123_secretTail` が 0 回、`$STUB_LOG.stdin` に `Authorization: Bearer github_pat_ABCdef123_secretTail` と `"value":"github_pat_ABCdef123_secretTail"` が 1 回ずつ、標準エラー出力に 0 回（T4 `test_env_gh_first_registration_writes_env_and_state`）。
- **入力**: 状態ファイルの repo が `Owner/Other`、origin が `git@github.com:Owner/Repo.git` → **期待**: 終了コード 1、`op item create` が呼ばれない（T4 `test_env_gh_refuses_before_any_pat_is_created`）。
- **入力**: origin が `https://github.com/O/R` に ESC を含む値 → **期待**: `gh_repo_from_url` が 1 を返し、値は表示されない（T1）。
- **入力**: template URL → **期待**: `contents=write` と `target_name` を含まない（T1）。
- **入力**: 環境に `GH_PAT=preexisting-exported-value` を export した状態で `cmd_env_gh` → **期待**: op / curl の子プロセスの環境に `GH_PAT` が無い（`$STUB_LOG` に `LEAK` が 0 回）。curl の argv に `-q` と `-H @-` がある（T4）。
- **入力**: 登録成功、`ghp_` の拒否、HTTP 404、状態ファイルの書き込み失敗の各経路 → **期待**: 出力に token が 0 回。`$AGENT_VM_CONFIG_DIR`、`$AGENT_VM_STATE_DIR`、`$TMP_ROOT` の下で token を含むファイルは stub の stdin 記録と tty の代わりのファイルだけ（T4）。

### 機能適合性（機能正確性）

- **入力**: `A=op://v/a/x\r` / auto 行 / `# note` の 3 行のファイル（mode 644）を書き換え → **期待**: 1 行目（CR 付き）と 3 行目はバイト単位で同じ、2 行目だけ新しい参照、mode 600（T2）。
- **入力**: 改行で終わらない `A=1` → **期待**: `A=1\nGH_TOKEN=...\n` になる。改行で終わらない `GH_TOKEN=old` → 置き換え後も改行で終わらない（T2、末尾までバイト比較）。
- **入力**: 読めない env ファイル（mode 000）→ **期待**: 失敗を返し、内容はそのまま、一時ファイルは残らない（T2）。
- **入力**: env.1password に GH_TOKEN / CRLF の GH_TOKEN 行 / 壊れた状態ファイル / 同じ分の PAT 名 / 使えない vault / 解析できない origin → **期待**: いずれも作成画面を出す前に die し、item は作られない（T4）。
- **入力**: 参照の読み戻しの失敗 → **期待**: 新しい item の id と vault、PAT の名前が表示され、env ファイルは作られない（T4）。
- **入力**: `--vault Personal`（env の行は Formal）→ **期待**: `from vault Formal to Personal; the new token expires in 90 days`、archive コマンドは `--vault Formal`。`--repo owner/repo`（記録は Owner/Repo）→ vault は聞き直さない（T4）。
- **入力**: `export GH_TOKEN=...` / GH_TOKEN 2 行 / CRLF → **期待**: それぞれ `manual` / `manual` / `crlf`（T2）。
- **入力**: 状態ファイルに CRLF、重複 key、未知 key → **期待**: `ok`、最初の repo を採用（T2）。key の欠落、`vault=personal`、`v=2` → **期待**: `broken`（T2）。
- **入力**: 手順 11 の書き込みを失敗させる → **期待**: `expires=2026-04-01` を含む 5 行と `do not re-run` が表示される（T4）。
- **入力**: `--repo New/Name`（記録は `Old/Name`、vault は Personal）→ **期待**: vault を聞き直し、`Formal` を入力すると `expires_in=30`（T4）。
- **入力**: env の vault が Formal、状態ファイルの vault が Personal、`--vault` 無し → **期待**: `--vault` を求めて die、item は作られない（T4）。
- **入力**: adopt の移動先に `.gh` がある → **期待**: die し、env ファイルも動かない（T5）。

### 使用性（運用性）

- **入力**: 今日 2026-01-01、expires 2026-03-01 → **期待**: 出力なし。2026-01-08 → `expires on 2026-01-08`。2025-12-31 → `expired on 2025-12-31`（T3）。
- **入力**: auto 行があり状態ファイルが無い / 壊れている → **期待**: 「unknown」/「broken」を含む 1 行、終了コード 0（T3）。
- **入力**: 手書きの GH_TOKEN 行 → **期待**: 出力なし（T3）。
- **入力**: env.1password に GH_TOKEN → **期待**: 全 machine に同じ token が入る旨の警告（T3）。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘: scratchpad で実装とテストを組み込んで実行した結果、263 件中 1 件だけ失敗した。原因は gh_abort の文言がテストの期待（"delete the PAT named"）と一致しないこと。perl が失敗しても env ファイルが空になる経路がある。失敗系のテストが薄い。

### scope-justification-reviewer
- verdict: needs-work（軽微）
- 主指摘: T0 の結果を spec に記録すると hash が変わり、承認が外れる（research.md に記録する）。T4 の失敗系のテストが足りない。T4 の粒度が大きい。

### architecture-boundary-analyzer
- verdict: needs-work（軽微）
- 主指摘: テストが期待する文言と実装の文言が一致しない。jq と perl に `9>&-` が無い（K12 との差）。fd 3 が op vault get と open に引き継がれる。AGENT_VM_NOW がテスト専用であることが書かれていない。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: T0 で PAT がシェルの履歴に残る。環境に export された GH_PAT を引き継ぐと、token が子プロセスに渡る。失敗経路と永続ディスクに token が出ないことを検査していない。curl が ~/.curlrc を読む（-q を付ける）。テスト用の差し替えが本番でも効く。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: perl 側が失敗しても mv が先に済み、env ファイルが壊れる。perl と bash で行頭の空白の範囲が違う。末尾改行をバイト単位で検査していない。状態ファイルと env の境界のテストが足りない。gh_write_atomic が呼び出し元の trap を上書きする。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: needs-work
- 主指摘: 実行すると 308 件中 33 件が失敗した。`AGENT_VM_LIB=1 . launcher` の前置き代入は source が終わると消えるので、テストを実行する時点では AGENT_VM_LIB が空になり、AGENT_VM_TTY と AGENT_VM_NOW が効かない。source 中に GH_TEST_MODE へ写す形にすると 308 件すべてが通る。

### scope-justification-reviewer
- verdict: pass
- 主指摘: 手順 9 の失敗と、--repo と入力の不一致を検査するテストが無い（許容範囲）。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: gh_origin_repo の git にも `3<&-` を付けてそろえる。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: `unset GH_PAT; local GH_PAT=""` で、export された値が子プロセスに渡らないことを bash 5.2 で実測した。軽微な点として、bash -x で起動されると xtrace に token が出る（set +x を入れる）。T0 で中断すると GH_TOKEN がシェルに残る。

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: 読めない env ファイルを gh_scan_env が none と判定しうる。gh_env_content の `-e` を `-f` にする。symlink の env ファイルは mv で通常ファイルに置き換わる。

<!-- auto-review: verdict=needs-work; hash=047e7ce28f8067e512876a0eaa6aeffd99adf06be083514fd29d694fa17ab75b; design-hash=c5b4a63767da1c4265481e4417111a62d17a5db26a72abefb10076ecd3d1c4b2; round=1; parent-spec-hash=9c0471ab752d7d9cc4ec8e9947ca9bc01c511ecee015b07d33662d0dc750c17c; at=2026-10-01T12:00:27.838Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=22; excluded=0; at=2026-10-01T12:00:27.854Z -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: needs-work（軽微）
- 主指摘: 組み込んで実行すると 310 件すべて通った。launcher に新しい shellcheck 警告は無い。テストの `ls | grep` 2 か所が SC2010 を新しく出す（find に置き換える）。

### scope-justification-reviewer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=7bd44b9df3896fbda19a3492b67a0e403f2118bb24c69e03f3edfc8cdf60360c; design-hash=81c4ace49d0f1eee99a061c35b5cda2859ab0e739d90f27ef81e5e0401082245; round=2; parent-spec-hash=9c0471ab752d7d9cc4ec8e9947ca9bc01c511ecee015b07d33662d0dc750c17c; at=2026-10-01T12:05:30.780Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=9; excluded=0; at=2026-10-01T12:05:30.797Z -->

## Reviewer Outputs (Round 4)

### logic-validator
- verdict: pass
- 主指摘: 組み込み直して実行し、310 件すべて通った。SC2010 は消えた。報告にあった SC1090 と SC2034 は、rc なしで実行したことによる見かけのもの。いまの run.sh も rc なしでは同じ 2 種類を出し、repo の .shellcheckrc（disable=SC1090、disable=SC2034）が両方を無効化している（メインループで確認した）。

### scope-justification-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=3838c65a2b9b301926f327c6a3c7b92b40e0fea822517269132e88567459a318; design-hash=5fbd04f04a1d7398c3f0925209a35300d5211967ee739b81cf34627e6871c805; round=3; parent-spec-hash=9c0471ab752d7d9cc4ec8e9947ca9bc01c511ecee015b07d33662d0dc750c17c; at=2026-10-01T12:08:36.092Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=1; excluded=0; at=2026-10-01T12:08:36.110Z -->

## Reviewer Outputs (Round 5)

T0 の結果（vault 名を Personal に）と、spec Round 7 で足したアカウント表示を反映した回。

### logic-validator
- verdict: pass
- 主指摘: 現 HEAD の launcher と run.sh に組み込み、311 件すべて通過。repo の .shellcheckrc で 1 ファイルずつ検査して 0 件。op whoami が失敗しても `|| account=""` で止まらないことを再現で確認した。軽微な点として、失敗時のテストが無いことと、jq が空を返した場合も「op whoami failed」と出る文言（どちらも反映済み: 文言を (unknown) にし、vault 切り替えのテストで whoami を失敗させて検査する）。

### scope-justification-reviewer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

<!-- auto-review: verdict=pass; hash=09ae49d9d5913358d7869f60ea5e8a27eaee380ca4929d29a48be14299fb4508; design-hash=5fbd04f04a1d7398c3f0925209a35300d5211967ee739b81cf34627e6871c805; round=4; parent-spec-hash=9c0471ab752d7d9cc4ec8e9947ca9bc01c511ecee015b07d33662d0dc750c17c; at=2026-10-01T12:10:13.183Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=0; excluded=0; at=2026-10-01T12:10:13.202Z -->

<!-- auto-review: verdict=pass; hash=d132e493e1c010702640c56f2d902e6e78283191fc2a225d5720f2ca77ea9e66; design-hash=ed20368a4aca1017e4f3a8f8f6655df4f629557683eff868fc0e261eaec27c67; round=5; parent-spec-hash=0a8017ccf3268da2b2fd6edd529c4eadceab6dc8233221c28a1a3a41144d3f6b; at=2026-10-01T14:31:00.847Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=2; excluded=0; at=2026-10-01T14:31:00.865Z -->
