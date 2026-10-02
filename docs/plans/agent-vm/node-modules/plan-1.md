<!-- spec-ref: spec.md -->

# Plan 1: VM 側ヘルパー `agent-vm-node-modules`

spec の K1、K2、K3、K6、K9、K10 を実装する。
plan-2 は launcher の連携（K4、K5、host の `node-modules-sync`）を扱う。plan-3 は worktree 用ツール、docs、ADR（K7、K8）と手動検証 V3〜V6 を扱う。ADR-0022 は plan-3 で作り、ヘルパーの冒頭コメントと `.chezmoiignore` のコメントからの参照も plan-3 で足す。

前提と決めごと:

- ヘルパーは Linux（VM）専用で、bash 5 ＋ perl で書く。macOS の bash 3.2 では動かさない（spec の ISO「対象外: 移植性」）。
- テストは、本物の sudo と bind mount を使う統合テストにする（`tests/agent-vm/run-node-modules.sh`）。
  - K6 の保証（mount 後の device:inode と mountinfo の検証）は、本物の mount でしか確かめられない。stub で真似ると、検証の段が stub の返す値を確かめるだけになる。
  - 走らせる場所は、CI の Linux runner（使い捨てで、パスワードなし sudo がある）か、使い捨ての agent-vm machine。macOS では skip する。
  - 保存先の根は、テスト専用の `/var/lib/agent-vm-test/node_modules` を使う。ヘルパーは、この値と本番の `/var/lib/agent-vm/node_modules` 以外を受け付けない（T1）。テストは本物の machine の保存先にも、`/etc/agent-vm` にも触れない。
  - T1〜T4 のテストは、T5 で CI につなぐまで、ユーザーが使い捨ての machine で `!` を使って実行する。Claude の保護フック（deny-node-modules）は、mount を含むコマンドを Claude が Bash で打つのを止めるためである（research の検証で確認済み）。T0 の手動検証も同じ扱い。Claude はコマンドを用意し、出力を読んで判定する。
  - ubuntu の CI runner で sudo の bind mount が通ることは、最初の CI 実行まで未検証である（T5）。
- ヘルパーをテストからは `bash "$HELPER"` で呼ぶ。source の実行ビットに依存しない。配布先の実行ビットは、chezmoi の `executable_` 接頭辞が付ける。
- spec との差分（実装の都合で詳細を決めたもの）:
  - **自分の mount の判定（K3）**: spec は「root 欄の末尾一致（＋ major:minor の一致）」とする。plan では major:minor を使わず、次の 2 つを満たす行を自分の行とする。
    - root 欄の末尾が、自分の `data` のパス（`/var/lib/agent-vm/node_modules/<key>/data`）である。
    - mountpoint が `//deleted` で終わらない。
    - 理由: btrfs では、`stat` の st_dev と mountinfo の major:minor が一致しないことがありうる（subvolume ごとの匿名デバイス。実測は T0 で記録する）。一致を条件にすると、行を 1 本も見つけられないことがある。そのとき `rmstore` は「mount されていない」と判断し、mount 中の中身を消す（fail open）。
    - 「到達できるか」（mountpoint の stat が `data` と同じか）も、行の判定の条件にしない。別の mount が上に重なると、自分の行が見えなくなり、同じ fail open になるからである。
    - root 欄にパスが丸ごと現れることは、store が `/` と同じファイルシステムにある前提で成り立つ。T0 で確かめ、成り立たなければ spec に戻る（このとき mount の検証が必ず失敗するので、黙って壊れることはない）。
    - mount 後の検証と「既に張られているか」の判定には、device:inode（`node_modules` と `data` の stat の一致）を使う。これは V2 を前提とする。
    - plan-3 の ADR-0022 と docs に、この判定の変更を記録する（plan-3 への申し送り）。
    - plan-3 の V3（host での `rm -rf node_modules`）で、mountpoint が消えた行が mountinfo で `//deleted` 付きになること、その状態で `rmstore` と張り直しが通ることを確かめる（plan-3 への申し送り）。成り立たなければ、この判定を見直す。
  - **mountpoint が消えた行（K9 の詳細化）**: host での `rm -rf node_modules` の後など、mountpoint が消えた行は mountinfo で `//deleted` 付きになる。この行はパスで外せないので、自分の行として数えず、回収の妨げにしない。実際の挙動は V3（plan-3）で確かめる。
  - **期待するパス（K6 の 3 と 5）**: root 側は、mount 先のパスを呼び出し側の引数からではなく、root 所有の記録（`path`）から取る。記録は呼び出し側が正規化して書いたものである。包含（repo の中か）の検査は、bash 側だけが行う。
  - **他の repo の記録**: 回収では、`path` が今の repo の外にある記録を警告せずに飛ばす。spec K3 は「外れた保存先は警告」とする。しかし、別の repo の保存先は同じ machine で正常に起こりうる状態であり、毎回警告すると「正常な状態では通知しない」に反する。
  - **入れ子の別 repo**: repo の中に別の git repo があり（`vendor/B` など）、その中の記録がある場合、回収では飛ばす。所有する worktree から記録のパスまでの途中に `.git` があれば、別の repo の保存先とみなす。今の repo の ls-files は、入れ子の repo の中身を列挙しないためである。
  - **一覧にあるのに解決できない worktree**: 一時的に見えないだけの可能性があるので、repo 全体の回収を中止する（K2 の repo 全体の中止条件に足す）。警告には `git worktree prune` を回復手順として書く。
  - **`remove` の終了コード**: spec K10 は `sync` の 0〜3 を定める。`remove` の終了コードは次のとおり。`git worktree remove` が使う 0、1、128 とぶつからない値を選んだ。plan-3 の `git-worktree-cleanup` は、「git が拒否した」と「外せなかった」を区別して表示する。
    - 64: 引数が受け付けられない。メインの worktree と、一覧に無いパスも含む。
    - 70: ヘルパー自身の失敗（外せない、一覧を読めない、準備できない）。コマンドは実行していない。
    - 71: lock の待ち切れ。コマンドは実行していない。
    - それ以外: コマンドの終了コード。
  - **VM の外での `remove`**: コマンドだけを実行する（`exec`）。VM の外では保存先が無いので、外すものも無い。
  - **パッケージの列挙**: ls-files の pathspec は `package.json` と `'*/package.json'` にする。spec K1 の `'*package.json'` は `foopackage.json` にも一致してしまう。git の pathspec の `*` は `/` も越えるので、`'*/package.json'` は任意の深さに一致する。
  - **制御文字を含むパッケージのパス**: 警告して張らず、部分失敗（1）とする。TSV のレコードに書けないため、レコードは出さない。
  - **準備の失敗**: `sync` / `attach` で保存先の根を準備できないときは、部分失敗（1）とする。保存先の根の値が不正なときは 64。
  - **テスト専用の環境変数**: どれも launcher と worktree 用ツールは設定せず、保存先の根がテスト用のときだけ効く。
    - `AGENT_VM_NM_LOCK_WAIT`: lock の待ち秒数。正の整数で、既定は 30。
    - `AGENT_VM_NM_ASSUME_VM=1`: `/etc/agent-vm` が無くても VM とみなす。
    - `AGENT_VM_NM_TEST_FAIL_UNMOUNT=1`: `remove` で外すのが失敗したことにする。
  - **遅延 unmount（`umount -l`）**: 使用中でも失敗しない。したがって spec K7 の「外すのに失敗」（EBUSY）は、実際には「外した後も、到達できる自分の行が残る」場合にだけ起きる。
  - **テストの方式**: spec の Files は、テストを stub で書くと読める。plan では、ヘルパーのテストを本物の sudo と mount で行う（理由は上の「前提と決めごと」）。
  - **Files の追加**: `tests/agent-vm/run-templates.sh` と `tests/agent-vm/fixtures/vm-managed.txt` は spec の Files に無い。VM の許可リストに 1 行足すと、既存の「許可リストと fixture の一致」の検査が落ちるので、それに合わせる編集である。
  - **CI runner**: root でない（`sudo -n` で root になる）前提である。root で直接実行すると `SUDO_UID` が無く、root 側の操作は意図どおり失敗する。
  - **mount の対象の所有者**: root 側は、mount 先の `node_modules` が `SUDO_UID`（sudo を呼んだ VM ユーザー）の所有であることを確かめる。`data` の chown にも、引数ではなく `SUDO_UID` / `SUDO_GID` を使う。
    - 包含（repo の中か）の検査は呼び出し側（bash）の責務である。root 側が独自に確かめるのは、記録の整合（key = sha256(path) の先頭 16 桁）、最後の要素が symlink でないこと、所有者の 3 つ。これは事故を防ぐ柵で、権限の境界ではない（spec K6 の脅威モデル）。

## ヘルパーの契約（plan-2 / plan-3 が参照する正本）

spec K10 を、サブコマンドごとに詳しくしたもの。spec は承認済みなので書き換えない。plan-2（launcher）と plan-3（worktree 用ツール）は、この表を正本として参照する。

| サブコマンド | 終了コード | stdout | VM の外 |
|---|---|---|---|
| `--contract` | 0（`1` を出力）。余分な引数、または不正な保存先の根なら 64 | `1` | 同じ |
| `sync <repo>` | 0 収束。1 部分失敗。2 lock の待ち切れ。3 回収を中止した。64 使い方の誤り。1 と 3 が同時なら 1 | レコード | 何もせず 0、出力なし |
| `attach <worktree>` | 0 収束。1 部分失敗、または一覧が使えない（読めない、メインが先頭に無い、repo が見えない）。2 lock の待ち切れ。64 一覧に無いパス、使い方の誤り。3 は返さない | レコード | 何もせず 0、出力なし |
| `remove <worktree> -- <cmd...>` | 64 拒否（使い方の誤り、メインの worktree、一覧に無いパス、解決できないパス）。70 ヘルパー自身の失敗（準備の失敗、一覧が使えない、外す処理の失敗、予期しないエラー、中断）。71 lock の待ち切れ。それ以外はコマンドの終了コード | ヘルパー自身は出さない。コマンドの stdout / stderr / stdin はそのまま通す（plan-3 は出力を捨てない） | コマンドを `exec` するだけ |

各サブコマンドに共通する終了コード:

- 引数の誤り（数、`--` の欠落、未知のサブコマンド）: VM の中でも外でも 64。表の「VM の外」の挙動は、引数が正しい場合のものである。
- `AGENT_VM_NM_STORE` が 2 つの固定値のどちらでもないとき: VM の中でも外でも 64（`--contract` も含む）。launcher と worktree 用ツールはこの変数を設定しないので、起きない。
- 保存先の根を準備できないとき: `sync` / `attach` は 1、`remove` は 70。

1 と 3 の意味:

- 1（部分失敗）: 張るべきだったパッケージのうち、VM ローカルにならなかったものがある。原因は次のいずれか。または、回収の削除が失敗した。
  - symlink の `node_modules`
  - 制御文字を含むパス
  - 保存先を作れない
  - 古い mount が外れずに残っている
  - `node_modules` を作れない
  - mount の失敗
- 3（回収の中止）: 保存先を残すために、回収を止めた。次の 2 つの場合がある。
  - repo 全体の中止: 一覧を読めない、空、メインが先頭に無い、repo が見えない、解決できない worktree がある。
    - 一覧を読めない場合と repo が見えない場合は、何も張っていない。
    - メインが先頭に無い場合と解決できない worktree がある場合は、一覧の残りの worktree には張る。
  - worktree ごとの中止: ls-files の失敗、上限超過、パッケージ 0 件で保存先がある。
- `sync` の 3 は、張らないパッケージが出ていても 1 にしない（spec K2）。3 は回収の中止を表し、同時に「すべては張れていない可能性がある」ことも伝える。1 の原則（VM ローカルにならないパッケージがあれば 1）は、`sync` では張る対象にしたパッケージにだけ当てはまる。`attach` は回収しないので、ls-files の失敗と上限超過を 1 とする。
- `attach` は、一覧に解決できない兄弟の worktree があっても続行する。回収をしないので、それを理由に失敗しない。`remove` も同じ。
- `attach` は、保存先を残しただけ（パッケージ 0 件で保存先がある）なら 0 とする。
- レコード（`empty|mounted|skipped\t<path>`）は、終了コードにかかわらず有効である。
  - 1 の原因のすべてがレコードを伴うわけではない。`skipped` を出すのは symlink の `node_modules` だけである。他の原因では、レコードが無いまま 1 になる（詳細は stderr の警告）。
  - `attach` もレコードを出す。plan-3 の `git-worktree-create` は stdout を捨てる。
  - plan-2 の launcher は、`empty` のレコードだけを通知に使う。
- `remove` の 64、70、71 では、コマンドは実行されていない。
  - 64 と 71 では、mount も元のままである。
  - 外す処理（`detach`）の失敗による 70 では、対象の mount の張り直しを試みる。trap による 70（予期しないエラー、中断）では、既に外した mount は戻らず、次の `sync` が張り直す。
  - plan-3 の `git-worktree-cleanup` は、64 のときの扱い（ヘルパーを通さずに git を実行するか、worktree を残すか）を明示して決める。
- コマンドを実行する前の予期しないエラーと中断（INT / TERM）は、70 で終わる（trap）。このとき既に外した mount は、次の `sync` が張り直す。
- `remove` でラップしてよいのは、自分では 64、70、71 を返さないコマンド（`git worktree remove` は 0、1、128）だけである。
- `remove` は、コマンドの終了コードが 0 で、かつ worktree のディレクトリが無くなったときだけ、保存先を消す。0 でも worktree が残っていれば、張り直して警告する。
- 呼び出し側（launcher と worktree 用ツール）は、0 以外をすべて警告として扱い、表に無い値でも止まらない。
- コマンドの実行中にヘルパーが中断されると、外した mount は戻らない。lock はコマンドに渡していないので解放される。次の `sync` が張り直す。

保存先の不変条件:

- `/var/lib/agent-vm/node_modules` とその親、`<key>/`、`.lock` は root 所有で、group / other の書き込み権限が無い。ヘルパーが作るときは 0755（`.lock` は 0644）にし、既にあるものは所有者と書き込み権限だけを確かめる。
- `<key>` は 16 桁の hex で、`path` の中身の sha256 の先頭 16 桁と一致する。この形に合わない名前（`.lock` など）は、列挙で飛ばす。
- `<key>/path` は root 所有で、`<key>/data` だけが VM ユーザーの所有である。
  - `path` の所有者は作るときにだけ保証し、読む側は確かめない。読む側が確かめるのは、symlink でないことと key の整合である。
- 途中の状態として、次の 2 つがありうる（`mkstore` の中断）。
  - 中身の無い `<key>/`: 回収も警告もせず、そのまま残す。
  - `path` だけあって `data` が無い: 次の `attach` が `data` を補う。

## Files

```
# 新規作成
home/dot_local/bin/executable_agent-vm-node-modules
tests/agent-vm/run-node-modules.sh

# 編集
home/.chezmoiignore
tests/agent-vm/fixtures/vm-managed.txt
tests/agent-vm/run-templates.sh
.github/workflows/ci-agent-vm.yml
```

## Tasks

### T0: 手動検証 V1 / V2（実装の前の関門）

spec の手動検証の V1（fd 経由の mount）と V2（mount 後の device:inode と mountinfo の形式）を、ヘルパーを書く前に確かめる。結果で T1 の定数 `FD_MOUNT` を決め、device:inode による判定の前提を確かめる。

**Files:**

- 参照: spec.md「手動検証」V1、V2、K3（自分の mount の判定）、K6 の 4
- 参照: `home/dot_local/bin/executable_agent-vm` の `maybe_bootstrap`（perl の `O_NOFOLLOW` の既存の書き方）

- [ ] **Step 1: 使い捨ての machine を用意する（Claude が実行）**

scratchpad に試験用の git repo `<R>` を作り（`<R>` = `<scratchpad>/v1` の絶対パス）、`agent-vm prewarm` で machine を作る（research の B' 検証と同じ手順）。

host 側で作った `node_modules` の所有者を VM から確かめるため、host で `<R>/hostpkg/node_modules/.keep` を Write ツールで作っておく。

- [ ] **Step 2: 検証用の perl を書く（Claude が Write で書く）**

ファイル: `<R>/v1.pl`（repo の中に置き、VM から同じパスで見えるようにする）

```perl
# usage: sudo -n perl v1.pl <src_dir> <dst_dir>
use strict; use warnings; use POSIX ();
use Fcntl qw(O_RDONLY O_DIRECTORY O_NOFOLLOW F_GETFD F_SETFD FD_CLOEXEC);
my ($src, $dst) = @ARGV;
sysopen(my $s, $src, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) or die "open src: $!\n";
sysopen(my $d, $dst, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) or die "open dst: $!\n";
for my $fh ($s, $d) { my $fl = fcntl($fh, F_GETFD, 0) or die; fcntl($fh, F_SETFD, $fl & ~FD_CLOEXEC) or die }
my ($sf, $df) = (fileno $s, fileno $d);
my @cmd = ('mount', '--no-canonicalize', '--bind', "/proc/$$/fd/$sf", "/proc/$$/fd/$df");
print "readlink src: ", readlink("/proc/self/fd/$sf"), "\nreadlink dst: ", readlink("/proc/self/fd/$df"), "\n";
my $pid = fork() // die;
if ($pid == 0) { exec(@cmd) or POSIX::_exit(127) }
waitpid($pid, 0); print "mount exit: ", $? >> 8, "\n";
my @a = stat $dst; my @b = stat $src;
print "dst dev:ino $a[0]:$a[1]  src dev:ino $b[0]:$b[1]\n";
open my $mi, '<', '/proc/self/mountinfo' or die; print grep { index($_, $dst) >= 0 } <$mi>;
```

- [ ] **Step 3: ユーザーが VM で実行する**

ユーザーに、次の 2 行を `!` で実行してもらう（`<m>` は Step 1 の machine 名）。

```
! orb -m <m> bash -lc 'id -u; stat -c "%u %n" <R>/hostpkg/node_modules; stat -c "%U %a %n" /var/lib/agent-vm 2>&1; findmnt -no SOURCE,FSTYPE -T /var/lib; sudo -n mkdir -p /var/lib/agent-vm-v1/data && mkdir -p <R>/pkg/node_modules && sudo -n perl <R>/v1.pl /var/lib/agent-vm-v1/data <R>/pkg/node_modules'
! orb -m <m> bash -lc 'sudo -n umount <R>/pkg/node_modules; sudo -n rm -rf /var/lib/agent-vm-v1'
```

- [ ] **Step 4: 結果で決める**

判定（出力を Claude が読む）:

- V1 の合格: `mount exit: 0` で、mountinfo の行の第 5 欄（mountpoint）が `<R>/pkg/node_modules` と一致する。
  - 合格なら、T1 の `FD_MOUNT = 1`。
  - 不合格なら `FD_MOUNT = 0` とし、mount は正規化したパスで行う（`mount --no-canonicalize --bind <data> <target>`。spec K6 の 4 の代替）。fd を開いた後の検査（readlink、所有者）と、mount 後の検証は残す。
- V2 の合格: `dst dev:ino` と `src dev:ino` が一致する。mount 後の検証と「既に張られているか」の判定の前提である。不合格なら実装に進まず、spec に戻る。
- root 欄の合格: mountinfo の行の第 4 欄（root）が、`/var/lib/agent-vm-v1/data` で終わる（subvolume の接頭辞は前に付いてよい）。自分の行の判定の前提である。不合格（`/var/lib` が別のファイルシステムで、root 欄が短い）なら、spec に戻る。
- 所有者の合格: `<R>/hostpkg/node_modules` の uid が、`id -u` と一致する。mount 先の所有者の検査の前提である。不合格なら、host が作った `node_modules` にはすべて張れない。実装に進まず、spec に戻る。
- 第 3 欄（major:minor）と st_dev の関係を、plan-3 の docs の V 表のために記録する。
- `/var/lib/agent-vm` が既にあって、root の所有でないか、group / other の書き込み権限があれば、`prepare` が拒否する。その場合は実装に進まず、spec に戻る。

- [ ] **Step 5: machine を片付ける**

`echo y | agent-vm rm <R>` で削除する。結果（`FD_MOUNT` の値と、根拠になった出力）は research.md の「V1 / V2 の結果」に追記する。

### T1: 骨格（契約、使い方、保存先の固定、VM の判定、root の操作）

**Files:**

- 新規: `home/dot_local/bin/executable_agent-vm-node-modules`（後述「完成形のコード」の T1 の部分と、`PRIV_PL` 全体）
- テスト: `tests/agent-vm/run-node-modules.sh`（後述「テストのコード」の共通部分と T1 の節）
- 参照: spec.md K3（保存先の構造、root 所有、key の正規表現）、K6（VM の外では何もしない）、K10（`--contract`、終了コード）

- [ ] **Step 1: 失敗するテストを書く**

「テストのコード」の共通部分（先頭から `fail_git` まで、末尾の実行ループ）と、T1 の節（4 件）を書く。

- [ ] **Step 2: テストを実行して失敗を確認**

実行（ユーザーが使い捨ての machine で `!`、T5 以降は CI）: `bash tests/agent-vm/run-node-modules.sh`
期待: T1 の 4 件が FAIL（ヘルパーが無い）。agent-vm machine 上では `test_outside_a_vm_does_nothing` が SKIP になるので、FAIL は 3 件。

- [ ] **Step 3: 最小実装を書く**

「完成形のコード」のうち、次を書く。

- 冒頭（shebang から `rows` まで）、`PRIV_PL`、`usage`、`require_vm`、`start`、`lock`、状態の宣言、`main`
- `main` の `sync` / `attach` / `remove` の分岐先は T2〜T4 で足す。それまでの仮の形は次の 3 行で、T2 と T4 で置き換える。

  ```bash
  cmd_sync() { require_vm || exit 0; usage; }
  cmd_attach() { require_vm || exit 0; usage; }
  cmd_remove() { usage; }
  ```

- `FD_MOUNT` には T0 で決めた値を入れる。

- [ ] **Step 4: テストを実行して通過を確認**

期待: T1 の 4 件が PASS（machine 上では 3 件が PASS、1 件が SKIP）。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm-node-modules tests/agent-vm/run-node-modules.sh
git commit -m "feat(agent-vm): add the agent-vm-node-modules helper skeleton"
```

### T2: worktree とパッケージの列挙、`sync` の張る処理、`attach`

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm-node-modules`（`load_worktrees`、`owner_of`、`stores_owned_by`、`collect_packages`、`report_pkg`、`attach_pkg`、`attach_all`、`finish`、`cmd_sync`（`reclaim` の行を除く）、`resolve_worktree`、`cmd_attach`）
- テスト: `tests/agent-vm/run-node-modules.sh`
- 参照: spec.md K1（パッケージの列挙）、K2（worktree ごとの中止条件、上限）、K5（`empty` レコード）、K6（対象の条件と手順）、K9（失効の判定）、K10（1 が 3 に優先）
- 参照: `home/dot_local/bin/executable_git-worktree-cleanup:167-187`（`git worktree list --porcelain -z` の読み方）

- [ ] **Step 1: 失敗するテストを書く**

「テストのコード」の T2 の節（`test_sync_mounts_each_package` から `test_lock_timeout_exits_2` まで）を書く。

- [ ] **Step 2: テストを実行して失敗を確認**

期待: T2 の節のテストが FAIL（`sync` / `attach` が `usage` に落ちて 64 を返す）。

- [ ] **Step 3: 最小実装を書く**

「完成形のコード」の T2 の関数を書く。`cmd_sync` は、`reclaim` の `if` / `else` の 1 文の代わりに、次の 1 行を置いた形で書く。T3 でこの行を `if` / `else` の 1 文に置き換える。

```bash
  if [[ $ABORT_ALL -ne 0 ]]; then warn "kept every VM-local node_modules of $ROOT this time"; fi
```

上限超過や「パッケージ 0 件で保存先あり」の終了コード 3 は、`finish` が T2 の時点で返す。

- [ ] **Step 4: テストを実行して通過を確認**

期待: T1 と T2 のテストが PASS。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm-node-modules tests/agent-vm/run-node-modules.sh
git commit -m "feat(agent-vm): mount a VM-local node_modules for each package"
```

### T3: 回収と中止条件

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm-node-modules`（`under_aborted`、`in_nested_repo`、`reclaim`、`cmd_sync` の `reclaim` の 1 文）
- テスト: `tests/agent-vm/run-node-modules.sh`
- 参照: spec.md K2（repo 全体と worktree ごとの中止条件）、K3（記録の読み戻しの検査）

- [ ] **Step 1: 失敗するテストを書く**

「テストのコード」の T3 の節（`test_removed_package_is_reclaimed` から `test_unresolvable_worktree_keeps_stores` まで）を書く。

- [ ] **Step 2: テストを実行して失敗を確認**

期待: 「消える」ことを確かめるテスト（`test_removed_package_is_reclaimed` と、`test_main_abort_does_not_block_a_worktree` の後半）が FAIL する。回収が無いので保存先が残るためである。「残る」ことを確かめるテストは、この時点では回収が無いので PASS しうる。これらは T3 の実装の後も PASS し続けることで、中止条件の効き目を確かめる。

- [ ] **Step 3: 最小実装を書く**

「完成形のコード」の `under_aborted`、`in_nested_repo`、`reclaim` と、`cmd_sync` の `reclaim` の 1 文を書く。

- [ ] **Step 4: テストを実行して通過を確認**

期待: T1〜T3 のテストが PASS。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm-node-modules tests/agent-vm/run-node-modules.sh
git commit -m "feat(agent-vm): reclaim VM-local node_modules of packages that are gone"
```

### T4: `remove`

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm-node-modules`（`detach`、`cmd_remove`）
- テスト: `tests/agent-vm/run-node-modules.sh`
- 参照: spec.md K7（lock を持ったまま、外す → コマンド → 消す / 張り直す）、K3（`remove` の対象）

- [ ] **Step 1: 失敗するテストを書く**

「テストのコード」の T4 の節（`test_remove_reclaims_after_success` から `test_remove_lock_timeout_exits_71` まで）を書く。

- [ ] **Step 2: テストを実行して失敗を確認**

期待: T4 の節が FAIL。

- [ ] **Step 3: 最小実装を書く**

「完成形のコード」の `detach` と `cmd_remove` を書き、`main` の `remove` の分岐をつなぐ。

- [ ] **Step 4: テストを実行して通過を確認**

期待: すべて PASS。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm-node-modules tests/agent-vm/run-node-modules.sh
git commit -m "feat(agent-vm): remove a worktree with its VM-local node_modules under one lock"
```

### T5: chezmoi の振り分けと CI

**Files:**

- 編集: `home/.chezmoiignore`（VM 許可リストの `!.local/bin/git-worktree-cleanup` の次の行。host 側で無視する新しいブロック）
- 編集: `tests/agent-vm/fixtures/vm-managed.txt`（`.local/bin/git-worktree-cleanup` の次の行）
- テスト: `tests/agent-vm/run-templates.sh`
- 編集: `.github/workflows/ci-agent-vm.yml`
- 参照: `home/.chezmoiignore:34-38`（agent-vm の launcher を OS で振り分けている既存のブロック）、`tests/agent-vm/run-templates.sh:89-92`（許可リストと fixture の一致の検査）

- [ ] **Step 1: 失敗するテストを書く**

`tests/agent-vm/fixtures/vm-managed.txt` の `.local/bin/git-worktree-cleanup` の次に `.local/bin/agent-vm-node-modules` を足す。`tests/agent-vm/run-templates.sh` に次を足す。

```bash
test_node_modules_helper_is_vm_only() {
  local vm host
  vm=$'\n'"$(managed_as "$VM_DATA")"$'\n'
  host=$'\n'"$(managed_as "$HOST_LINUX")"$'\n'
  assert_contains "$vm" $'\n.local/bin/agent-vm-node-modules\n' "the VM gets the node_modules helper"
  assert_not_contains "$host" $'\n.local/bin/agent-vm-node-modules\n' "hosts do not get the node_modules helper"
}
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run-templates.sh`（Linux で、chezmoi が要る。CI か VM で実行）
期待: `test_vm_manages_exactly_the_allowlist` と `test_node_modules_helper_is_vm_only` が FAIL。

- [ ] **Step 3: 最小実装を書く**

`home/.chezmoiignore` の VM 許可リストに、`!.local/bin/git-worktree-cleanup` の次の行として `!.local/bin/agent-vm-node-modules` を足す。launcher のブロック（34〜38 行）の後に、次のブロックを足す（ADR への参照は plan-3 で足す）。

```
# agent-vm-node-modules runs only inside agent-vm machines
{{ if not (dig "agent_vm" false .) }}
.local/bin/agent-vm-node-modules
{{ end }}
```

`.github/workflows/ci-agent-vm.yml` の「Run template tests」の後に、次を足す。

```yaml
      - name: Run node_modules helper tests
        if: runner.os == 'Linux'
        run: bash tests/agent-vm/run-node-modules.sh
```

同じファイルの `paths` の 2 か所（push と pull_request）に、`home/dot_local/bin/executable_agent-vm-node-modules` を足す。

- [ ] **Step 4: テストを実行して通過を確認**

期待:

- `run-templates.sh` がすべて PASS する。`test_ignore_vm_block_leaves_host_render_unchanged` も PASS する（新しいブロックは VM ブロックの外にあり、host の描画で同じ結果になる）。
- push 後の CI（ubuntu）で `Run node_modules helper tests` が PASS する。runner で sudo の bind mount が使えない場合は、この plan に戻って扱いを決める（skip に逃がさない）。

- [ ] **Step 5: コミット**

```bash
git add home/.chezmoiignore tests/agent-vm/fixtures/vm-managed.txt tests/agent-vm/run-templates.sh .github/workflows/ci-agent-vm.yml
git commit -m "feat(agent-vm): deliver the node_modules helper to VMs only"
```

## 完成形のコード: `home/dot_local/bin/executable_agent-vm-node-modules`

T1〜T4 で、関数の単位でこのコードを書き足していく。各関数の上のコメント `# [Tn]` は、その関数を足すタスクを示す（実装では書かない）。`FD_MOUNT` は T0 の結果で決める。

```bash
#!/usr/bin/env bash
# agent-vm-node-modules: give each JS package of an agent-vm repository its own VM-local node_modules, so the
# host's install and the VM's install stop replacing each other's platform packages.
# Runs only inside an agent-vm machine, whose user has passwordless sudo (ADR-0018 R6): the checks here keep the
# regular callers (the launcher, the worktree tools) from mounting or deleting in the wrong place by accident.
# They are not a privilege boundary.
set -euo pipefail

CONTRACT=1
MAX_PACKAGES=500
EXIT_PARTIAL=1 EXIT_LOCKED=2 EXIT_RECLAIM_ABORTED=3 EXIT_USAGE=64   # sync / attach (spec K10)
EXIT_RM_FAILED=70 EXIT_RM_LOCKED=71   # remove: outside the statuses git worktree remove uses (0, 1, 128)

PROD_STORE=/var/lib/agent-vm/node_modules TEST_STORE=/var/lib/agent-vm-test/node_modules
STORE=${AGENT_VM_NM_STORE:-$PROD_STORE}
if [[ "$STORE" != "$PROD_STORE" && "$STORE" != "$TEST_STORE" ]]; then
  printf 'agent-vm-node-modules: AGENT_VM_NM_STORE must be %s or %s\n' "$PROD_STORE" "$TEST_STORE" >&2
  exit "$EXIT_USAGE"
fi
# git must read the repository it is pointed at with -C, not one an inherited environment names.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY
LOCK_WAIT=30
# Test-only knob, honored only with the test store: the launcher and the worktree tools never set it.
if [[ "$STORE" == "$TEST_STORE" && "${AGENT_VM_NM_LOCK_WAIT:-}" =~ ^[1-9][0-9]*$ ]]; then LOCK_WAIT=$AGENT_VM_NM_LOCK_WAIT; fi

warn() { printf 'agent-vm-node-modules: %s\n' "$*" >&2; }
emit() { printf '%s\t%s\n' "$1" "$2"; }   # stdout carries records only (spec K10)
has_ctrl() { [[ "$1" =~ [[:cntrl:]] ]]; }
canon() { perl -MCwd=realpath -e 'my $r = realpath($ARGV[0]); (defined $r && -e $r) or exit 1; print $r' -- "$1"; }
key_of() { local k; k=$(printf '%s' "$1" | sha256sum) || return 1; printf '%s\n' "${k:0:16}"; }
ino() { stat -c '%d:%i' -- "$1" 2>/dev/null; }
is_test_store() { [[ "$STORE" == "$TEST_STORE" ]]; }
priv() { sudo -n perl -e "$PRIV_PL" -- "$STORE" "$@"; }
rows() { perl -e "$PRIV_PL" -- "$STORE" rows "$1"; }   # reading mountinfo needs no root

# Everything that needs root. It takes the mount target from the root-owned record, never from the caller, and
# re-checks the record (key = sha256(path)), the last path component (no symlink) and the target's owner.
# Containment in the repository is the caller's check.
PRIV_PL=$(cat <<'PERL'
use strict; use warnings; use POSIX ();
use Fcntl qw(O_RDONLY O_WRONLY O_CREAT O_EXCL O_DIRECTORY O_NOFOLLOW F_GETFD F_SETFD FD_CLOEXEC);
use Digest::SHA qw(sha256_hex);
use constant FD_MOUNT => 1;   # from the T0 result (plan-1)
my ($store, $op, @arg) = @ARGV;
defined $op or die "usage\n";
$store =~ m{\A/var/lib/agent-vm(?:-test)?/node_modules\z} or die "unsupported store root\n";
sub key_ok { my ($k) = @_; (defined $k && $k =~ /\A[0-9a-f]{16}\z/) or die "bad key\n"; return $k }
sub unesc { my ($s) = @_; $s =~ s/\\([0-7]{3})/chr(oct($1))/ge; return $s }
sub path_ok { my ($p, $k) = @_; return $p =~ m{\A/} && $p !~ /[[:cntrl:]]/ && substr(sha256_hex($p), 0, 16) eq $k }
sub same_inode { my @a = stat $_[0]; my @b = stat $_[1]; return @a && @b && $a[0] == $b[0] && $a[1] == $b[1] }
sub mountinfo { # -> [mount id, root, mountpoint] for every mount, in mount order
  open my $mi, '<', '/proc/self/mountinfo' or die "mountinfo: $!\n";
  return map { my @f = split / /; [$f[0], unesc($f[3]), unesc($f[4])] } <$mi>;
}
sub all_rows { # key -> [mount id, mountpoint] of every mount whose root ends with this key's data (spec K3)
  my $suffix = "$store/" . key_ok($_[0]) . '/data';
  return map { [$_->[0], $_->[2]] }
    grep { length($_->[1]) >= length($suffix) && substr($_->[1], -length $suffix) eq $suffix } mountinfo();
}
sub rows { # key -> mountpoints of this key's mounts. A row whose mountpoint was deleted (on the host) cannot be
           # unmounted by path, so it is not counted (K9). Reachability is not a criterion: a mount stacked on
           # top would hide a live row and let rmstore delete mounted content.
  return map { $_->[1] } grep { $_->[1] !~ m{//deleted\z} } all_rows($_[0]);
}
sub owned_dir_ok { # path uid -> 1 for a real directory or file of that owner without group/other write
  my @st = lstat $_[0];
  return @st && (-d _ || -f _) && $st[4] == $_[1] && ($st[2] & 022) == 0;
}
sub record_path { # key -> package dir from the root-owned record, re-validated
  my $key = key_ok($_[0]); my $d = "$store/$key";
  die "record is a symlink\n" if -l $d || -l "$d/path";
  open my $fh, '<', "$d/path" or die "record: $!\n";
  my $p = <$fh>; defined $p or die "empty record\n"; chomp $p;
  path_ok($p, $key) or die "inconsistent record\n";
  return $p;
}

if ($op eq 'rows') { print "$_\n" for rows(key_ok($arg[0])); exit 0 }
die "must run as root\n" unless $> == 0;
my ($uid, $gid) = ($ENV{SUDO_UID} // '', $ENV{SUDO_GID} // '');
($uid =~ /\A[1-9][0-9]*\z/ && $gid =~ /\A[0-9]+\z/) or die "must run through sudo from the VM user\n";

# Creation tolerates EEXIST: prepare and mkstore run before the lock, so two first runs may race. Whoever made
# it, the result must pass the same ownership and mode check.
sub mkdir_root { my ($d) = @_; if (mkdir $d, 0755) { chmod 0755, $d } elsif (!$!{EEXIST}) { die "mkdir $d: $!\n" } }

if ($op eq 'prepare') { # create the store root once; never adopt a directory or lock someone else made
  (my $parent = $store) =~ s{/node_modules\z}{};
  for my $d ($parent, $store) {
    mkdir_root($d);
    (owned_dir_ok($d, 0) && -d _) or die "$d must be a root-owned directory without group/other write\n";
  }
  my $lock = "$store/.lock";
  if (sysopen(my $fh, $lock, O_WRONLY | O_CREAT | O_EXCL, 0644)) { close $fh; chmod 0644, $lock } elsif (!$!{EEXIST}) { die "lock: $!\n" }
  (owned_dir_ok($lock, 0) && -f _) or die "$lock must be a root-owned file without group/other write\n";
  exit 0;
}
if ($op eq 'mkstore') {
  my ($key, $path) = (key_ok($arg[0]), $arg[1] // '');
  path_ok($path, $key) or die "the key does not match the path\n";
  my $d = "$store/$key";
  mkdir_root($d);
  (owned_dir_ok($d, 0) && -d _) or die "$d must be a root-owned directory\n";
  my $tmp = "$d/path.tmp"; unlink $tmp;
  sysopen(my $fh, $tmp, O_WRONLY | O_CREAT | O_EXCL, 0644) or die "record: $!\n";
  print $fh "$path\n"; close $fh or die "record: $!\n";
  rename $tmp, "$d/path" or die "record: $!\n";
  my $data = "$d/data";
  unless (lstat $data) { mkdir $data, 0755 or die "mkdir $data: $!\n"; chown $uid, $gid, $data or die "chown: $!\n" }
  (owned_dir_ok($data, $uid) && -d _) or die "$data must be a directory owned by the VM user\n";
  exit 0;
}
if ($op eq 'mount') { # spec K6 steps 2-5, in this one root process
  my $key = key_ok($arg[0]); my $target = record_path($key) . '/node_modules'; my $data = "$store/$key/data";
  sysopen(my $src, $data, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) or die "open $data: $!\n";
  sysopen(my $dst, $target, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) or die "open $target: $!\n";
  my ($s, $t) = (fileno $src, fileno $dst);
  (readlink("/proc/self/fd/$s") // '') eq $data or die "the store moved\n";
  (readlink("/proc/self/fd/$t") // '') eq $target or die "$target moved\n";
  ((stat $dst)[4] // -1) == $uid or die "$target is not owned by the VM user\n";
  die "$target is already mounted\n" if grep { $_ eq $target } rows($key);   # no stacking
  my %before = map { $_->[0] => 1 } all_rows($key);
  my @cmd = ('mount', '--no-canonicalize', '--bind', FD_MOUNT ? ("/proc/$$/fd/$s", "/proc/$$/fd/$t") : ($data, $target));
  if (FD_MOUNT) { for my $fh ($src, $dst) { my $fl = fcntl($fh, F_GETFD, 0) or die "fcntl: $!\n"; fcntl($fh, F_SETFD, $fl & ~FD_CLOEXEC) or die "fcntl: $!\n" } }
  my $pid = fork() // die "fork: $!\n";
  if ($pid == 0) { exec(@cmd) or POSIX::_exit(127) }
  waitpid($pid, 0); my $status = $?;
  my %new = map { $_->[0] => 1 } grep { !$before{$_->[0]} && $_->[1] eq $target } all_rows($key);
  exit 0 if $status == 0 && %new && same_inode($target, $data);
  # Undo only when the topmost mount at the target is one this run added; umount by path removes the top one.
  my ($top) = reverse grep { $_->[2] eq $target } mountinfo();
  system('umount', '--no-canonicalize', $target) if $top && $new{$top->[0]};
  die "the mount of $target did not verify\n";
}
if ($op eq 'unmount') { # lazily detach every row, including rows stacked at one mountpoint
  my $key = key_ok($arg[0]);
  ROUND: for (1 .. 8) {
    my @r = rows($key) or last;
    my %mine = map { $_->[0] => 1 } all_rows($key);
    for my $mp (@r) {
      # umount by path removes the topmost mount there; stop rather than remove a mount that is not ours
      my ($top) = reverse grep { $_->[2] eq $mp } mountinfo();
      last ROUND unless $top && $mine{$top->[0]};
      system('umount', '-l', '--no-canonicalize', $mp);
    }
  }
  my @left = rows($key);
  exit(@left ? 1 : 0);
}
if ($op eq 'rmstore') { # delete a store that no live mount uses any more
  my $key = key_ok($arg[0]); my $d = "$store/$key";
  die "$d is a symlink\n" if -l $d;
  my @left = rows($key); die "still mounted\n" if @left;
  if (lstat "$d/path") { my $p = record_path($key); die "$p/node_modules is still this store\n" if same_inode("$p/node_modules", "$d/data") }
  system('rm', '-rf', '--one-file-system', '--', $d) == 0 or die "could not remove $d\n";
  exit 0;
}
die "unknown operation\n";
PERL
)

# [T1]
usage() {
  printf 'usage: agent-vm-node-modules --contract | sync <repo> | attach <worktree> | remove <worktree> -- <command...>\n' >&2
  exit "$EXIT_USAGE"
}
# [T1] 0 inside an agent-vm machine (spec K6). The test suite stands in for one only with the test store.
require_vm() { [[ -e /etc/agent-vm ]] || { is_test_store && [[ "${AGENT_VM_NM_ASSUME_VM:-}" == 1 ]]; }; }
# [T1]
start() { WORK=$(mktemp -d); trap 'rm -rf -- "$WORK"' EXIT; }
# [T1] prepare_failure_status timeout_status
lock() {
  priv prepare || { warn "could not prepare $STORE"; exit "$1"; }
  exec 9<"$STORE/.lock"
  flock -w "$LOCK_WAIT" 9 || { warn "another agent-vm-node-modules is running; gave up after ${LOCK_WAIT}s"; exit "$2"; }
}

# [T1] Associative arrays are keyed by key_of(path), never by a path.
declare -a WORKTREES=() PKG_DIRS=() PKG_KEYS=()
declare -A IS_WT=() WANT=() ABORT_WT=()
ABORT_ALL=0 PARTIAL=0 MISSED=0 WORK='' WT='' ROOT=''   # MISSED: some package was never considered for mounting

# [T2] root -> WORKTREES / IS_WT (spec K2, K6). 1: the list is unusable. 2: the list is usable, but a listed
# worktree cannot be resolved, so reclaim must not trust it (attach and remove, which never reclaim, go on).
load_worktrees() {
  local root=$1 f c first=1 main_ok=0 unresolved=0
  if [[ ! -e "$root/.git" ]]; then warn "the repository is not visible: $root"; return 1; fi
  # 9>&-: a long-lived git child (fsmonitor) must not keep the lock
  if ! git -C "$root" worktree list --porcelain -z >"$WORK/worktrees" 2>/dev/null 9>&-; then
    warn "git worktree list failed in $root"; return 1
  fi
  while IFS= read -r -d '' f; do
    [[ "$f" == "worktree "* ]] || continue
    if [[ $first -eq 1 ]]; then   # git lists the main worktree first
      first=0
      if c=$(canon "${f#worktree }") && [[ "$c" == "$root" ]]; then main_ok=1; WORKTREES+=("$c"); IS_WT[$(key_of "$c")]=1; fi
      continue
    fi
    if ! c=$(canon "${f#worktree }") || has_ctrl "$c"; then   # may be only temporarily invisible: keep its stores
      warn "a worktree of $root cannot be resolved; its VM-local node_modules are kept (recover: git -C $root worktree prune)"
      unresolved=1; continue
    fi
    if [[ "$c" != "$root/.git/worktree/"* ]]; then warn "skipping a worktree outside the repository: $c"; continue; fi
    WORKTREES+=("$c"); IS_WT[$(key_of "$c")]=1
  done <"$WORK/worktrees"
  # An empty list fails here too: it has no first entry.
  if [[ $main_ok -eq 0 ]]; then warn "the worktree list of $root does not start with $root"; return 1; fi
  if [[ $unresolved -ne 0 ]]; then return 2; fi
}
# [T2] path -> the deepest listed worktree that contains it, or nothing
owner_of() {
  local w best=''
  for w in "${WORKTREES[@]}"; do
    if [[ ("$1" == "$w" || "$1" == "$w/"*) && ${#w} -gt ${#best} ]]; then best=$w; fi
  done
  printf '%s' "$best"
}
# [T2] worktree -> 0 when some consistent store records a package that this worktree owns
stores_owned_by() {
  local d p
  for d in "$STORE"/*; do
    [[ "${d##*/}" =~ ^[0-9a-f]{16}$ && -f "$d/path" && ! -L "$d/path" ]] || continue
    IFS= read -r p <"$d/path" || continue
    if [[ "$(key_of "$p")" == "${d##*/}" && "$(owner_of "$p")" == "$1" ]]; then return 0; fi
  done
  return 1
}
# [T2] worktree -> PKG_DIRS / PKG_KEYS / WANT; may set ABORT_WT and PARTIAL (spec K1, K2, K6)
collect_packages() {
  local wt=$1 wk p dir c k
  local -a dirs=() keys=()
  local -A seen=()
  wk=$(key_of "$wt")
  if ! git -C "$wt" ls-files -z --cached --others --exclude-standard -- package.json '*/package.json' >"$WORK/packages" 2>/dev/null 9>&-; then
    warn "git ls-files failed in $wt; its VM-local node_modules are kept"
    ABORT_WT[$wk]=1; MISSED=1; return 0
  fi
  while IFS= read -r -d '' p; do
    case "/$p" in */node_modules/* | */.git/*) continue ;; esac
    if [[ ! -f "$wt/$p" || -L "$wt/$p" ]]; then continue; fi
    dir=$(dirname -- "$wt/$p")
    c=$(canon "$dir") || continue
    if has_ctrl "$c"; then warn "a package path in $wt has control characters; it stays shared with the host"; PARTIAL=1; continue; fi
    if [[ "$c" != "$wt" && "$c" != "$wt/"* ]]; then continue; fi
    k=$(key_of "$c")
    if [[ -n "${seen[$k]:-}" ]]; then continue; fi
    seen[$k]=1; dirs+=("$c"); keys+=("$k")
  done <"$WORK/packages"
  if [[ ${#dirs[@]} -gt $MAX_PACKAGES ]]; then
    warn "$wt has ${#dirs[@]} packages (over $MAX_PACKAGES); only its root package gets a VM-local node_modules"
    ABORT_WT[$wk]=1; MISSED=1; dirs=(); keys=()
    if [[ -f "$wt/package.json" && ! -L "$wt/package.json" ]]; then dirs=("$wt"); keys=("$wk"); fi
  fi
  if [[ ${#dirs[@]} -eq 0 ]] && stores_owned_by "$wt"; then
    warn "no package.json found in $wt, but it has VM-local node_modules; they are kept"
    ABORT_WT[$wk]=1
  fi
  for k in "${keys[@]}"; do WANT[$k]=1; done
  PKG_DIRS+=("${dirs[@]}"); PKG_KEYS+=("${keys[@]}")
}
# [T2] dir key: an "empty" record only for a worktree root whose VM-local node_modules is empty (spec K5)
report_pkg() {
  if [[ -n "${IS_WT[$2]:-}" && -z "$(ls -A -- "$STORE/$2/data")" ]]; then emit empty "$1"; else emit mounted "$1"; fi
}
# [T2] dir key -> 0 when dir/node_modules is the VM-local one (spec K6, K9)
attach_pkg() {
  local dir=$1 key=$2 nm="$1/node_modules" data="$STORE/$2/data"
  if [[ -L "$nm" ]]; then warn "$nm is a symlink; it stays shared with the host"; emit skipped "$dir"; return 1; fi
  if [[ ! -d "$data" ]] && ! priv mkstore "$key" "$dir"; then warn "could not create the store for $dir"; return 1; fi
  if [[ -d "$nm" && "$(ino "$nm")" == "$(ino "$data")" ]]; then report_pkg "$dir" "$key"; return 0; fi
  if [[ -n "$(rows "$key")" ]] && ! priv unmount "$key"; then warn "a stale mount for $dir is still there; not mounting over it"; return 1; fi
  if [[ ! -d "$nm" ]] && ! mkdir -- "$nm"; then warn "could not create $nm"; return 1; fi
  if ! priv mount "$key"; then warn "could not mount a VM-local node_modules for $dir"; return 1; fi
  report_pkg "$dir" "$key"
}
# [T2]
attach_all() {
  local i
  for i in "${!PKG_DIRS[@]}"; do attach_pkg "${PKG_DIRS[$i]}" "${PKG_KEYS[$i]}" || PARTIAL=1; done
}
# [T2] spec K10: 1 (partial) wins over 3 (reclaim aborted)
finish() {
  if [[ $PARTIAL -ne 0 ]]; then exit "$EXIT_PARTIAL"; fi
  if [[ $ABORT_ALL -ne 0 || ${#ABORT_WT[@]} -ne 0 ]]; then exit "$EXIT_RECLAIM_ABORTED"; fi
  exit 0
}
# [T3] path -> 0 when the worktree that owns it has its reclaim aborted
under_aborted() {
  local o
  o=$(owner_of "$1")
  [[ -n "$o" && -n "${ABORT_WT[$(key_of "$o")]:-}" ]]
}
# [T3] path -> 0 when a .git sits between its owning worktree and the path: a nested repository's store, which
# this repository's ls-files never lists
in_nested_repo() {
  local o d
  o=$(owner_of "$1"); d=$1
  while [[ -n "$o" && "$d" != "$o" && "$d" == "$o/"* ]]; do
    if [[ -e "$d/.git" ]]; then return 0; fi
    d=$(dirname -- "$d")
  done
  return 1
}
# [T3] root: delete the stores whose package is no longer wanted (spec K2, K3)
reclaim() {
  local root=$1 d key p
  for d in "$STORE"/*; do
    key=${d##*/}
    if [[ ! "$key" =~ ^[0-9a-f]{16}$ || ! -d "$d" || -L "$d" ]]; then continue; fi
    if [[ ! -e "$d/path" ]]; then   # an interrupted mkstore leaves an empty directory: quiet
      if [[ -e "$d/data" ]]; then warn "a store without a record is kept: $d"; fi
      continue
    fi
    if [[ -L "$d/path" ]] || ! IFS= read -r p <"$d/path"; then warn "an unreadable record is kept: $d"; continue; fi
    if [[ "$p" != "$root" && "$p" != "$root/"* ]]; then continue; fi   # another repository's store
    if has_ctrl "$p" || [[ "$(key_of "$p")" != "$key" ]]; then warn "an inconsistent record is kept: $d"; continue; fi
    if [[ -n "${WANT[$key]:-}" ]] || under_aborted "$p" || in_nested_repo "$p"; then continue; fi
    if ! { priv unmount "$key" && priv rmstore "$key"; }; then warn "could not reclaim the VM-local node_modules of $p"; PARTIAL=1; fi
  done
}
# [T2] repo (the reclaim line is [T3])
cmd_sync() {
  local wt
  require_vm || exit 0
  start
  ROOT=$(canon "$1") || { warn "the repository is not visible: $1"; exit "$EXIT_RECLAIM_ABORTED"; }
  lock "$EXIT_PARTIAL" "$EXIT_LOCKED"
  load_worktrees "$ROOT" || ABORT_ALL=1
  for wt in "${WORKTREES[@]}"; do collect_packages "$wt"; done
  attach_all
  if [[ $ABORT_ALL -eq 0 ]]; then reclaim "$ROOT"; else warn "kept every VM-local node_modules of $ROOT this time"; fi
  finish
}
# [T2] path -> WT / ROOT when the path passes the worktree rule of spec K6 (membership in the list is checked
# under the lock by the caller)
resolve_worktree() {
  local common
  WT=$(canon "$1") || return 1
  common=$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  ROOT=$(canon "$(dirname -- "$common")") || return 1
  ! has_ctrl "$WT" && [[ "$WT" == "$ROOT" || "$WT" == "$ROOT/.git/worktree/"* ]]
}
# [T2] worktree
cmd_attach() {
  local rc
  require_vm || exit 0
  start
  resolve_worktree "$1" || { warn "not a worktree of an agent-vm repository: $1"; exit "$EXIT_USAGE"; }
  lock "$EXIT_PARTIAL" "$EXIT_LOCKED"
  rc=0; load_worktrees "$ROOT" || rc=$?
  if [[ $rc -eq 1 ]]; then warn "could not read the worktree list of $ROOT"; exit "$EXIT_PARTIAL"; fi
  [[ -n "${IS_WT[$(key_of "$WT")]:-}" ]] || { warn "$WT is not in the worktree list of $ROOT"; exit "$EXIT_USAGE"; }
  collect_packages "$WT"
  attach_all
  # attach never reclaims, so a kept store alone is no failure; a package never considered is
  if [[ $MISSED -ne 0 ]]; then PARTIAL=1; fi
  ABORT_WT=()
  finish
}
# [T4] key -> 0 when no path lookup reaches this store any more
detach() {
  if is_test_store && [[ "${AGENT_VM_NM_TEST_FAIL_UNMOUNT:-}" == 1 ]]; then return 1; fi   # test-only fault
  priv unmount "$1"
}
# [T4] worktree command...: detach, run, then delete or re-attach, all under the lock (spec K7)
cmd_remove() {
  local arg=$1 d key p i status rc
  local -a keys=() dirs=()
  shift
  require_vm || exec "$@"   # outside a VM there is nothing to detach
  # Until the command runs, an unexpected failure or an interrupt ends in 70, never in a status the caller could
  # take for the command's own. Rows detached by then come back with the next sync.
  set -o errtrace; trap 'exit "$EXIT_RM_FAILED"' ERR INT TERM
  start
  resolve_worktree "$arg" || { warn "not a worktree of an agent-vm repository: $arg"; exit "$EXIT_USAGE"; }
  if [[ "$WT" == "$ROOT" ]]; then warn "refusing to remove the main worktree $WT"; exit "$EXIT_USAGE"; fi
  lock "$EXIT_RM_FAILED" "$EXIT_RM_LOCKED"
  rc=0; load_worktrees "$ROOT" || rc=$?
  if [[ $rc -eq 1 ]]; then warn "could not read the worktree list of $ROOT; $WT is kept"; exit "$EXIT_RM_FAILED"; fi
  [[ -n "${IS_WT[$(key_of "$WT")]:-}" ]] || { warn "$WT is not in the worktree list of $ROOT"; exit "$EXIT_USAGE"; }
  for d in "$STORE"/*; do
    key=${d##*/}
    [[ "$key" =~ ^[0-9a-f]{16}$ && -f "$d/path" && ! -L "$d/path" ]] || continue
    IFS= read -r p <"$d/path" || continue
    if [[ "$(owner_of "$p")" == "$WT" && "$(key_of "$p")" == "$key" ]]; then keys+=("$key"); dirs+=("$p"); fi
  done
  for key in "${keys[@]}"; do
    if detach "$key"; then continue; fi
    warn "could not detach the VM-local node_modules under $WT; the worktree is kept and the command did not run"
    for i in "${!dirs[@]}"; do attach_pkg "${dirs[$i]}" "${keys[$i]}" >/dev/null || warn "could not re-attach ${dirs[$i]}"; done
    exit "$EXIT_RM_FAILED"
  done
  trap - ERR INT TERM
  if "$@" 9>&-; then status=0; else status=$?; fi
  if [[ $status -eq 0 && ! -e "$WT" ]]; then
    for key in "${keys[@]}"; do priv rmstore "$key" || warn "could not delete the store $key; the next sync deletes it"; done
  else
    if [[ $status -eq 0 ]]; then warn "the command succeeded but $WT is still there; its VM-local node_modules are re-attached"; fi
    for i in "${!dirs[@]}"; do attach_pkg "${dirs[$i]}" "${keys[$i]}" >/dev/null || warn "could not re-attach ${dirs[$i]}"; done
  fi
  exit "$status"
}

# [T1] (the sync / attach / remove branches reach their T2 / T4 functions)
main() {
  case "${1:-}" in
    --contract) [[ $# -eq 1 ]] || usage; printf '%s\n' "$CONTRACT" ;;
    sync) [[ $# -eq 2 ]] || usage; cmd_sync "$2" ;;
    attach) [[ $# -eq 2 ]] || usage; cmd_attach "$2" ;;
    remove) [[ $# -ge 4 && "$3" == -- ]] || usage; local wt=$2; shift 3; cmd_remove "$wt" "$@" ;;
    *) usage ;;
  esac
}
main "$@"
```

## テストのコード: `tests/agent-vm/run-node-modules.sh`

```bash
#!/usr/bin/env bash
# Integration tests for agent-vm-node-modules: real bind mounts under sudo, in the throwaway test store root.
# Linux with passwordless sudo only (the CI runner, or a throwaway agent-vm machine); skipped elsewhere.
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
HELPER="$REPO_ROOT/home/dot_local/bin/executable_agent-vm-node-modules"
if [[ "$(uname -s)" != Linux ]] || ! sudo -n true 2>/dev/null; then echo "skipped: needs Linux and passwordless sudo"; exit 0; fi
TMP_BASE=$(mktemp -d -t agent-vm-nm-XXXXXX)
# The test store root lets the helper stand in for a VM without /etc/agent-vm (the CI runner has none).
export AGENT_VM_NM_STORE=/var/lib/agent-vm-test/node_modules AGENT_VM_NM_ASSUME_VM=1 RESULTS_FILE="$TMP_BASE/results"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
: >"$RESULTS_FILE"
# shellcheck source=tests/agent-vm/lib.sh
. "$TEST_DIR/lib.sh"
teardown() {
  local mp
  while IFS= read -r mp; do sudo -n umount -l -- "$mp" || true; done < <(awk '$4 ~ /agent-vm-test/ {print $5}' /proc/self/mountinfo)
  sudo -n rm -rf /var/lib/agent-vm-test
}
trap 'teardown; rm -rf "$TMP_BASE"' EXIT

helper() { bash "$HELPER" "$@"; }
key() { printf '%s' "$1" | sha256sum | cut -c1-16; }
is_mounted() { [[ -d "$1/node_modules" && "$(stat -c %d:%i "$1/node_modules")" == "$(stat -c %d:%i "$AGENT_VM_NM_STORE/$(key "$1")/data" 2>/dev/null)" ]]; }
mount_rows() { awk -v k="$(key "$1")" '$4 ~ k {n++} END {print n+0}' /proc/self/mountinfo; }
store_count() { find "$AGENT_VM_NM_STORE" -mindepth 1 -maxdepth 1 -regextype posix-extended -regex '.*/[0-9a-f]{16}' | wc -l | tr -d ' '; }
check_mounted() { if is_mounted "$1"; then record "PASS $2"; else record "FAIL $2"; fi; }
check_not_mounted() { if is_mounted "$1"; then record "FAIL $2"; else record "PASS $2"; fi; }
check_store() { if [[ -d "$AGENT_VM_NM_STORE/$(key "$1")" ]]; then record "PASS $2"; else record "FAIL $2"; fi; }
check_no_store() { if [[ -d "$AGENT_VM_NM_STORE/$(key "$1")" ]]; then record "FAIL $2"; else record "PASS $2"; fi; }
check_absent() { if [[ -e "$1" ]]; then record "FAIL $2"; else record "PASS $2"; fi; }
mk_repo() { # dir: a git repository with a root package and packages/a, packages/b
  local r=$1
  mkdir -p "$r/packages/a" "$r/packages/b"; git -C "$r" init -q
  printf '{"name":"root","private":true}\n' >"$r/package.json"
  printf '{"name":"a"}\n' >"$r/packages/a/package.json"
  printf '{"name":"b"}\n' >"$r/packages/b/package.json"
  printf 'node_modules\n' >"$r/.gitignore"
  git -C "$r" add -A; git -C "$r" commit -qm init
}
fail_git() { # pattern -> a directory holding a git that fails when its arguments contain pattern
  mkdir -p "$TMP_ROOT/bin"
  printf '#!/bin/sh\ncase "$*" in *"%s"*) exit 1 ;; esac\nexec "%s" "$@"\n' "$1" "$(command -v git)" >"$TMP_ROOT/bin/git"
  chmod +x "$TMP_ROOT/bin/git"
  printf '%s' "$TMP_ROOT/bin"
}

# --- T1 ---
test_contract_prints_1() { assert_eq 1 "$(helper --contract)" "contract version"; }
test_usage_error_exits_64() { assert_status 64 "unknown subcommand" -- helper bogus; }
test_store_root_is_one_of_two_fixed_values() {
  assert_status 64 "an arbitrary store root is refused" -- env AGENT_VM_NM_STORE=/tmp/elsewhere bash "$HELPER" sync /
}
test_outside_a_vm_does_nothing() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  if [[ -e /etc/agent-vm ]]; then record "SKIP outside-a-VM checks (this is an agent-vm machine)"; return 0; fi
  assert_status 0 "exit 0 without the marker" -- env -u AGENT_VM_NM_ASSUME_VM bash "$HELPER" sync "$r"
  check_no_store "$r" "nothing created without the marker"
  assert_status 0 "the stand-in is ignored for the real store root" -- env -u AGENT_VM_NM_STORE bash "$HELPER" sync "$r"
  check_absent "/var/lib/agent-vm/node_modules/$(key "$r")" "nothing created in the real store root"
}

# --- T2 ---
test_sync_mounts_each_package() {
  local r="$TMP_ROOT/r" out; mk_repo "$r"
  out=$(helper sync "$r")
  check_mounted "$r" "root package mounted"
  check_mounted "$r/packages/a" "packages/a mounted"
  check_mounted "$r/packages/b" "packages/b mounted"
  assert_contains "$out" "$(printf 'empty\t%s' "$r")" "an empty root is reported"
  assert_contains "$out" "$(printf 'mounted\t%s' "$r/packages/a")" "a non-root package is reported as mounted"
  touch "$r/node_modules/marker"
  if [[ -e "$AGENT_VM_NM_STORE/$(key "$r")/data/marker" ]]; then record "PASS writes land in the store"; else record "FAIL writes land in the store"; fi
  out=$(helper sync "$r")
  assert_contains "$out" "$(printf 'mounted\t%s' "$r")" "a filled root is reported as mounted"
}
test_sync_is_idempotent() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  helper sync "$r" >/dev/null; helper sync "$r" >/dev/null
  assert_eq 1 "$(mount_rows "$r")" "one mount row after two syncs"
}
test_stale_mount_is_restored() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  helper sync "$r" >/dev/null
  sudo -n umount -l "$r/node_modules"
  helper sync "$r" >/dev/null
  check_mounted "$r" "a lost mount is restored"
}
test_symlinked_node_modules_is_skipped() {
  local r="$TMP_ROOT/r" out; mk_repo "$r"
  ln -s "$TMP_ROOT" "$r/packages/a/node_modules"
  assert_status 1 "a symlinked node_modules makes the run partial" -- helper sync "$r"
  out=$(helper sync "$r" 2>/dev/null || true)
  assert_contains "$out" "$(printf 'skipped\t%s' "$r/packages/a")" "skipped record"
  assert_eq 0 "$(mount_rows "$r/packages/a")" "nothing mounted through the symlink"
}
test_control_characters_make_the_run_partial() {
  local r="$TMP_ROOT/r" bad; mk_repo "$r"; bad="$r/packages/x"$'\n'"y"
  mkdir -p "$bad"; printf '{}\n' >"$bad/package.json"; git -C "$r" add -A; git -C "$r" commit -qm bad
  assert_status 1 "a package path with a newline makes the run partial" -- helper sync "$r"
  assert_eq 3 "$(store_count)" "only the three ordinary packages have stores"
}
test_symlinked_package_json_is_not_a_package() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  mkdir -p "$r/packages/c"; ln -s ../a/package.json "$r/packages/c/package.json"; git -C "$r" add -A; git -C "$r" commit -qm c
  assert_status 0 "sync" -- helper sync "$r"
  check_no_store "$r/packages/c" "no store behind a symlinked package.json"
}
test_worktree_outside_repo_is_ignored() {
  local r="$TMP_ROOT/r" err; mk_repo "$r"
  git -C "$r" worktree add -q "$TMP_ROOT/outside" -b outside
  err=$(helper sync "$r" 2>&1 >/dev/null || true)
  assert_contains "$err" "outside the repository" "the outside worktree is reported"
  check_no_store "$TMP_ROOT/outside" "no store for the outside worktree"
}
test_worktree_under_dot_git_worktree_is_mounted() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  git -C "$r" worktree add -q "$r/.git/worktree/feat" -b feat
  helper sync "$r" >/dev/null
  check_mounted "$r/.git/worktree/feat" "the worktree's root package"
  check_mounted "$r/.git/worktree/feat/packages/a" "the worktree's packages/a"
}
test_package_json_under_node_modules_is_not_a_package() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  rm "$r/.gitignore"; mkdir -p "$r/node_modules/dep"; printf '{}\n' >"$r/node_modules/dep/package.json"
  helper sync "$r" >/dev/null
  check_no_store "$r/node_modules/dep" "no store for a dependency's package.json"
}
test_non_js_repo_is_silent() {
  local r="$TMP_ROOT/r" out; mkdir -p "$r"; git -C "$r" init -q; printf 'x\n' >"$r/README"; git -C "$r" add -A; git -C "$r" commit -qm init
  out=$(helper sync "$r" 2>&1)
  assert_eq "" "$out" "no output for a repository without package.json"
  assert_status 0 "exit 0" -- helper sync "$r"
  check_absent "$r/node_modules" "no node_modules created"
}
test_cap_falls_back_to_the_root_package() {
  local r="$TMP_ROOT/r" i; mk_repo "$r"
  for i in $(seq 1 501); do mkdir -p "$r/p/$i"; printf '{}\n' >"$r/p/$i/package.json"; done
  assert_status 3 "over the cap (501 > 500), reclaim is aborted" -- helper sync "$r"
  check_mounted "$r" "the root package is mounted"
  check_not_mounted "$r/p/1" "other packages are not mounted"
}
test_attach_mounts_one_worktree() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  git -C "$r" worktree add -q "$r/.git/worktree/feat" -b feat
  assert_status 0 "attach" -- helper attach "$r/.git/worktree/feat"
  check_mounted "$r/.git/worktree/feat" "the attached worktree"
  check_not_mounted "$r" "the main worktree is left to sync"
}
test_attach_rejects_a_path_that_is_not_a_listed_worktree() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  git -C "$r" worktree add -q "$r/.git/worktree/feat" -b feat
  assert_status 64 "a directory inside a worktree is refused" -- helper attach "$r/.git/worktree/feat/packages"
}
test_attach_exits_1_when_ls_files_fails() {
  local r="$TMP_ROOT/r" bin; mk_repo "$r"; bin=$(fail_git ls-files)
  git -C "$r" worktree add -q "$r/.git/worktree/feat" -b feat
  assert_status 1 "attach reports that nothing could be mounted" -- env PATH="$bin:$PATH" bash "$HELPER" attach "$r/.git/worktree/feat"
}
test_attach_keeping_stores_exits_0() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat
  helper attach "$wt" >/dev/null
  rm "$wt/package.json" "$wt/packages/a/package.json" "$wt/packages/b/package.json"
  assert_status 0 "zero packages with stores is no failure for attach" -- helper attach "$wt"
}
test_attach_ignores_an_unresolvable_sibling() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  git -C "$r" worktree add -q "$r/.git/worktree/gone" -b gone
  git -C "$r" worktree add -q "$r/.git/worktree/feat" -b feat
  mv "$r/.git/worktree/gone" "$TMP_ROOT/gone.off"
  assert_status 0 "attach goes on while a sibling worktree is missing" -- helper attach "$r/.git/worktree/feat"
  check_mounted "$r/.git/worktree/feat" "the attached worktree"
}
test_lock_timeout_exits_2() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  helper sync "$r" >/dev/null
  ( flock 8; sleep 5 ) 8<"$AGENT_VM_NM_STORE/.lock" &
  sleep 1
  assert_status 2 "lock held elsewhere" -- env AGENT_VM_NM_LOCK_WAIT=1 bash "$HELPER" sync "$r"
  wait
}

# --- T3 ---
test_removed_package_is_reclaimed() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  helper sync "$r" >/dev/null
  rm "$r/packages/b/package.json"
  assert_status 0 "sync after removing a package" -- helper sync "$r"
  check_no_store "$r/packages/b" "the removed package's store is gone"
  assert_eq 0 "$(mount_rows "$r/packages/b")" "and its mount"
  check_store "$r/packages/a" "other stores stay"
}
test_ls_files_failure_keeps_stores() {
  local r="$TMP_ROOT/r" bin; mk_repo "$r"; bin=$(fail_git ls-files)
  helper sync "$r" >/dev/null
  rm "$r/packages/b/package.json"
  assert_status 3 "reclaim aborted" -- env PATH="$bin:$PATH" bash "$HELPER" sync "$r"
  check_store "$r/packages/b" "the store survives a failing ls-files"
}
test_zero_packages_with_stores_keeps_them() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  helper sync "$r" >/dev/null
  rm "$r/package.json" "$r/packages/a/package.json" "$r/packages/b/package.json"
  assert_status 3 "reclaim aborted" -- helper sync "$r"
  check_store "$r" "the root store survives"
}
test_worktree_list_failure_keeps_stores() {
  local r="$TMP_ROOT/r" bin; mk_repo "$r"; bin=$(fail_git "worktree list")
  helper sync "$r" >/dev/null
  rm "$r/packages/b/package.json"
  assert_status 3 "reclaim aborted for the repository" -- env PATH="$bin:$PATH" bash "$HELPER" sync "$r"
  check_store "$r/packages/b" "the store survives a failing worktree list"
}
test_list_without_the_main_worktree_keeps_stores() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat
  helper sync "$r" >/dev/null
  rm "$wt/packages/b/package.json"
  assert_status 3 "a linked worktree given as the repository aborts reclaim" -- helper sync "$wt"
  check_store "$wt/packages/b" "the worktree's store survives"
  check_store "$r" "the main worktree's store survives"
}
test_invisible_repository_keeps_stores() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  helper sync "$r" >/dev/null
  mv "$r/.git" "$r/.git.off"
  assert_status 3 "reclaim aborted" -- helper sync "$r"
  check_store "$r" "the root store survives"
}
test_main_abort_does_not_block_a_worktree() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat
  helper sync "$r" >/dev/null
  rm "$r/package.json" "$r/packages/a/package.json" "$r/packages/b/package.json"
  rm "$wt/packages/b/package.json"
  assert_status 3 "the main worktree's reclaim is aborted" -- helper sync "$r"
  check_store "$r/packages/a" "the main worktree's stores are kept"
  check_no_store "$wt/packages/b" "the nested worktree's removed package is reclaimed"
}
test_partial_wins_over_reclaim_abort() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat
  helper sync "$r" >/dev/null
  rm "$wt/package.json" "$wt/packages/a/package.json" "$wt/packages/b/package.json"
  sudo -n umount -l "$r/packages/a/node_modules"; rmdir "$r/packages/a/node_modules"; ln -s "$TMP_ROOT" "$r/packages/a/node_modules"
  assert_status 1 "1 wins over 3" -- helper sync "$r"
}
test_inconsistent_records_are_kept() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  helper sync "$r" >/dev/null
  sudo -n mkdir "$AGENT_VM_NM_STORE/zz" "$AGENT_VM_NM_STORE/0123456789abcdef" "$AGENT_VM_NM_STORE/fedcba9876543210"
  printf '%s\n' "$r/elsewhere" | sudo -n tee "$AGENT_VM_NM_STORE/0123456789abcdef/path" >/dev/null
  printf '/etc\n' | sudo -n tee "$AGENT_VM_NM_STORE/fedcba9876543210/path" >/dev/null
  helper sync "$r" >/dev/null 2>&1 || true
  if [[ -d "$AGENT_VM_NM_STORE/zz" && -d "$AGENT_VM_NM_STORE/0123456789abcdef" && -d "$AGENT_VM_NM_STORE/fedcba9876543210" ]]; then
    record "PASS foreign and inconsistent store dirs kept"; else record "FAIL foreign and inconsistent store dirs kept"; fi
}
test_nested_repository_store_is_kept() {
  local r="$TMP_ROOT/r" b; mk_repo "$r"; b="$r/vendor/B"; mk_repo "$b"
  helper sync "$b" >/dev/null
  assert_status 0 "sync of the outer repository" -- helper sync "$r"
  check_store "$b/packages/a" "the nested repository's store is kept"
  check_mounted "$b/packages/a" "and stays mounted"
}
test_unresolvable_worktree_keeps_stores() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat
  helper sync "$r" >/dev/null
  sudo -n umount -l "$wt/node_modules" "$wt/packages/a/node_modules" "$wt/packages/b/node_modules"
  mv "$wt" "$TMP_ROOT/feat.off"; rm "$r/packages/b/package.json"
  assert_status 3 "reclaim aborted while a listed worktree is missing" -- helper sync "$r"
  check_store "$wt" "the missing worktree's store is kept"
  check_store "$r/packages/b" "and so is the main worktree's"
}

# --- T4 ---
test_remove_reclaims_after_success() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat; helper sync "$r" >/dev/null
  assert_status 0 "remove succeeds" -- helper remove "$wt" -- git -C "$r" worktree remove -- "$wt"
  check_absent "$wt" "the worktree is gone"
  check_no_store "$wt" "its store is gone"
  assert_eq 0 "$(mount_rows "$wt")" "its mount is gone"
  check_mounted "$r" "the main worktree keeps its mount"
}
test_remove_failure_reattaches() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat; helper sync "$r" >/dev/null
  assert_status 1 "the command's status is returned" -- helper remove "$wt" -- false
  check_mounted "$wt" "the worktree is mounted again"
}
test_remove_matches_the_path_boundary() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  git -C "$r" worktree add -q "$r/.git/worktree/feat" -b feat
  git -C "$r" worktree add -q "$r/.git/worktree/feat2" -b feat2
  helper sync "$r" >/dev/null
  helper remove "$r/.git/worktree/feat" -- git -C "$r" worktree remove -- "$r/.git/worktree/feat"
  check_mounted "$r/.git/worktree/feat2" "feat2 keeps its mount"
}
test_remove_usage_error_exits_64() {
  assert_status 64 "remove without a command" -- helper remove "$TMP_ROOT" --
  assert_status 64 "remove without --" -- helper remove "$TMP_ROOT" touch "$TMP_ROOT/ran"
  check_absent "$TMP_ROOT/ran" "the command did not run"
}
test_remove_refuses_the_main_worktree() {
  local r="$TMP_ROOT/r"; mk_repo "$r"; helper sync "$r" >/dev/null
  assert_status 64 "the main worktree is refused" -- helper remove "$r" -- touch "$TMP_ROOT/ran"
  check_absent "$TMP_ROOT/ran" "the command did not run"
  check_mounted "$r" "the main worktree keeps its mount"
}
test_remove_exits_70_when_it_cannot_detach() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat; helper sync "$r" >/dev/null
  assert_status 70 "a detach failure" -- env AGENT_VM_NM_TEST_FAIL_UNMOUNT=1 bash "$HELPER" remove "$wt" -- touch "$TMP_ROOT/ran"
  check_absent "$TMP_ROOT/ran" "the command did not run"
  check_mounted "$wt" "the worktree keeps its mount"
}
test_remove_ignores_an_unresolvable_sibling() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$r/.git/worktree/gone" -b gone
  git -C "$r" worktree add -q "$wt" -b feat; helper sync "$r" >/dev/null
  sudo -n umount -l "$r/.git/worktree/gone/node_modules" "$r/.git/worktree/gone/packages/a/node_modules" "$r/.git/worktree/gone/packages/b/node_modules"
  mv "$r/.git/worktree/gone" "$TMP_ROOT/gone.off"
  assert_status 0 "remove goes on while a sibling worktree is missing" -- helper remove "$wt" -- git -C "$r" worktree remove -- "$wt"
  check_no_store "$wt" "the removed worktree's store is gone"
  check_store "$r/.git/worktree/gone" "the missing sibling's store is kept"
}
test_remove_keeps_the_store_when_the_worktree_stays() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat; helper sync "$r" >/dev/null
  assert_status 0 "the command's status is returned" -- helper remove "$wt" -- true
  check_store "$wt" "the store is kept"
  check_mounted "$wt" "and mounted again"
}
test_remove_lock_timeout_exits_71() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat; helper sync "$r" >/dev/null
  ( flock 8; sleep 5 ) 8<"$AGENT_VM_NM_STORE/.lock" &
  sleep 1
  assert_status 71 "lock held elsewhere" -- env AGENT_VM_NM_LOCK_WAIT=1 bash "$HELPER" remove "$wt" -- touch "$TMP_ROOT/ran"
  check_absent "$TMP_ROOT/ran" "the command did not run"
  wait
}

# Each test runs as an asynchronous subshell, which keeps set -e in force inside it.
for t in $(declare -F | awk '{print $3}' | grep '^test_'); do
  ( TMP_ROOT=$(mktemp -d "$TMP_BASE/XXXXXX"); export TMP_ROOT; "$t" ) </dev/null &
  wait $! || record "FAIL $t (test aborted)"
  teardown
done
failed=$(grep -c '^FAIL' "$RESULTS_FILE" || true)
grep '^FAIL' "$RESULTS_FILE" || true
printf '%d run, %d failed\n' "$(wc -l <"$RESULTS_FILE" | tr -d ' ')" "$failed"
[[ "$failed" -eq 0 ]]
```

## ISO 25010 具体テストケース

### 機能適合性（機能正確性）

- **入力**: ルートと `packages/a`、`packages/b` を持つ repo で `sync` する。
  - **期待**: 3 つの `node_modules` の device:inode が、それぞれの保存先の `data` と一致する。
  - **期待**: ルートは `empty`、他は `mounted` と報告される。`node_modules` に書いたファイルが `data` に現れる。
  - テスト: `test_sync_mounts_each_package`
- **入力**: 同じ repo で `sync` を 2 回 → **期待**: mountinfo の行が 1 本（`test_sync_is_idempotent`）。
- **入力**: `.git/worktree/feat` の worktree を追加して `sync` / `attach` する。
  - **期待**: その worktree のパッケージが mount される。
  - **期待**: `attach` は終了コード 0 で、メインの worktree に触れない。
  - テスト: `test_worktree_under_dot_git_worktree_is_mounted`、`test_attach_mounts_one_worktree`
- **入力**: `remove <wt> -- git worktree remove <wt>` → **期待**: 終了コード 0。worktree、保存先、mount が無い。メインの mount は残る（`test_remove_reclaims_after_success`）。

### 信頼性（障害許容性・回復性）

- **入力**: mount を `umount -l` で外してから `sync` → **期待**: 張り直される（`test_stale_mount_is_restored`）。
- **入力**: `packages/b/package.json` を消して `sync` → **期待**: 終了コード 0。`packages/b` の保存先と mount だけが消える（`test_removed_package_is_reclaimed`）。
- **入力**: 一覧を信頼できない状態で `packages/b/package.json` などを消して `sync` する（ls-files の失敗、`worktree list` の失敗、メインが先頭に無い一覧、`.git` が見えない）。
  - **期待**: 終了コード 3 で、保存先が残る。
  - テスト: `test_ls_files_failure_keeps_stores`、`test_worktree_list_failure_keeps_stores`、`test_list_without_the_main_worktree_keeps_stores`、`test_invisible_repository_keeps_stores`
- **入力**: すべての `package.json` を消して `sync` → **期待**: 終了コード 3、保存先が残る（`test_zero_packages_with_stores_keeps_them`）。
- **入力**: メインの worktree だけ中止条件を満たし、入れ子の worktree ではパッケージを 1 つ消して `sync` する。
  - **期待**: 終了コード 3。メインの保存先は残り、worktree の消えたパッケージの保存先は消える。
  - テスト: `test_main_abort_does_not_block_a_worktree`
- **入力**: 部分失敗（symlink の `node_modules`）と回収の中止が同時に起きる → **期待**: 終了コード 1（`test_partial_wins_over_reclaim_abort`）。
- **入力**: `package.json` の無い repo で `sync` → **期待**: 出力なし、終了コード 0、`node_modules` を作らない（`test_non_js_repo_is_silent`）。
- **入力**: パッケージ 501 件（上限 500 を 1 件超える境界）で `sync` → **期待**: 終了コード 3、ルートだけ mount（`test_cap_falls_back_to_the_root_package`）。
- **入力**: ls-files が失敗する worktree を `attach` → **期待**: 終了コード 1（`test_attach_exits_1_when_ls_files_fails`）。
- **入力**: `remove <wt> -- false` → **期待**: 終了コード 1、worktree が再び mount される（`test_remove_failure_reattaches`）。
- **入力**: 外すのが失敗する（`AGENT_VM_NM_TEST_FAIL_UNMOUNT=1`）状態で `remove` → **期待**: 終了コード 70、コマンドは実行されず、mount が残る（`test_remove_exits_70_when_it_cannot_detach`）。
- **入力**: 別プロセスが lock を持つ間に `AGENT_VM_NM_LOCK_WAIT=1` で実行する。
  - **期待**: `sync` は終了コード 2。
  - **期待**: `remove` は終了コード 71 で、コマンドは実行されない。
  - テスト: `test_lock_timeout_exits_2`、`test_remove_lock_timeout_exits_71`

### セキュリティ（完全性）

- **入力**: repo の外（`$TMP_ROOT/outside`）に worktree を作って `sync` → **期待**: 標準エラーに「outside the repository」が出て、その worktree の保存先は無い（`test_worktree_outside_repo_is_ignored`）。
- **入力**: `packages/a/node_modules` を symlink にして `sync` → **期待**: 終了コード 1、`skipped` レコード、その key の mount 行が 0（`test_symlinked_node_modules_is_skipped`）。
- **入力**: パスに改行を含むパッケージ → **期待**: 終了コード 1、保存先は通常の 3 つだけ（`test_control_characters_make_the_run_partial`）。
- **入力**: symlink の `package.json` を持つ `packages/c` → **期待**: 保存先を作らない（`test_symlinked_package_json_is_not_a_package`）。
- **入力**: ignore されていない `node_modules/dep/package.json` → **期待**: そのディレクトリの保存先を作らない（`test_package_json_under_node_modules_is_not_a_package`）。
- **入力**: 保存先に次の 3 つを置いて `sync` する。
  - `zz`（key の形でない）
  - `path` が repo の中で key と合わない `0123456789abcdef`
  - `path` が `/etc` の `fedcba9876543210`
  - **期待**: どれも消えない（`test_inconsistent_records_are_kept`）。
- **入力**: `AGENT_VM_NM_STORE=/tmp/elsewhere` → **期待**: 終了コード 64、何もしない（`test_store_root_is_one_of_two_fixed_values`）。
- **入力**: `/etc/agent-vm` の無い機械で、`AGENT_VM_NM_ASSUME_VM` を外して `sync`、または保存先の根を本番にして `sync` する。
  - **期待**: どちらも終了コード 0 で、保存先を作らない。
  - テスト: `test_outside_a_vm_does_nothing`。agent-vm machine 上では SKIP と記録する。
- **入力**: worktree の中のディレクトリを `attach` → **期待**: 終了コード 64（`test_attach_rejects_a_path_that_is_not_a_listed_worktree`）。
- **入力**: メインの worktree を `remove` → **期待**: 終了コード 64、コマンドは実行されず、mount が残る（`test_remove_refuses_the_main_worktree`）。
- **入力**: `feat` と `feat2` の worktree で `remove feat` → **期待**: `feat2` の mount が残る（`test_remove_matches_the_path_boundary`）。

### 互換性（共存性）

- **入力**: chezmoi の VM データで `managed` → **期待**: `.local/bin/agent-vm-node-modules` を含む。host のデータでは含まない（`test_node_modules_helper_is_vm_only`）。VM の管理対象が fixture と一致する（`test_vm_manages_exactly_the_allowlist`）。
- **対象外**: macOS での実行（ヘルパーは Linux 専用で、テストは macOS で skip する）。

### 追加のケース（Round 2 の指摘から）

- **入力**: repo の中の別 repo（`vendor/B`）を先に `sync` し、外側の repo を `sync` する → **期待**: 終了コード 0。`vendor/B` の保存先と mount が残る（`test_nested_repository_store_is_kept`）。
- **入力**: 一覧にある worktree のディレクトリを移動し、メインのパッケージを 1 つ消して `sync` する → **期待**: 終了コード 3。どちらの保存先も残る（`test_unresolvable_worktree_keeps_stores`）。
- **入力**: パッケージ 0 件で保存先がある worktree を `attach` → **期待**: 終了コード 0（`test_attach_keeping_stores_exits_0`）。
- 空の一覧は、`load_worktrees` で先頭（メイン）が無い場合と同じ経路を通る。`test_list_without_the_main_worktree_keeps_stores` が、その経路を確かめる。

### テストしない経路（対象外と理由）

- **mount 後の検証の失敗と巻き戻し（K6 の 5）**
  - 失敗を注入するには、root の perl に手を入れる仕掛けが要る。sudo の `secure_path` があるので、PATH で `mount` を差し替えることもできない。そうした仕掛けを本番コードに足すと、root で動く面が広がる。
  - 成功する経路は、本物の mount で device:inode まで確かめる（`test_sync_mounts_each_package`）。
  - 前提（V1、V2、root 欄）は T0 の関門で確かめる。
- **外した後も行が残る場合（K9）**: `sync` は張らずに 1 を返す。これも `unmount` の失敗を root 側に注入する仕掛けが要るので、テストしない。`remove` の外す失敗は、bash 側の `detach` で注入する（`AGENT_VM_NM_TEST_FAIL_UNMOUNT`）。

## Round 4 からの変更

- 契約の文面をコードに合わせた。
  - 1 の原因を列挙した（保存先を作れない、古い mount が残っている、を追加）。
  - `sync` の 3 が 1 の原則から外れる範囲を書いた。
  - メインが先頭に無い場合と解決できない worktree がある場合は、残りの worktree に張ることを書いた。
  - レコードを出さずに 1 になる場合があることを書いた。
  - `remove` の stdout には、コマンドの出力がそのまま流れることを書いた。
  - 引数の誤りと不正な保存先の根は、VM の外でも 64 になることを書いた（`--contract` も含む）。
  - 70 のうち、張り直すのは外す処理が失敗した場合だけであることを書いた。
- テストに `test_remove_usage_error_exits_64` を足した。

## Round 3 からの変更

- `load_worktrees` の戻り値を分けた。1 は一覧が使えない、2 は一覧は使えるが解決できない worktree がある。`sync` はどちらでも回収を中止し、`attach` と `remove` は 2 なら続行する。テストに `test_attach_ignores_an_unresolvable_sibling`、`test_remove_ignores_an_unresolvable_sibling` を足した。
- 契約の表に、次を書いた。
  - 1 と 3 の意味と、`sync` の ls-files の失敗と上限超過を 3 とする例外
  - 共通の終了経路（不正な保存先の根、準備の失敗）
  - `remove` の使い方の誤り（64）
  - ラップしてよいコマンドの条件
- `remove` は、コマンドの実行前の INT / TERM も 70 に写す。コマンドが 0 でも worktree が残っていれば、保存先を消さずに張り直す（`test_remove_keeps_the_store_when_the_worktree_stays`）。
- perl の `unmount` は、mountpoint の最上位の行が自分のものでなければ、外さずに止まる。
- 不変条件の権限の書き方を、実装の検査（所有者と group / other の書き込み権限）に合わせた。
- T2 の `cmd_sync` の仮の 1 行を明記した。V3 で `//deleted` を確かめることを、plan-3 に申し送った。

## Round 2 からの変更

- 「ヘルパーの契約」の節を足した。サブコマンドごとの終了コード、レコード、VM の外での挙動、中断時の挙動、保存先の不変条件を書き、plan-2 と plan-3 の正本にした。
- `attach` の 1 は、張らずに終わったパッケージがあるとき（`MISSED`：ls-files の失敗と上限超過）だけにした。保存先を残しただけなら 0 である。
- `remove` は、コマンドを実行する前の予期しないエラーを、ERR の trap で 70 に写す。
- 自分の行の判定を、「mountpoint が `//deleted` でない」に絞った（到達できるかは見ない）。上に別の mount が重なっても `rmstore` が拒否する。
- `unmount` は、積み重なった行も外せるよう、最大 8 回繰り返す。
- mount の巻き戻しは、対象パスの最上位の行が今回足した id のときだけにした。
- 入れ子の別 repo の保存先を回収しない（`in_nested_repo`）。
- 一覧にあるのに解決できない worktree があれば、repo 全体の回収を中止する。`canon` は存在しないパスを失敗にした。
- `prepare` は、EEXIST を許し（初回の並走）、group / other の書き込み権限も拒否する。
- `LOCK_WAIT` は、テスト用の保存先のときだけ効く。
- git の子プロセスには lock の fd を渡さない。`GIT_DIR` などは unset する。
- `stores_owned_by` で、記録の key の整合を見る。
- T0 で、host が作った `node_modules` の uid、`/var/lib` のファイルシステム、root 欄の形式を確かめる。
- T1 の仮実装と、各タスクの失敗の期待値を直した。lock のテストは T2 に移した。
- spec との差分に、次を足した: 期待するパスの出どころ、他の repo の記録、入れ子の repo、解決できない worktree、テストの方式、Files の追加、CI runner の前提。

## Round 1 からの変更

- 実行ビットに依存しないよう、テストは `bash "$HELPER"` で呼ぶ。
- `cmd_sync` の終了コードの判定（`finish`）を T2 に移した。T2 の上限と symlink のテストが、終了コード 3 と 1 を確かめるため。
- `DEV_CHECK` をやめ、自分の行の判定を「到達できる行」に変えた（「spec との差分」参照）。
  - `rmstore` は 3 つの安全策を持つ: 記録のパスの `node_modules` が `data` と同じ inode なら拒否する、`rm -rf --one-file-system` で消す、到達できない行は数えない。
- mount の失敗時は、fork の前に控えた mount id に無い、対象パス上の行だけを外す。子プロセスは `POSIX::_exit` で終える。
- テストは `/etc/agent-vm` に触れない。VM の代役は `AGENT_VM_NM_ASSUME_VM=1` で、保存先の根がテスト用のときだけ効く。
- `remove` を次のように変えた。
  - メインの worktree を拒否する（64）。
  - 対象の保存先を、記録のパスの所有者（一覧の中で最も深く含む worktree）で選ぶ。
  - ヘルパー自身の失敗を 70、lock の待ち切れを 71 とする。
  - コマンドは `9>&-` で lock の fd を渡さずに実行する。
  - VM の外ではコマンドだけを実行する。
- 回収の中止は、所有者の worktree の単位で判定する。メインの中止が、入れ子の worktree の回収を止めない。
- `attach` は、ls-files の失敗や上限超過のときに 1 を返す。
- 一時ファイルは 1 つのディレクトリにまとめ、EXIT の trap で消す。連想配列の添字は key（16 桁の hex）にした。
- `resolve_worktree` の結果が一覧にあることを、lock の下で確かめる。
- `prepare` は、作るときだけ所有者と権限を設定する。既にある root 以外の所有のディレクトリや lock は拒否する。
- `mkstore` / `mount` は、所有者に `SUDO_UID` を使う。`mount` は、対象の所有者を確かめ、重ねて張ることを拒否する。
- 記録の無い空の key ディレクトリは、警告せずに飛ばす。他の repo の記録も、警告せずに飛ばす。
- テストは非同期のサブシェルで実行し、`set -e` を効かせる。
- 足したテスト:
  - 一覧の失敗、メインの欠落、`.git` が見えない
  - メインの中止と入れ子の worktree、1 が 3 に優先
  - 制御文字、symlink の `package.json`
  - `attach` の 64 と 1
  - `remove` の 64、70、71
  - VM の外
- T0 の `<R>` を scratchpad の試験用 repo に定め、`/var/lib/agent-vm` の所有者も記録するようにした。plan-1 の中から ADR-0022 への参照を外した（plan-3 で足す）。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘: ヘルパーを実行ビットなしで作ると全テストが 126 で落ちる。T2 のテストが T3 の終了コードに依存している。`DEV_CHECK` を 1 台の btrfs の結果で固定するのは危うい（迷ったら 0）。host での作り直しで mountpoint が消えると、`unmount` が永遠に失敗して回復しない。テストの中で `set -e` が効かない。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘: 範囲の逸脱は 0 件。K2 の中止条件（一覧の失敗、空、メインの欠落、repo が見えない、1 が 3 に優先）と K6 の拒否（制御文字、symlink の `package.json`、検証の失敗）のテストが無い。`remove` の終了コード 4 がコマンドの終了コードと衝突し、テストも無い。上限のテストが T2 にある。ADR-0022 への参照が、まだ無いファイルを指している。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: root 側は呼び出し側のパスを包含の点で検査しておらず、コメントの主張と合わない。mount の失敗時に以前から有効な行を外しうる。テストが `/etc/agent-vm` を作ったまま残し、開発者の Linux 機を VM と誤認させる。実行ビット。`prepare` が既存の親ディレクトリの所有者を書き換える。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: `remove` にメインの worktree を渡すと、全保存先を消しうる。`DEV_CHECK` の誤りで `rows` が空になると、`rmstore` が mount 中の中身を消す（`remove_tree` は別のファイルシステムにも降りる）。連想配列の添字に repo のパスを使っている。子プロセスで `exit` を使っている。lock の fd がコマンドに渡る。一時ファイルが漏れる。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: `attach` が、何も張れなくても 0 で終わる。`remove` の終了コード（2、4、64）がコマンドの終了コードと衝突する。メインの worktree で中止すると、入れ子の worktree の回収まで止まる。`path` の無い key ディレクトリについて、毎回警告が出る。`resolve_worktree` が、登録済みの worktree かどうかを確かめていない。

### Intent Alignment Triage (Round 1)
- 採用 31 件（aligned 29 / neutral 2）、除外 0 件。範囲を縮める指摘は無かった。すべて、spec の本義（全 agent-vm 環境で、repo 側の作業なしに node_modules を分ける）を保ったまま、誤った削除や誤った mount を防ぐための指摘だった。

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: pass
- 主指摘: Round 1 の指摘は解消した。軽微な指摘は 4 つ。
  - 初回に並走すると、`prepare` の EEXIST で die する。
  - T1 / T2 の失敗の期待値（SKIP、`cmd_attach` の stub）と、lock のテストを置くタスクがずれている。
  - T2 の `cmd_sync` で、`reclaim` の分岐の扱いが曖昧である。
  - `stores_owned_by` が key の整合を見ていない。

### scope-justification-reviewer
- verdict: pass
- 主指摘: Round 1 の指摘は解消した。軽微な指摘は 3 つ。
  - spec との差分に書き漏れがある（他の repo の記録を黙って飛ばす、本物の mount のテスト、run-templates と fixture の編集）。
  - 空の一覧が、メインの欠落と同じ経路を通ることを明記する。
  - テストしない経路（mount の検証失敗、K9 の外した後に行が残る場合）を「対象外」に書く。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: 軽微な指摘は 5 つ。
  - `LOCK_WAIT` を、テスト用の保存先のときだけ効かせる。
  - `prepare` で、group / other の書き込み権限も拒否する。
  - `unmount` を、積み重なった行も外せるループにする。
  - spec との差分に、「期待するパスは記録から取る」「包含の検査は bash 側だけ」を足す。
  - T0 で、host が作った `node_modules` の uid と、CI runner が root でない前提を確かめる。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: P2 以下の指摘は 6 つ。
  - 入れ子の別 repo の保存先を回収してしまう。
  - 一覧にあるのに解決できない worktree の保存先を回収してしまう。
  - 上に別の mount が重なると「到達できない」と判定し、`rmstore` が mount 中の中身を消しうる。
  - 巻き戻しは、対象パスの最上位の行が新しい id のときだけにする。
  - git の子プロセスに lock の fd が渡る。
  - `GIT_DIR` などを引き継ぐ。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: 後続の plan が依存する契約について 4 点ある。
  - サブコマンドごとの終了コードの表（正本）が無い。
  - `attach` の 1 に「回収の保留」まで含まれる。
  - `remove` の 64 の意味が定まっておらず、コマンドの実行前に未捕捉のエラーが起きると素の 1 が漏れる。
  - 中断時の挙動と、保存先の不変条件が書かれていない。

<!-- auto-review: verdict=needs-work; hash=cb9f88bcb87ad96a1bfeb0953cba686719c0d3f76796e5a119f1c501fc8de31f; design-hash=a9b06eac53b1dd8fd2953eb5564c27af5100cf798c2f1d09b808d25cded2f84f; round=1; parent-spec-hash=e2c7ba57e41e8bfa1714bdcfe7eae1040274fcc43701ea97798c7fe3034f76ec; at=2026-10-02T04:06:25.814Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=31; excluded=0; at=2026-10-02T04:06:25.836Z -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: needs-work
- 主指摘: 兄弟の worktree が解決できないだけで、`load_worktrees` の 1 が `attach`（1）と `remove`（70）まで巻き込む。軽微な指摘は 4 つある。
  - `unmount` が、最上位にある他人の mount を外しうる。
  - V3 で `//deleted` の扱いを確かめることを、plan-3 に申し送る。
  - `remove` が、コマンドの成功後に worktree が残っていても保存先を消す。
  - T2 の `cmd_sync` の形が曖昧。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: 同じく、兄弟の worktree が解決できないと `attach` / `remove` が失敗する。ほかに 4 点ある。
  - 「1 は張れないパッケージ」の原則と、`sync` の上限超過 / ls-files 失敗の 3 が衝突する。例外として明記する。
  - 契約表に無い終了経路がある（準備の失敗、`remove` の使い方の誤り、VM の外での不正な保存先の根）。
  - ラップするコマンドは 64 / 70 / 71 を返さない前提を書く。コマンドを実行する前の中断（INT / TERM）は 70 に写す。
  - 不変条件の 0755 と実装の検査（`& 022`）がずれている。`path` の所有者は作成時だけ保証する。

### scope-justification-reviewer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=a18ad5728600779f74d665371fb898411d5a0d2326915c4b3be37fb29a815957; design-hash=b60ef04695a62edf69aaa71dea5af89a0511ccbded32912bc49da06626274f6c; round=2; parent-spec-hash=e2c7ba57e41e8bfa1714bdcfe7eae1040274fcc43701ea97798c7fe3034f76ec; at=2026-10-02T04:21:35.758Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=28; excluded=0; at=2026-10-02T04:21:35.781Z -->

## Reviewer Outputs (Round 4)

### logic-validator
- verdict: pass
- 主指摘: Round 3 の 5 点はすべて解消した。軽微な注意が 2 つある。
  - `remove` の中では、`canon` の置換の内側でも ERR trap が 70 を返す（今のところ無害）。
  - メインが先頭に無い一覧でも、後続の worktree に張る。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: 契約の文面がコードと 5 か所で合わない。
  - `sync` の 3 が 1 の原則から外れる範囲が、上限超過と ls-files 失敗の 2 つにとどまらない。
  - `remove` の stdout には、コマンドの出力がそのまま流れる。
  - 引数の誤りと不正な保存先の根は、VM の外でも 64 になる。
  - 70 のうち、張り直すのは外す処理が失敗した場合だけである。
  - レコードを出さずに 1 を返す場合がある。
  - `remove` の引数の数の誤りにテストが無い。

### scope-justification-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=9387711c441c550ef2431331a777b12765a9ac3100dd7ef5d30a7f6acfb65e4c; design-hash=2d100285827c7a62e97052193d91051b7e4bbe01938d7a87744b7805e1ee4aba; round=3; parent-spec-hash=e2c7ba57e41e8bfa1714bdcfe7eae1040274fcc43701ea97798c7fe3034f76ec; at=2026-10-02T04:28:27.582Z; reviewers=logic-validator+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=9; excluded=0; at=2026-10-02T04:28:27.607Z -->

## Reviewer Outputs (Round 5)

### logic-validator
- verdict: pass
- 主指摘: 新しいテストと契約の文面は、コードの引数検査と終了経路に一致する。不整合は無い。

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: Round 4 の 5 点はすべて解消した。任意の文面の修正が 3 つあり、反映済み。
  - 1 の原因に、`node_modules` を作れない場合を足した。
  - 1 の定義を「張るべきだった」に言い換えた。
  - 「一覧が使えない」の内訳を書いた。

### scope-justification-reviewer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=1825fc629fb4541c4bb9f79c229824555bf86ffaefa24457b1ab73ead8cce92f; design-hash=6ebacdd5f6ab378e6ae55c0dbb647a0735579f9ebb12c8e0651a3361f1a8e8c5; round=4; parent-spec-hash=e2c7ba57e41e8bfa1714bdcfe7eae1040274fcc43701ea97798c7fe3034f76ec; at=2026-10-02T04:31:47.854Z; reviewers=logic-validator+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=7; excluded=0; at=2026-10-02T04:31:47.925Z -->

<!-- auto-review: verdict=pass; hash=a27cd4ecaf973ad9b4ff0d127aa177f2837432e8b4c9df24fca63f6ed5e0e0a9; design-hash=6ebacdd5f6ab378e6ae55c0dbb647a0735579f9ebb12c8e0651a3361f1a8e8c5; round=5; parent-spec-hash=e2c7ba57e41e8bfa1714bdcfe7eae1040274fcc43701ea97798c7fe3034f76ec; at=2026-10-02T04:33:40.960Z; reviewers=logic-validator+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=3; excluded=0; at=2026-10-02T04:33:41.000Z -->
