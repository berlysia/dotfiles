<!-- spec-ref: spec.md -->

# Plan: git-worktree-create を worktree の中から実行できるようにする (Execution layer)

spec K11（#216）。他の plan と独立。

## Files

```
# 編集
home/dot_local/bin/executable_git-worktree-create
docs/commands/git-worktree-create.md

# テスト
tests/git-worktree-cleanup/run.sh
```

## Tasks

### T1: worktree の中から create したときの失敗をテストで再現する

**Files:**

- テスト: `tests/git-worktree-cleanup/run.sh`（`test_F1` の直前に追加）
- 参照: `tests/git-worktree-cleanup/run.sh:77-81`（本物の `git-worktree-create` を呼ぶ `wt` ヘルパー）
- 参照: `tests/git-worktree-cleanup/run.sh:205-214`（`test_F1` の書き方）

- [ ] **Step 1: 失敗するテストを書く**

#216 の再現と同じく、スラッシュを含むブランチ名の worktree の中から、スラッシュを含む別のブランチ名で作る。

```bash
test_C1() {
  make_repo c1
  local outer rc=0
  outer=$(wt fix/outer)
  (cd "$outer" && bash "$CREATE" fix/inner >/dev/null 2>&1) || rc=$?
  assert_eq 0 "$rc" "C1 exit"
  assert_dir "$REPO/.git/worktree/fix/inner" "C1 created under the main .git/worktree"
  assert_no_dir "$outer/.git/worktree" "C1 nothing created inside the outer worktree"
  assert_eq "fix/inner" "$(git -C "$REPO/.git/worktree/fix/inner" branch --show-current)" "C1 branch"
}
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `/bin/bash tests/git-worktree-cleanup/run.sh C1`
期待: `FAIL C1 exit (expected: 0 / actual: 1)`、`FAIL C1 created under the main .git/worktree (missing dir: …)`、`FAIL C1 branch (expected: fix/inner / actual: )` の 3 件が出て、終了コード 1（logic-validator が scratch コピーで git 2.50.1 により実測済み）

- [ ] **Step 3: 最小実装を書く**

`home/dot_local/bin/executable_git-worktree-create:61-63` を置き換える。

```bash
# Anchor on the common git dir so that running from inside a linked worktree
# (whose .git is a file) still creates the worktree under the main
# repository's .git/worktree/.
# --path-format needs git 2.31; git-worktree-cleanup already requires 2.36.
if ! common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
    echo -e "${RED}✗ Not inside a git repository, or git is older than 2.31 (git rev-parse --path-format)${NC}"
    exit 1
fi
worktrees_dir="$common_dir/worktree"
```

help 文（45-46 行目）の `Worktrees are created in: <repo-root>/.git/worktree/<branch-name>` の次に、`  <repo-root> is the main checkout, even when run from inside a linked worktree.` を 1 行足す。

対象外: bare リポジトリと submodule。`--git-common-dir` がそれぞれ `<bare>` と `.git/modules/<name>` を返し、cleanup の `<main>/.git/worktree/` と一致しない。修正前も create は失敗していたので回帰ではない。

`repo_root` 変数は 62-63 行目でしか使っていない（`grep -n repo_root` で確認済み）ので、この置き換えで消える。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `/bin/bash tests/git-worktree-cleanup/run.sh`
期待: `C1` の 4 項目が PASS、既存テストも全件 PASS、最終行が `PASS: <N> FAIL: 0 SKIP: <M>`。`C1 nothing created inside the outer worktree` は修正前でも `$outer/.git` がファイルなので成り立ちうる。検証の主体は本体側の存在確認とブランチ確認である

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_git-worktree-create tests/git-worktree-cleanup/run.sh
git commit -m "fix(git-worktree-create): anchor on the common git dir"
```

### T2: 文書に、どの worktree から実行しても本体の下に作ることを書く

**Files:**

- 編集: `docs/commands/git-worktree-create.md`
- 参照: `docs/commands/git-worktree-create.md:52-58`（「worktreeの場所」節、`<repo-root>/.git/worktree/<branch-name>`）

- [ ] **Step 1: 記述を足す**

「worktreeの場所」節のコードブロック（57 行目）の直後に、「`<repo-root>` は本体の checkout です。linked worktree の中で実行しても、`git rev-parse --git-common-dir` で本体の `.git/worktree/` を求めてそこに作ります。」と 1 文足す。

- [ ] **Step 2: コミット**

```bash
git add docs/commands/git-worktree-create.md
git commit -m "docs(git-worktree-create): note it works from inside a worktree"
```

## ISO 25010 具体テストケース

### 機能適合性（正確性）

- **入力**: 本体 checkout で `git-worktree-create foo` → **期待**: `<repo>/.git/worktree/foo` ができる（既存の `wt` を使う全テストが従来どおり PASS）
- **入力**: `<repo>/.git/worktree/fix/outer` の中で `git-worktree-create fix/inner` → **期待**: 終了コード 0、`<repo>/.git/worktree/fix/inner` ができ、ブランチは `fix/inner`、`<outer>/.git/worktree` は存在しない

### 移植性（適応性）

- **入力**: CI の macOS / Ubuntu 行列（`.github/workflows/ci-git-worktree-cleanup.yml`）で `run.sh` を実行 → **期待**: 両方で `FAIL: 0`。`--path-format` は git 2.31 以降の機能。同じワークフローで動く cleanup が既に git 2.36 以降を要求し（`executable_git-worktree-cleanup:129-133`）CI が通っているので、ランナーの git は要件を満たす。手元は git 2.50.1
- **入力**: `--path-format` を解さない git（2.31 未満）で実行 → **期待**: 「Not inside a git repository, or git is older than 2.31」を出して終了コード 1（手動確認のみ。CI では再現しない）
- **入力**: git リポジトリの外で `git-worktree-create foo` → **期待**: 同じ文言で終了コード 1（原因の候補を両方示す）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: pass
- 主指摘: scratch コピーで T1 を再現（赤 → 緑、既存テストに回帰なし）。軽微: Step 2 の赤は 3 件（`C1 branch` も FAIL）、`C1 nothing created inside` は修正前後を区別しない（反映済み）

### scope-justification-reviewer

- verdict: pass
- 主指摘: T1・T2 とも K11 に直結し規模も釣り合う。軽微: 最終行の表記、git バージョン要件の根拠（反映済み）

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: create（common dir）と cleanup（`git worktree list` 先頭 + `/.git/worktree/`）の管理ディレクトリは通常リポジトリで一致。bare と submodule は対象外と明記（反映済み）

### data-contract-evolution-evaluator

- verdict: needs-work
- 主指摘: git 2.31 未満で `--path-format` が失敗したときの明示的な終了が無い、help 文の Location 表記が古いまま（いずれも反映済み）

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: needs-work
- 主指摘: Step 3 は `set -euo pipefail` 下で正しい。ただし git リポジトリ外でも同じ「git 2.31 以上が必要」と出て原因を取り違えさせる。両方の原因を含む文言にし、移植性テストの期待も合わせる（反映済み）

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘: Round 1 の 3 点は解消。軽微: リポジトリ外でも同じ文言になる点（反映済み）

### scope-justification-reviewer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=8c0850fe5fbd51954efa1c9dd3487d21adc3b81b383eaa8b53d7e33664c0bf7d; design-hash=f5ce557f434f57ce6bdbd89a32c1244233a6b1f7a1c8e33020edf98d661fb668; round=1; parent-spec-hash=4cee4ab13ef4a878444a81b6987973e04ea76a9c5639331cbd13104a470adb56; at=2026-10-02T05:09:09.800Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: pass
- 主指摘: 失敗メッセージとテストの期待が整合し、新たな矛盾なし。「リポジトリ外」のテスト項目が見当たらないとの注記は誤り（113 行目に存在）

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### scope-justification-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=95006321d28364200bcd96ef3722cbd96dbf07b0b7ef7e70d3c3010084f1baab; design-hash=f67bc85367cc2de9409299c364d7decefb3c6692105514d8d0ef25a0a1400c6b; round=2; parent-spec-hash=4cee4ab13ef4a878444a81b6987973e04ea76a9c5639331cbd13104a470adb56; at=2026-10-02T05:10:08.030Z; reviewers=logic-validator+data-contract-evolution-evaluator -->

<!-- auto-review: verdict=pass; hash=929698150c2470c2128fea3c6032003cfd016dc6df401861f2b9d1fdb053670b; design-hash=f67bc85367cc2de9409299c364d7decefb3c6692105514d8d0ef25a0a1400c6b; round=3; parent-spec-hash=4cee4ab13ef4a878444a81b6987973e04ea76a9c5639331cbd13104a470adb56; at=2026-10-02T05:10:48.845Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=6; excluded=0; at=2026-10-02T05:10:58.810Z -->
