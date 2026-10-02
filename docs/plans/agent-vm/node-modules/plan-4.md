<!-- spec-ref: spec.md -->

# Plan 4: 共有 mount の上で張れるようにする（plan-1 の修正: mount 先の所有者の検査をやめる）

plan-3 の T5 で V3（docs の V26）の 1 を実行したところ、ヘルパーの差し替えが実機で一度も成立していないことが分かった（research.md「V3 の中断」）。

- **原因**: OrbStack の virtiofs は、ファイルの所有者を「見ている側の実効 uid の写し」として返す。root の perl（`PRIV_PL` の `mount`）が開いた mount 先を `stat` すると、所有者は 0 になる。そのため `== SUDO_UID` の検査は必ず失敗する。
- **影響**: plan-2 のリリース（launcher が起動のたびに `sync` を呼ぶ。`run_tool` の `nm_sync "$MACHINE" "$REPO" || true`）から、この修正までの間、どの repo でも mount は張られなかった。`package.json` のある repo では、起動のたびに `agent-vm: node_modules may be shared with the host in the VM (some packages could not be mounted)` が出た。`node_modules` は以前と同じく host と共有のままだった。
  - 害は警告と、host に現れる空の `node_modules` ディレクトリ（mount 先として VM のユーザーが作ったもの。R2 と同じ）だけである。
  - 保存先（`/var/lib/agent-vm/node_modules/<key>/`）は machine ごとに作られて、空のまま残っている。修正後の最初の `sync` がそこに張る。
- **Experience Delta**: 修正前は、起動のたびに部分失敗の警告が出て、何も差し替わらなかった。修正後は、起動時の `sync` で各パッケージが VM ローカルに差し替わり、警告は出ない。

この plan はヘルパーを直し、その回帰を見張るテストを足す。直したら plan-3 の T5（V3〜V6）を、plan-3 の手順のまま再開する。

## 代替案と採用案

追加の実測（research.md「V3 の中断」の 2 つ目の表）の結論は次のとおり。virtiofs の上で `chown 1234` しても、見え方は VM のユーザーなら 501、root なら 0、実効 uid 1234 なら 1234 で、host からは 501 のまま変わらない。所有者は見ている側の写しで、ファイルの属性として観測できない。

- **(a) 検査を bash 側（VM のユーザー）に移す**: どの uid で見ても情報が無いので、移しても検査は何も弾かない。しかも、開く前の `stat` になって差し替えに弱くなる。不採用。
- **(c) root から見た所有者が 0 か uid なら通す**: virtiofs の上ではすべてが 0 に見えるので、何も弾かない。不採用。
- **(d) 実効 uid を `SUDO_UID` に切り替えてから、開いた fd を `fstat` する**: virtiofs の上では常に `SUDO_UID` が返り、何も弾かない（Round 1 の architecture と security の指摘を、実測で確かめた）。働くのは VM ローカルのファイルシステムの上だけで、本番の mount 先（repo、つねに virtiofs）には当たらない。そのうえ、euid の切り替えで process が non-dumpable になる副作用と、切り替えと復帰の失敗の扱いが増える。不採用。
- **(b) mount 先の所有者の検査をやめる（採用）**: 本番での振る舞いは (d) と同じで、コードは 1 行減る。検査の当初の意図は、root が作った `node_modules` の上に張らないことだった。しかし共有 mount（virtiofs）の上では、root が作ったものも区別できない（host からは 501 に見える）。本番の mount 先は repo で、つねに virtiofs の上にあるので、この意図は本番では実現できない。失うのは、VM ローカルのファイルシステムの上の mount 先（テストの fixture だけ）での検査である。
  - 残る柵は変えない（spec K6 の手順 2〜5）。`O_NOFOLLOW` で開く。開いた fd の実パスが期待のパスかを確かめる。fd 経由で張る。張った後に mountinfo と device:inode で確かめる。
  - 保存先の側（`data/` が VM のユーザーの所有か。VM ローカルの btrfs）の検査は残す。この検査は `mkstore` のときだけ行う。`mount` のときは再検査しないが、保存先の根と `<key>/` は root 所有なので、VM のユーザーが `data/` を差し替えることはできない（既存の振る舞いのまま）。

## Files

```
# 編集
home/dot_local/bin/executable_agent-vm-node-modules
tests/agent-vm/run-node-modules.sh
docs/decisions/0022-agent-vm-node-modules.md
```

`docs/plans/agent-vm/node-modules/` への plan-4 と、更新した research の写しは、plan-3 の T5 の写し直しで行う（T2 に書く）。

## Tasks

### T1: mount 先の所有者の検査をやめる

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm-node-modules`
  - `PRIV_PL` の `mount` の `((stat $dst)[4] // -1) == $uid or die "$target is not owned by the VM user\n";` の 1 行を消し、その位置に「完成形のコード」のコメント 2 行を置く。
  - `PRIV_PL` の前のコメント（`# re-checks the record (key = sha256(path)), the last path component (no symlink) and the target's owner.`）から、` and the target's owner` を除く。結果は `# re-checks the record (key = sha256(path)) and the last path component (no symlink).` とする。
- 編集: `tests/agent-vm/run-node-modules.sh` — 「テストのコード」のテストを、`test_stale_mount_is_restored` の後に足す。
- 編集: `docs/decisions/0022-agent-vm-node-modules.md` — Decision の「ヘルパーは権限の境界ではなく、…（K6）。」の項の最後に、次の 2 文を足す。

  ```markdown
  mount 先の所有者は確かめない。OrbStack の virtiofs は所有者を見ている側の uid の写しとして返し、ファイルの属性として観測できないためである（plan-1 では確かめていたが、root からは 0 に見えて、共有 mount の上では導入から一度も張れていなかった。plan-3 の V26 の実行中に見つかり、`docs/plans/agent-vm/node-modules/plan-4.md` で直した）。
  ```

- 参照: research.md「V3 の中断」

- [ ] **Step 1: 失敗するテストを書く** — 「テストのコード」を足す。
- [ ] **Step 2: VM で失敗を確認** — 実行（host から、background で）: `orb -m agent-chezmoi-23810b bash -lc 'cd /Users/berlysia/.local/share/chezmoi && bash tests/agent-vm/run-node-modules.sh'`。この machine では repo が virtiofs で mount されている（research の実測、Round 1 の logic-validator が `findmnt -no FSTYPE -T` で `virtiofs` を確認）。期待:
  - `FAIL a package on the shared mount is mounted` と `FAIL a nested package on the shared mount is mounted` が出る。
  - それ以外の FAIL は無い。
  - `SKIP shared-mount check` が出ていない（出ていれば赤を確かめられていないので、原因を調べて止まる）。
- [ ] **Step 3: 最小実装を書く** — 「完成形のコード」。
- [ ] **Step 4: VM で通過を確認** — Step 2 と同じコマンド。期待: FAIL が 0。`PASS a package on the shared mount is mounted` の行が 1 行あることを `grep -c` で確かめる（SKIP されていない）。
- [ ] **Step 5: macOS でも壊れていないことを確認** — `bash tests/agent-vm/run-node-modules.sh` → `skipped: needs Linux and passwordless sudo`（今までどおり）。`bash -n home/dot_local/bin/executable_agent-vm-node-modules` が成功する。
- [ ] **Step 6: コミット** — `fix(agent-vm): mount over node_modules on the shared repository`。本文に次の 4 点を書く。
  - virtiofs の所有者は見ている側の写しであること。
  - plan-1 のテストで見つからなかった理由（fixture が VM ローカル）。
  - 修正までの影響（起動のたびの部分失敗の警告。何も張られなかった）。
  - plan-3 の V26 で見つかったこと。

### T2: plan-3 の T5 を再開する

- [ ] host で `chezmoi apply` を実行する（新しいヘルパーが host の staging の元になる）。
- [ ] 試験用 repo（`.../scratchpad/nm check`）で `agent-vm prewarm` を実行する。dotfiles が変わったので、bootstrap が新しいヘルパーを machine `agent-nm-check-660f1b` に入れる。確認: `orb -m agent-nm-check-660f1b bash -lc 'grep -c "is not owned by the VM user" "$(command -v agent-vm-node-modules)"'` の出力が `0`（古い検査の文字列が消えている。`grep -c` は 0 件で終了コード 1 を返すので、終了コードではなく出力で判定する）。
- [ ] plan-3 の T5 の V3 から、手順どおりに進める。V3（docs の V26）の実機確認は必須である。virtiofs の回帰は CI で見張れず、T1 のテストも VM の中で走らせたときしか効かないため。V3 の 1 で終了コード 0 にならなければ、ヘルパーを VM で直接実行して警告を見て、ユーザーに報告して止まる。
- [ ] plan-3 の T5 の「記録と片付け」で `docs/plans/agent-vm/node-modules/` を写し直すとき、plan-4.md も足す（`cp .tmp/sessions/26759938/plan-4.md docs/plans/agent-vm/node-modules/`）。research.md の写し直しで、V1 / V2 の表の「所有者の検査が通る」の誤りと、その訂正（「V3 の中断」の節）が tracked な docs に入る。T5 のコミットの本文に、plan-1.md の写しは承認時点の版で、訂正は ADR-0022 と plan-4.md にあることを書く。古い記述は 2 か所ある。完成形のコードの所有者の検査と、「ヘルパーの契約」の「`mount` は、対象の所有者を確かめ」の文である。
- [ ] `docs/agent-vm.md` の 9 節の V2（ADR-0018 の検証項目「mount 上ファイルの所有者表示が host 側と整合する」）は変えない。VM のユーザーから見れば 501 で整合しており、V2 の主張と今回の発見は矛盾しない。

## 完成形のコード

`PRIV_PL` の `mount` で、消した検査の位置:

```perl
  # No owner check on the target: the shared repository is virtiofs, which reports the owner as whoever looks
  # (root sees 0, the VM user sees itself), so ownership there carries no information (plan-4). The fence is the
  # O_NOFOLLOW open, the fd path check above and the verification after the mount.
```

## テストのコード

`tests/agent-vm/run-node-modules.sh` の `test_stale_mount_is_restored` の後:

```bash
test_shared_mount_target_is_mounted() {
  # The repository shared with the host is virtiofs, which reports the owner as whoever looks (root sees 0).
  # Only a checkout on virtiofs, inside an agent-vm machine, shows it; CI and macOS skip this test.
  local base r
  if [[ "$(findmnt -no FSTYPE -T "${REPO_ROOT:?}" 2>/dev/null)" != virtiofs ]]; then
    record "SKIP shared-mount check (this checkout is not on virtiofs)"; return 0
  fi
  mkdir -p "$REPO_ROOT/.tmp"
  base=$(mktemp -d "$REPO_ROOT/.tmp/agent-vm-nm-test.XXXXXX"); r="$base/r"; mk_repo "$r"
  helper sync "$r" >/dev/null 2>&1 || true   # the checks below say what failed
  check_mounted "$r" "a package on the shared mount is mounted"
  check_mounted "$r/packages/a" "a nested package on the shared mount is mounted"
  sudo -n umount -l "$r/node_modules" "$r/packages/a/node_modules" "$r/packages/b/node_modules" 2>/dev/null || true
  rm -rf --one-file-system "$base"
}
```

テストの補足:

- 修正そのものを見張るテストである。fixture を repo の `.tmp/`（gitignore 済み、virtiofs）に置く。CI の ubuntu と macOS では SKIP になる。agent-vm の machine の中で走らせたときだけ効く。CI で見張れない分は、plan-3 の V26 の実機確認と併せて検証する。
- `helper sync` の失敗は `|| true` で受ける。修正前は終了コード 1 で、`set -e` のままだと `check_mounted` に届かずに `test aborted` になり、何が失敗したかが出ないため。
- 後始末は、mount を外してから `rm -rf --one-file-system` で fixture を消す。外し損ねた mount があっても、`--one-file-system` が bind mount の先（テスト用の保存先）に入らない。`teardown` も EXIT で `agent-vm-test` の行をすべて外す（既存）。fixture は、途中で abort したときだけ `.tmp/agent-vm-nm-test.*` に残る（gitignore 済みで、手で消せる）。
- `mk_repo` は fixture の中で `git init` する。repo の `.tmp/` の中に入れ子の git repo ができるが、`.tmp/` は無視されている。
- `packages/a` と `packages/b` は `mk_repo` が作る構成のとおりである。
- 所有者の検査をやめたことを固定するテスト（root 所有の `node_modules` にも張る）は足さない。柵として意味の無い挙動を、契約として固定しないためである。
- 既存のテストの fixture（`mktemp -d`、VM の `/tmp`）は VM ローカルである（Round 1 の実測で tmpfs。CI の ubuntu では runner のディスク）。所有者は実際の値が見えるので、既存のテストは修正の前後で同じ結果になる。

## ISO 25010 具体テストケース

### 機能適合性（機能正確性）

- **入力**: virtiofs の上の repo（root から見ると所有者 0）で `sync` → **期待**: ルートと入れ子のパッケージに張られる（`test_shared_mount_target_is_mounted`）。実機では、plan-3 の V26（V3 の 1）が終了コード 0 になる（T2）。

### セキュリティ（完全性）

- **入力**: 既存の柵のテスト（symlink の `node_modules`、repo 外の worktree、制御文字、記録の不整合）→ **期待**: すべて PASS のまま（T1 Step 2、Step 4）。所有者の検査をやめても、spec K6 の手順 2〜5 の検査は残る。

### 互換性（共存性）

- **入力**: 既存の `run-node-modules.sh` のテスト（VM、CI の ubuntu）→ **期待**: FAIL が 0 のまま。終了コード、レコード、警告の文面は変わらない（Round 1 の data-contract の確認）。

### 対象外

- 性能効率性: `stat` が 1 回減るだけである。
- 使用性: 警告の文面は変えない。修正後は、部分失敗の警告が出なくなる（Experience Delta）。

## Round 1 からの変更

- 採用案を (d) から (b) に変えた。追加の実測（virtiofs の上で `chown` しても、所有者は見ている側の写し）で、(d) は本番の mount 先で何も弾かないと分かったため（architecture、security）。euid を切り替える `owner_as_user` は足さない。
- root 所有の `node_modules` を拒否するテストを外した。(b) では拒否しないため。
- 共有 mount のテストで、`helper sync` の失敗を `|| true` で受ける（logic）。後始末を `rm -rf --one-file-system` にし、`${REPO_ROOT:?}` で守る（security）。
- 冒頭に、plan-2 のリリースから修正までの影響と Experience Delta を書いた（data-contract）。
- ADR の文を、出典（V26 の実行中）と「導入から一度も張れていなかった」事実を含む形にした（scope、data-contract）。
- plan-4 と research を docs の写しに加える手順を T2 に書いた（scope、data-contract）。
- VM の `/tmp` は tmpfs（btrfs ではない）と書き直した（logic）。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘: 修正の仕組み（`$>` を切り替えて `fstat` し、root に戻す）は実機で妥当だった。dumpable が 0 になっても、子は `/proc/<pid>/fd` を辿れた。
  - Step 2 の赤の期待が実際と合わない。修正前は `helper sync` が 1 で終わり、`set -e` で `test aborted` になる。
  - 軽微: VM の `/tmp` は tmpfs だった。

### scope-justification-reviewer
- verdict: pass
- 主指摘: 根拠は十分で、範囲も最小。軽微な指摘は 3 つある。
  - plan-4 を docs の写しに加える。
  - research の表の誤った行を正す。
  - ADR の出典の書き方。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: research の実測は「見ている側の uid の写し」とも説明できる。そうなら (d) は virtiofs の上で何も弾かず、却下した (c) と同じ弱点を持つ。plan の「host の所有者がそのまま見える」には根拠が無い。
  - euid の切り替えで process が non-dumpable になる。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: architecture と同じ点（virtiofs の上では検査が実質素通しになりうる）。
  - 権限を切り替えて戻す処理は正しい。
  - 後始末に `--one-file-system` と `${REPO_ROOT:?}` を使う。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: 外部契約は変わらない。次の 3 点を足す。
  - ADR の出典と、「導入から一度も通っていなかった」事実。
  - plan-4 を docs の写しに加える。
  - plan-2 のリリースから修正までの影響の記録。

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: pass
- 主指摘: VM で実測した結果、本番の mount 先（repo と `.tmp`）は virtiofs の上にあり、(b) と (d) は本番で等価だった。
  - 他のコード、テスト、docs で、mount 先の所有者の検査に依存しているものは無い。
  - 赤と緑の期待は妥当である。
  - 軽微: T2 の `grep -c` は、終了コードではなく出力で判定する（反映済み）。

### scope-justification-reviewer
- verdict: pass
- 主指摘: 新しい範囲には根拠があり、最小である。spec K6 は mount 先の所有者の検査を要求していないので、spec の再承認は要らない。Round 1 の軽微な指摘は処理済み。
  - 軽微: research の表の誤った行に注記する（反映済み）。
  - 軽微: V26 の実機確認を必須と明記する（反映済み）。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: 代替案の整理は一貫していて、(b) でも柵は崩れない。削る 1 行に、他の検査は依存していない。virtiofs の上だけで走る回帰テストと、外した検査を固定しない判断は妥当。
  - 軽微: コメントに残る柵を書く（反映済み）。
  - 軽微: Step 2 で SKIP でないことを確かめる（反映済み）。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: 所有者の検査は、差し替えの検出には元から寄与していなかった。残る柵（記録の再検証、`O_NOFOLLOW`、fd の実パス、fd 経由の mount、張った後の検証）で、事故を防ぐ柵の目的は保たれる。テストの後始末も安全である。
  - 軽微: 「実現できない」は virtiofs の上に限ると書く（反映済み）。
  - 軽微: 保存先の検査は `mkstore` のときだけと書く（反映済み）。

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: 消える警告の文言は、launcher、ツール、docs の警告表、テストのどこからも契約として参照されていない。終了コード、レコード、警告表は変わらない。Round 1 の 3 点は解消した。
  - 軽微: plan-1 の写しの「ヘルパーの契約」の「所有者を確かめ」の文も、コミットの本文で訂正の対象として挙げる（反映済み）。

<!-- auto-review: verdict=needs-work; hash=27d1eb385f90ab5f3b7e91a8b7d2f4b952323ce3655b0ffc129964ca1102d313; design-hash=8302b9a94139ffb9c61c09d796707b6eb9b6954911f6039fc2767c2ec07b4be5; round=1; parent-spec-hash=e2c7ba57e41e8bfa1714bdcfe7eae1040274fcc43701ea97798c7fe3034f76ec; at=2026-10-02T06:49:14.516Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=14; excluded=0; at=2026-10-02T06:49:14.537Z -->

<!-- auto-review: verdict=pass; hash=958a3330dd51c47e6a787b57984d888d806fade5d0c2ebdfdd79aeaa6ee1a0ba; design-hash=2c78c67f58da9f4034ea6f53ef72830b6921438f2aef73b8d398b5894201063e; round=2; parent-spec-hash=e2c7ba57e41e8bfa1714bdcfe7eae1040274fcc43701ea97798c7fe3034f76ec; at=2026-10-02T06:50:43.309Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=9; excluded=0; at=2026-10-02T06:50:43.330Z -->
