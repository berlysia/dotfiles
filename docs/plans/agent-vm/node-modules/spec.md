# Spec: agent-vm の VM 側 node_modules を VM ローカルに差し替える

## Goal

agent-vm の machine で、host と同じパスに mount された repo（各 worktree を含む）の `node_modules` を VM ローカルのディスクに差し替える。
mac と VM が互いの install でプラットフォーム別パッケージ（TS7、oxc 系など）を壊し合わないようにする。PM の種類と repo 側の設定に依存しない。

## Experience Delta

- 変更前: mac で install した repo で VM の claude が `tsc` を実行すると、`Unable to resolve @typescript/typescript-linux-arm64` で落ちる。VM で install し直すと、今度は mac 側が壊れる。
- 変更後: VM の `node_modules` は mac と別物になる。VM で一度 install すれば両側が独立して動く。VM 側が未 install のときは、起動時に 1 行の通知で install を促す。worktree を `git-worktree-create` / `git-worktree-cleanup` で増減すると、VM の中で作っても host で作っても、同じ扱いが続く。

## Architecture

```
host (mac)                                   VM (OrbStack isolated machine, linux-arm64)
<repo>/node_modules            (darwin)      <repo>/node_modules                 --bind--> /var/lib/agent-vm/node_modules/<key>/data
<repo>/.git/worktree/b/node_modules (darwin) <repo>/.git/worktree/b/node_modules --bind--> /var/lib/agent-vm/node_modules/<key'>/data
        ^ 共有 mount（同じパス）で host から見えるのは mount 先のディレクトリだけ。VM の中身は host に出ない
```

構成要素と責務:

1. **VM 側ヘルパー `agent-vm-node-modules`**（新規、chezmoi で VM にだけ配る。K6）。mount の仕組みはすべてここに閉じる。
   - `sync <repo>`: 望ましい状態（一覧の worktree ごとに 1 つの mount）に収束させる。**正（source of truth）はこれ**で、他の経路は収束を早めるための近道にすぎない。
   - `attach <worktree>`: 1 つの worktree について `sync` と同じ処理を行う。
   - `remove <worktree> -- <command...>`: lock を持ったまま、外す → `<command>` を実行 → 成功なら保存先を消す / 失敗なら張り直す。worktree の削除専用（K7）。
   - `--contract`: 出力の契約の版（`1`）を出す。
   - すべて冪等で、VM 内の 1 つの lock ファイルに対する flock で直列化する。
2. **launcher（`executable_agent-vm`）**:
   - 起動のたびに `sync` を呼ぶ。
   - `sync` の `empty` レコードと host 側の状態を突き合わせて、install を促す通知を出す（K5）。通知の方針は launcher が持ち、mount の仕組みはヘルパーが持つ。
   - 新しいサブコマンド `agent-vm node-modules-sync [repo]` で、起動中の machine にだけ `sync` を届ける（host の worktree 用ツールから使う）。
3. **`git-worktree-create`**: 作成後に収束を早める。VM の中ではヘルパーの `attach`、host では `agent-vm node-modules-sync`（K7）。
4. **`git-worktree-cleanup`**: VM の中では、`git worktree remove` をヘルパーの `remove` 経由で実行する（K7）。

mount は machine の mount namespace 全体に効く。`orb -m` の呼び出しはすべて同じ namespace を共有するので（検証済み）、1 回張れば、その machine の claude / codex / `agent-vm shell` のすべてのセッションに効く。
machine の再起動や host 側での `node_modules` の作り直しで mount が失効しても、`sync` が inode の一致で失効を検出して張り直す（K9）。したがって、再起動で mount が消えるかどうかには依存しない。

## Files

- 新規: `home/dot_local/bin/executable_agent-vm-node-modules`（VM 側ヘルパー）
- 変更: `home/dot_local/bin/executable_agent-vm`（`run_tool` への `sync` と通知、`node-modules-sync` サブコマンド）
- 変更: `home/dot_local/bin/executable_git-worktree-create`、`home/dot_local/bin/executable_git-worktree-cleanup`（K7）
- 変更: `home/.chezmoiignore`
  - VM 許可リストに `!.local/bin/agent-vm-node-modules` を足す（ADR-0018 K17 の延長）。
  - host 側の無視として `{{ if not (dig "agent_vm" false .) }}` ブロックに `.local/bin/agent-vm-node-modules` を足す。
- 新規: `tests/agent-vm/run-node-modules.sh`（ヘルパーのテスト。`mount` / `umount` / `findmnt` / `sudo` は stub）
- 変更: `tests/agent-vm/run.sh`（launcher の `sync` 呼び出しと通知、`node-modules-sync` の終了コード）、`tests/git-worktree-cleanup/run.sh`（`remove` 経由と、ヘルパーが無いときの不変）
- 新規: `tests/git-worktree-create/run.sh`（VM での `attach`、host での `agent-vm node-modules-sync`、どちらも無いときの不変）
- 変更: `.github/workflows/ci-git-worktree-cleanup.yml`（create のテストも実行する。paths に create を足す）
- 変更: `.github/workflows/ci-agent-vm.yml`（新しいテストの実行）
- 変更: `docs/agent-vm.md`（警告表の行、既知の制限 R1/R2/R5、移行手順 R6、手動検証の V 表）
- 新規: `docs/decisions/0022-agent-vm-node-modules.md`、変更: `docs/decisions/0018-agent-vm-orbstack.md`（`Amended by` 1 行）

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

PM のグローバル設定で、darwin と linux の両方の optionalDependencies を置く（research の A'）。
yarn は `.yarnrc.yml`、pnpm は環境変数、bun は install フラグのラッパーで成立する。npm は成立しない（`os`/`cpu`/`libc` が単一値で、install のたびに片方を消す。research の npm 節）。
仕組みが PM ごとに 3 種類に分かれ、npm の repo には穴が残る。pnpm の環境変数は repo の `supportedArchitectures` を丸ごと置き換える。
不採用。

### 白紙設計案 (Greenfield)

ゼロから設計するなら、「作業ツリーは共有し、ビルド成果物とインストール物は環境ごとに持つ」に分ける。
devcontainer で `node_modules` を named volume に置く定番と同じ発想で、共有 mount の上に環境ローカルの層を重ねる。
層の寿命は worktree の集合から導き、1 つの冪等な reconciler を、あらゆる入口から呼ぶ。
重ね方の候補は次の 2 つ。

- (G1) machine 作成時の OrbStack の mount 一覧に `<state>/nm/<key>:<wt>/node_modules` を加える。host 側で宣言でき、`verify_machine_config` の検査にも乗る。しかし mount 一覧は `orb create` 時に固定され（`executable_agent-vm:365-369` の `vm_mounts` は作成時と検査時だけに使われる）、セッション中に増える worktree に張れない。保存先も host の state ディレクトリになり、linux 用の中身が host のディスクに置かれる。
- (G2) VM の中で bind mount する。保存先は VM 自身のディスクになる（検証で `/dev/vdb1` btrfs を確認）。worktree の増減に合わせて、VM の中から張り外しできる。

起源: 問題の原因は「ツリーの共有」そのものではなく、「プラットフォーム依存の install 物までツリーと一緒に共有されている」ことにある。したがって、install 物の層だけを環境ごとに分けるのが最小で完全な境界になる。G2 は worktree の動的な増減に追従でき、G1 はできない。

### 採用案と理由

G2（VM 内の bind mount）を、`sync` を正とする reconciler の形で採用する。

- 仕組みが PM の設定を使わないので、npm を含む 4 つの PM で同じ 1 つの仕組みになる。research の実験で、A' は npm で不成立だった。
- VM 内での成立は、pnpm workspace で検証した。VM 内の bind mount は別の `orb -m` 呼び出しから見えた。VM の `pnpm install` は host の `.pnpm` を変えず、両側で `tsc` / `oxlint` が動いた（research「B' の成立性検証」）。npm / yarn / bun については、mount 自体は PM に依存しない。どこまでをルートの差し替えで覆えるかは K1 で扱う。
- PM のユーザー設定を変えないので、agent-vm を使わない repo には影響しない。

## Key Decisions

- **K1: 差し替えの単位は「worktree の中で `package.json` を持つ各ディレクトリ（パッケージ）の `node_modules`」とする。**
  - 対象のパッケージは、worktree の中で `git ls-files -z --cached --others --exclude-standard -- '*package.json' 'package.json'` が返すパスの親ディレクトリである。node_modules の中、ignored、`.git` の中は含まない。まだ commit していない新しいパッケージも含む。
  - 根拠（research「hoisted workspace の追加実験」）:
    - pnpm と bun の既定（isolated）は、実体をルートのストアにだけ置く。各パッケージの `node_modules` はルートへの相対 symlink だけを持つ。
    - npm、yarn の node-modules、bun の hoisted は、パッケージ間でバージョンが衝突すると、`packages/<x>/node_modules` にプラットフォーム別パッケージの実体を置く。
    - ルートだけの差し替えでは後者を覆えない。パッケージごとに差し替えれば、どの PM でも同じ規則で覆える。各パッケージの `node_modules` が symlink だけを持つ PM でも、VM の install が VM 側に symlink を作るので矛盾しない。
  - 入れ子のさらに内側（bun hoisted の `packages/b/node_modules/typescript/node_modules/...`）は、`packages/b/node_modules` の差し替えに含まれる。
  - 参照: research.md「B' の成立性検証」5、「hoisted workspace の追加実験」
  - 参照: `home/dot_local/bin/executable_git-worktree-create:63-72`（worktree は `<repo>/.git/worktree/<branch>`、各自がルートを持つ）

- **K2: worktree の列挙は `git worktree list --porcelain -z` を候補の出どころとし、K6 の検査を通ったものだけを対象にする。**
  一覧は VM の agent が書き換えられるので、それだけでは信頼しない。
  `sync` の処理は「張る」（新規の mount、失効した mount の張り直し）と「回収」（保存先の削除）に分ける。張るのは保存先を消さないので常に行い、回収は次の中止条件のどれにも当たらないときだけ行う。
  - repo 全体の回収を中止する条件:
    - 一覧の取得が非 0 で終わった。
    - 一覧が空だった。
    - 一覧にメインの worktree（repo のルート）が含まれない。
    - repo のルートが VM から見えない（`<repo>/.git` が無い）。
  - その worktree の回収だけを中止する条件:
    - その worktree での `git ls-files` が非 0 で終わった。
    - 対象のパッケージが 0 件で、かつその worktree の配下を `path` に持つ保存先が 1 つ以上ある（`package.json` が一度に全部消えた、または index が壊れた可能性がある）。
    - 対象のパッケージが 500 件を超えた（K6）。ルートのパッケージ以外の保存先を回収しない。
  - 対象のパッケージが 0 件で、保存先も無い（JS でない repo / worktree）のは正常な状態で、何もせずに終了コード 0 とする。
  - 中止したときは、回収をしなかった理由を標準エラーに出し、終了コード 3 で終わる（K10）。
  - 木から `package.json` が消えたパッケージ（ブランチの切り替えなど）の保存先は、中止条件に当たらなければ回収する。これは意図した動作で、代償はそのパッケージが戻ったときの VM での再 install である。
  - 参照: `home/dot_local/bin/executable_agent-vm:38-44`（`resolve_repo_root` は `--git-common-dir` の親。全 worktree が同じ machine）
  - 参照: `home/dot_local/bin/executable_agent-vm:1106-1116`（`build_launch_script` は `cd $repo`）
  - 参照: `home/dot_local/bin/executable_git-worktree-cleanup:167-187`（`git worktree list --porcelain -z` の読み方の既存実装）

- **K3: 保存先は `/var/lib/agent-vm/node_modules/<key>/` で、中に `path`（パッケージのディレクトリの正規化した絶対パス 1 行）と `data/`（mount の元）を持つ。保存先は K1 のパッケージごとに 1 つ。**
  - `<key>` は正規化したパスの sha256 の先頭 16 桁で、`^[0-9a-f]{16}$` に合わないものは扱わない。
  - 親の `/var/lib/agent-vm/node_modules` は root 所有の 0755 で作る。`<key>` も root が作り、VM のユーザーに chown するのは `data/` だけにする。agent は保存先の構造を差し替えられない。lock ファイル（`/var/lib/agent-vm/node_modules/.lock`）も root 所有の場所に置く。
  - ヘルパーは、git の列挙（`git worktree list`、`git ls-files`）を VM のユーザーで行う（root で実行すると git の safe.directory 検査に掛かるため）。mount、外す、削除、保存先の作成は、`sudo -n` の root で行う。
  - `sync` が回収する対象は保存先の `path` から決める（mount の一覧からではない）。再起動で mount が消えていても、現在の対象に無い保存先を見つけて消せる。
  - `path` を読み戻すときも、K6 の検査（制御文字が無い、`sync` に渡された repo のルートの配下）を通し、さらに `<key>` が `path` の sha256 の先頭 16 桁と一致することを確かめる。どれかに外れた保存先は、消さずに警告だけ出す。
  - `remove <worktree>` の対象は、`path` が worktree のパスと等しいか、`<worktree>/` で始まる保存先とする（`/wt` と `/wt2` を区別する）。比べる worktree のパスは、引数を `realpath` で正規化し、K6 の worktree の条件を通したものである。
  - 削除するのは `/var/lib/agent-vm/node_modules/<key>`（key は正規表現を通ったもの）だけで、それ以外のパスは受け付けない。
  - 自分の mount は、`/proc/self/mountinfo` の行のうち、major:minor が保存先の親と同じデバイスで、root（bind の元）が `/var/lib/agent-vm/node_modules/<key>/data` で**終わる**行で判定する。btrfs では root に subvolume の接頭辞が付くため、完全一致ではなく末尾一致とする。他の mount には触れない。root 欄の実際の形式は手動検証 V2 で確かめる。
  - machine の削除（`agent-vm rm`）と一緒に消える。golden には repo の mount が無いので保存先は作られず、clone に持ち込まない。
  - 参照: `home/dot_local/bin/executable_agent-vm:365-369`（golden は repo を mount しない）
  - 参照: `docs/decisions/0018-agent-vm-orbstack.md:74`（R6: VM ユーザーはパスワードなし sudo）

- **K4: launcher は起動のたびに `sync` を呼ぶ。失敗は非致命の警告にする。**
  - 呼ぶ位置は `run_tool` の `notice_gh_token_expiry` の後とする。machine の準備が済み、lock を解放した後の、既存の `notice_*` と同じ並び。`agent-vm shell` も `run_tool` を通る（`executable_agent-vm:1287`）。
  - ヘルパーが無い、`--contract` が `1` でない、`sync` が非 0 で終わった場合は、起動を止めずに 1 行の警告を出す。書式は `agent-vm: node_modules is shared with the host in the VM (<理由>); recover: <コマンド>`。
  - ヘルパーは chezmoi で配る（K6）。ヘルパーを足すと staging の hash が変わるので、既存の machine も次の起動の `maybe_bootstrap` で受け取る（`executable_agent-vm:570-578`）。したがって「ヘルパーが無い」は bootstrap が失敗したときにしか起きない。回復手順は `agent-vm rm` と起動し直しとする。
  - 参照: `home/dot_local/bin/executable_agent-vm:1210-1235`（`run_tool` の順序）
  - 参照: `home/dot_local/bin/executable_agent-vm:306-352`（`ensure_browsers`: 「失敗はすべて警告」の既存モデル）

- **K5: install を促す通知は、worktree のルートのパッケージについてだけ判定し、「host 側の `node_modules` に `.` で始まらないエントリが 1 つ以上あり、VM 側の `data/` が空」の worktree ごとに 1 行だけ出す。**
  - ルート以外のパッケージは判定しない。パッケージごとに出すと monorepo で行数が増え、VM で install した後も中身が空のままのパッケージ（依存の無いパッケージ）で誤通知になるため。
  - host 側の `.cache`、`.vite` など `.` で始まるエントリだけの `node_modules` は、install 済みとみなさない。
  - 両方が空なのは「まだ誰も install していない」正常な状態なので、通知しない（規約「正常な状態で通知しない」）。host 側が空でないのに VM 側が空なのは、VM で `tsc` などが失敗する直前の状態なので、ここで回復手順を出す。
  - VM 側が空かどうかはヘルパーが `empty` レコードで返し、host 側の判定は launcher が host のファイルシステムで行う。VM からは、host の `node_modules` の実体が見えないため。
  - 書式: `agent-vm: node_modules in the VM is empty for <path> (the host has one); recover: run the package manager's install in <path> inside the VM`。
  - install をヘルパーが自動で実行することはしない。PM の判定と lifecycle スクリプトの方針（`ignore-scripts`）は repo と PM ごとに異なり、自動実行は agent の作業と競合するため。
  - 参照: `home/dot_local/bin/executable_agent-vm:1361-1381`（`notice_gh_token_expiry`: 必要なときだけ話す通知の既存モデル）
  - 参照: `docs/agent-vm.md:57-67`（警告表: 場面 / 条件 / 回復手順）

- **K6: ヘルパーの検査と脅威モデル。**
  脅威モデル: VM のユーザーはもともとパスワードなし sudo を持つ（ADR-0018 R6）。ヘルパーは権限の境界ではなく、**事故を防ぐ柵**である。ヘルパーを使っても、agent が単独でできること（sudo で任意の mount）は増えない。守るのは「正規の経路（launcher、worktree 用ツール）が、偽造された一覧や差し替えられたパスに誘導されて、意図しない場所に mount したり消したりしないこと」である。
  `attach` / `remove` に渡された引数も、`sync` の一覧と同じ検査を通す。引数を信頼しない。
  対象にする条件（すべて満たすこと）。各条件が防ぐ事故を併記する:
  - worktree: 一覧のパスの `realpath` が、repo のルートと等しいか、`<repo のルート>/.git/worktree/` の配下にある。repo のルート自体も `realpath` で正規化して比べる。→ 一覧に紛れた repo 外のパス（手で書き換えた `.git/worktrees/*/gitdir` など）に張る事故。
  - パッケージ（K1）: ディレクトリの `realpath` が、その worktree の `realpath` と等しいか配下にある。パスの構成要素に `node_modules` と `.git` を含まない。→ `node_modules` を ignore していない repo で、依存パッケージの `package.json` ごとに mount が増える事故。別の worktree の中に張る事故。
  - パッケージの `package.json` が、`lstat` で通常ファイルである（symlink は不可）。→ `package.json` の無い repo に空のディレクトリを作る事故。
  - パスに制御文字（改行、タブを含む）が無い。→ K10 のレコードが壊れる事故。
  - 1 つの worktree の対象パッケージは 500 件までとする。超えたら、その worktree はルートのパッケージだけを対象にして警告する。ルートに `package.json` が無ければ、その worktree には何も張らない。→ fixture の `package.json` が大量にある repo で、mount と保存先が際限なく増える事故。500 は、一般的な monorepo（数十から数百パッケージ）を覆う値である。
  mount の手順（パッケージごと、1 本の流れ）:
  1. `<package>/node_modules` が無ければ、VM のユーザー（root ではない）で作る。host の木に root 所有のディレクトリを作らないため。既にあって symlink なら警告して張らない。
  2. perl で、mount の元 `data/` と mount 先 `<package>/node_modules` を、どちらも `O_DIRECTORY|O_NOFOLLOW` で開く。
  3. 開いた fd の実パス（`readlink /proc/self/fd/<n>`）が、mount 先は正規化した期待のパスに、元は保存先の `data` に一致することを確かめる。→ 検査から開くまでの間に、親ディレクトリが symlink に差し替えられる事故（開いた後の実パスで判定するので、差し替えは検出される）。
  4. `mount --no-canonicalize --bind /proc/<pid>/fd/<src> /proc/<pid>/fd/<dst>` で張る。→ 3 から 4 の間のパスの差し替え。
     - 2〜5 は、`sudo -n` で起動した **1 つの root の perl プロセス**の中で行う。`<pid>` はこの perl の pid である。perl は `mount` を子として直接 fork/exec し（子では sudo を通さない。sudo は fd 3 以上を閉じるため）、子が終わるまで待つ。したがって `/proc/<pid>/fd/<n>` は mount の実行中ずっと有効である。
  5. `/proc/self/mountinfo` で、root が自分の `data` である行の mountpoint が期待のパスであり、期待のパスの device:inode が `data/` と一致することを確かめる。違えば、その行を 1 回だけ `umount --no-canonicalize` で外して警告する（終了コード 1）。→ 1 から 4 のどこかで想定外の場所に張られた場合の最終の検出。**正しさの保証はこの段が持つ**。
  - mountinfo の読み方: mountpoint と root の 8 進エスケープ（空白の `\040` など）を復号してから比べる。外す対象は「root が自分の `data` で終わり（K3）、かつ mountpoint が今回 mount した期待のパス」の行に限る。
  - 重ねて張らない: 1 の前に K9 の判定を行い、既に有効な mount があれば何もしない。失効した mount が残っている間は張らない（K9）。したがって 5 で外すのは今回張った行だけで、以前から有効だった mount を剥がすことはない。
  - 許容する残余: 条件の検査から 1 の作成までの間に親が差し替えられると、repo 外の場所に空の `node_modules` ディレクトリが 1 つ作られうる。3 と 5 により mount は張られない。事故を防ぐ柵として、この残余は許容する。
  - fd 経由の mount（4）が OrbStack の VM で動くことは未検証で、plan の手動検証の最初の項目にする。動かない場合は、4 を正規化したパスへの `mount --bind` に置き換え、5 を保証として残す。2〜3 は残す（親の差し替えの検出に必要なため）。
  - 参照: `home/dot_local/bin/executable_agent-vm:580-600`（`OUTBOX_READ_PL`: perl の `O_NOFOLLOW` と `realpath` による包含検査の既存実装）
  - 参照: `home/dot_claude/hooks/implementations/deny-node-modules.ts:56-64`（保護フックは Bash のコマンド文字列を解析する。`git-worktree-create foo` は対象外）
  - 参照: `home/.chezmoi.toml.tmpl:10`（`agent_vm = stat /etc/agent-vm`）

- **K7: worktree 用ツールとの結合は意図的とし、その契約をテストする。**
  汎用のフック機構（hook ディレクトリ）は作らない。利用者がこの 2 つのツールと agent-vm だけで、2 つ目の利用者がいないからである。
  ツールは `/etc/agent-vm` があり、ヘルパーが PATH にあるときだけ VM 側の連携をする。ヘルパーの `attach` / `remove` のコマンドラインがツールとの契約で、テストで固定する。
  - `git-worktree-create`（`executable_git-worktree-create:79-95`）:
    - VM の中では、`git worktree add` の成功後に `attach` する。
    - host では、`agent-vm` が PATH にあれば `agent-vm node-modules-sync` を実行する。
    - どちらも、失敗しても作成は失敗にせず、警告と回復手順を出す。
  - `agent-vm node-modules-sync [repo]`（host の launcher の新しいサブコマンド）の契約:
    - repo に対応する machine の記録（`$AGENT_VM_STATE_DIR/machines/<m>`）が無い（agent-vm を使っていない repo）: 何も出さずに終了コード 0。
    - machine が止まっている: 起動せず、何も出さずに終了コード 0。次の起動の `sync` で収束する。
    - machine が動いている: VM で `sync` を実行し、K10 の終了コードが 0 なら 0、それ以外は警告を標準エラーに出して非 0。
    - host の `git-worktree-create` は、終了コードが非 0 のときだけ警告を出す。agent-vm を使わない repo と止まっている machine では、何も表示しない（正常な状態で通知しない）。
  - `git-worktree-cleanup`（`executable_git-worktree-cleanup:546-551`）:
    - VM の中では、`git worktree remove` を `agent-vm-node-modules remove <wt> -- git -C <main> worktree remove -- <wt>` で包む。
    - ヘルパーは lock を持ったまま「外す → remove → 成功なら保存先を消す / 失敗なら張り直す」を行う。並行する `sync` が途中で張り直す競合と、remove が拒否されたときに保存先だけ消える状態の両方を防ぐ。
    - 外すのに失敗したら（`umount` の EBUSY など）、remove を実行せずにその worktree を残す。理由は既存の「kept」の書式で出す。
    - host では挙動を変えない。host で worktree を消すと VM の mount 先の下のディレクトリが消える。その mount と保存先は、次の `sync` が回収する（K3）。

- **K8: ADR-0022 を新設し、ADR-0018 に `Amended by` を 1 行足す。**
  共有 mount の上に VM ローカルの層を重ねるのは、ADR-0018 の「repo を同じパスで共有する」決定に対する修正だからである。ADR-0018 K17（VM 許可リスト）にヘルパーを足すことも、ADR-0022 に書く。
  ADR-0021 K9（bootstrap の契約の版を据え置く）は変えない。ヘルパーは chezmoi の配布物で、cloud-init と bootstrap の契約に触れないため。
  - 参照: `docs/decisions/0018-agent-vm-orbstack.md`
  - 参照: `docs/decisions/0021-agent-vm-golden-clone.md`

- **K9: mount の有効性は inode の一致で判定する。**
  `mountinfo` に自分の行があっても、`<package>/node_modules` の device:inode が `data/` と一致しなければ失効とみなす。失効した mount は、K6 の 5 と同じ絞り込み（エスケープを復号し、root が自分の `data` で終わる行だけ）で選んだ行の mountpoint を `umount -l --no-canonicalize` で外す。外した後で mountinfo を読み直し、同じ mountpoint に自分の行が残っていないことを確かめてから、K6 の手順で張り直す。残っていれば、そのパッケージは張り直さずに終了コード 1 とする（重ねて張らない）。
  host が `rm -rf node_modules` で作り直した場合や、machine を再起動した場合など、失効の原因によらず `sync` で回復する。
  bind mount の mount 先が `data/` と同じ device:inode を返すことと、host 側での作り直しで失効が検出できることは、plan の手動検証で確かめる。

- **K10: ヘルパーの出力の契約。**
  - 標準出力はレコードだけを出す。1 レコード 1 行で、`<type>\t<path>` とする。`type` は `empty`（VM 側が空）、`mounted`、`skipped` のいずれか。
  - パスは K6 で制御文字（末尾の改行を含む）を含まないことを確かめたものだけなので、タブと改行で区切れる。
  - 診断と警告は標準エラーにだけ出す。launcher は未知の `type` を無視する。
  - 契約の版: `--contract` は標準出力に整数 1 つを出して終了コード 0 で終わる。launcher は自分の期待する版と**完全一致**を要求し、一致しない・取得できない（コマンドが無い、非 0）場合は K4 の警告を出して `sync` を呼ばない。
    - 守るずれ: launcher は host の `chezmoi apply` で即座に更新され、ヘルパーは VM の次の起動の `maybe_bootstrap` で更新される。bootstrap が途中で失敗すると、新しい launcher と古いヘルパーが組み合わさる。そのとき、古い出力を新しい規則で読み違えないようにする。
    - 両者は同じ dotfiles から配られるので、上位互換の範囲を設ける必要は無い。版を上げるときは両方を同時に変える。
  - 終了コード:
    - 0: すべて収束した。
    - 1: 一部のパッケージで張れなかった（他は処理した）。張るのに失敗した場合のほか、`node_modules` が symlink で張らなかった場合を含む。そのパッケージは host と共有のままで、害が続くため警告に値する。
    - 2: lock を 30 秒以内に取れず、何もしなかった。
    - 3: 張る処理は済んだが、K2 の中止条件で回収をしなかった。
    - 1 と 3 が同時に起きたときは 1 を返す（張れていないパッケージは害が続いているため、こちらを優先する）。回収の中止は標準エラーの理由に併記する。
    - launcher は 1〜3 で、それぞれの理由を区別した警告を出す。lock の待ちは `flock -w 30` とし、長い `remove` の最中に起動しても 30 秒までは待つ。

## Risks

- **R1: host / VM で `git worktree add` / `git worktree remove` を直接使うと、近道（K7）を経ない。**
  - VM で直接 add した worktree は、次の `sync`（次の起動）まで mount が無い。その間に VM で install すると、host の worktree に linux 用パッケージが入る。
  - VM で直接 remove すると、VM ローカルの中身を消してから mountpoint の削除で失敗する。
  - → 規約上、worktree の作成と削除はこの 2 つのツールに限っている。直接の操作は規約外の経路として、docs の警告表に次の行を書く。
    - 症状: host のその worktree で `tsc` が `Unable to resolve @typescript/typescript-darwin-arm64` で落ちる（host の `node_modules` に linux 用パッケージが入った）。
    - 回復手順: `agent-vm` を起動し直してから、host のその worktree で install し直す。
  - host の `node_modules` に linux 用パッケージが入ったことを自動で検出する仕組みは、Phase 1 では作らない（下記「提供しない体験」）。
- **R2: K1 は、host 側の workspace のパッケージにも空の `node_modules` ディレクトリ（mount 先）を作る。**
  Node のモジュール解決は、空の `node_modules` を素通りして親へ進むので、host の動作は変わらない。git は空のディレクトリを追跡しないので、`git status` にも出ない。
  → docs に「host に空の `node_modules` が現れることがある」と書く。plan の手動検証で、npm の workspace で host の `npm install` と `tsc` が変わらないことを確かめる。
- **R7: パッケージ数の多い monorepo では mount の数が増える。**
  → `sync` は、既に有効な mount（K9 の inode 一致）を飛ばすので、2 回目以降は `stat` だけで済む。上限は worktree ごとに 500 件（K6）。
- **R3: VM の Claude は、保護フックのため mount を手で張り直せない。**
  → 回復手順はすべて、`agent-vm` の起動し直しか、ヘルパーのコマンドにする。手で `mount` を打つ手順は書かない。
- **R4: 初回は VM 側でも install が要り、ディスクを VM ごとに使う。**
  → K5 の通知で促す。保存先は machine と一緒に消える。
- **R5: VM で `npm ci` などが `node_modules` ディレクトリ自体を消そうとすると、mountpoint のため失敗する可能性がある（未検証）。**
  → plan の手動検証項目に入れる（V5）。**通過条件**: npm / pnpm / yarn / bun の「入れ直し」系のコマンド（`npm ci`、`pnpm install --force`、`yarn install`、`bun install --force`）のそれぞれについて、成功するか、失敗する場合は docs に回避策（中身だけを消してから install）が書かれていること。
- **R6: このリリースの前に、VM の install で host の `node_modules` が linux 用に上書きされていた repo は、壊れたまま残る。**
  - 既存の machine の初回の起動では、`maybe_bootstrap` がヘルパーを入れ、`sync` が空の保存先を張る。host の `node_modules` にエントリがあれば、K5 の通知が出る。
  - ただし、host の `node_modules` の中身が linux 用に壊れていることは、この通知では分からない。
  → docs の移行手順に「このリリース後の最初の起動の前に、VM で install したことのある repo は host で install し直す」と書く。

## Phase 1 で意図的に提供しない体験

### セッションごとの mount namespace の分離

- **代替経路確認**: `home/dot_local/bin/executable_agent-vm:1130`（`session_exec` は `orb -m $m bash -lc` で、machine 共通の namespace で動く）。worktree ごとの分離は、保存先を worktree ごとに分ける K3 で満たせる。
- **非提供対象**: 同じ worktree を複数セッションで別々の `node_modules` にすること。
- **将来の予定**: 必要な実例が出るまで提供しない。

### host の `node_modules` に linux 用パッケージが入ったことの自動検出

- **代替経路確認**: 発生経路は R1（規約外の直接の `git worktree add`）と R6（このリリース前の汚染）に限られる。どちらも docs の警告表に症状と回復手順を書く（R1、R6）。正規の経路（K4、K7）では発生しない。
- **非提供対象**: launcher が host の `node_modules` を走査して、他プラットフォームのパッケージを検出し警告すること。
- **将来の予定**: 規約外の経路での発生が実際に観測されたら、別課題とする。

## 手動検証（plan で実施する項目）

実機（OrbStack の使い捨て machine）でしか確かめられない項目。plan の手動検証の表に、この順で入れる。

- **V1**: `sudo -n perl` の中で 2 つの fd を開き、perl が直接 fork/exec した `mount --no-canonicalize --bind /proc/<perl の pid>/fd/<src> /proc/<perl の pid>/fd/<dst>` が成功し、mountinfo の mountpoint が正規化したパスになる。失敗したら、K6 の 4 を置き換える。
- **V2**: bind mount の mount 先の device:inode が `data/` と一致する（K9 の前提）。mountinfo の該当行の root 欄と major:minor の実際の形式（btrfs の subvolume の接頭辞の有無）を記録し、K3 の末尾一致で自分の mount として判定できる。
- **V3**: host で `rm -rf node_modules && mkdir node_modules` した後、VM の `sync` が失効を検出して張り直す。
- **V4**: npm workspace（Case B 相当）を host と VM の両方で install し、両側で `tsc` と `oxlint` が動く。host に現れる空の `node_modules` で、host の `npm install` と `tsc` が変わらない（R2）。
- **V5**: R5 の通過条件。
- **V6**: VM の Claude から `git-worktree-create` を実行して、保護フックに止められず `attach` が働く（K6 の参照の実地確認）。

## ISO 25010 次元選択

具体的なテストケースは plan-N.md に書く。spec では、各特性で必ず覆う場面を挙げる。

- **機能適合性（機能正確性）**: VM と host で、それぞれのプラットフォームの `tsc` が動く。worktree の作成と削除（VM で作る、host で作る、cleanup で消す）で mount が追従する。
- **信頼性（障害許容性・回復性）**:
  - ヘルパーの失敗が起動を止めない。
  - 失効した mount（再起動、host 側での作り直し）が次の `sync` で回復する。
  - 一覧の取得失敗や空の一覧で、保存先が消えない。
  - remove の失敗で張り直される。
  - `sync` と cleanup が並行しても、張り直しと削除が交錯しない。
- **セキュリティ（完全性）**:
  - repo の外を指す worktree の登録、symlink の `node_modules`、親ディレクトリの symlink、制御文字を含むパス、`/`・`/etc`・`$HOME` を、ヘルパーが拒否する。
  - 不正な key のディレクトリを削除しない。
- **互換性（共存性・相互運用性）**:
  - host での `git-worktree-create` / `git-worktree-cleanup` の既存テストがそのまま通る。`agent-vm` が無い環境では、ツールの挙動が変わらない。
  - 契約テスト: ツールがヘルパーを `attach <wt>` / `remove <wt> -- git -C <main> worktree remove -- <wt>` の形で呼ぶ。host の `git-worktree-create` が `agent-vm node-modules-sync` を呼び、終了コード 0 のときは何も表示しない。launcher が `--contract` の不一致と、終了コード 1〜3 を区別して警告する。
- **対象外**: 性能効率性（`sync` は worktree 数ぶんの `stat` と `findmnt` だけで、計測対象にならない）、使用性（追加の UI は通知 1 行で、警告表の既存書式に従う）、移植性（Linux の VM 専用で、macOS では実行しない）。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘: cleanup の detach と `git worktree remove` の間に、並行する `sync` が張り直す競合がある。remove が拒否されたときに保存先が消えたまま残る。一覧は VM の agent が書き換えられるので、K6 の限定は成立しない（親の symlink、TOCTOU）。再起動後に一覧から外れた保存先を回収できない。host 側での mountpoint の削除や再作成が未検証。「4 PM で成立」は過大な主張。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘: docs/agent-vm.md と `.chezmoiignore` を変更対象に明記していない。mount 先ディレクトリの作成を書いていない。VM の Claude → worktree 用ツール → sudo mount の経路が保護フックに止められないか未確認。K6 の拒否のテスト計画が無い。

### decision-quality-reviewer
- verdict: pass
- 主指摘: 支配軸は整合している。advisory: R1/R3 の窓で host に漏れる害が、通知なしに放置される。

### greenfield-perspective-reviewer
- verdict: needs-work
- 主指摘: セッション途中の worktree（host で作ったもの、直接の `git worktree add`）が次の起動まで共有のまま残り、元のバグが再発する。PM 非依存は pnpm でしか検証していない（hoisted を検証するか、Goal を狭める）。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: 汎用の worktree 用ツールが agent-vm 専用のヘルパーに依存している。汎用のフックの差し込み口にするか、結合を意図的と明記する。`sync` が正であることを明記する。`empty` の出力形式が空白・改行に耐えない。host 側の ignore の書き方を明記する。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: `git worktree list` は agent が偽造できる。正規化したパスが repo 内にあることを確かめる必要がある。確認から mount までの TOCTOU がある（fd 経由か、mount 後の検証）。削除してよいパスを `^[0-9a-f]{16}$` の保存先に限り、保存先の親は root 所有にする。出力は NUL 区切りにする。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: ヘルパーの配布経路（chezmoi か cloud-init か）と、ADR-0021 K9 との関係を書いていない。一覧の取得失敗や空の一覧で、全保存先を消すおそれがある。stdout の契約（区切り、stderr の分離、版）が無い。旧 machine で警告が毎回出ると警告慣れを招く。

## Intent Alignment Triage (Round 1)

- **Original Order**: mac と agent-vm の VM で共有される `node_modules` のせいでネイティブモジュール（TS7 など）が片側で壊れる問題を、agent-vm で作るすべての環境について、repo 側の作業なしで解く。ユーザーは B'（VM 側の bind mount）を選び、worktree を「起動時の sync ＋ worktree 用ツールでの張り外し」で扱うことを明示した。
- **採用（22 件）**:
  - logic-validator: 競合、remove 失敗、一覧の信頼、回収、host 側の作り直し、`package.json` の無い repo、K5 の定義、テスト計画、K6 の chezmoiignore の具体化、参照行の修正。
  - scope-justification-reviewer: Files の明記、mount 先の作成、フックの経路の確認、K6 のテスト。
  - greenfield-perspective-reviewer: host で作った worktree への追従（hoisted は検証する側を採用）、install 自動化はしない理由の明記、host 側の `rm -rf` の扱い。
  - architecture-boundary-analyzer: 結合の明記と契約テスト、`sync` が正、出力形式、ignore の書き方。
  - security-vulnerability-analyzer: 包含検査、TOCTOU、削除パスの制限、出力形式、脅威モデルの明記。
  - data-contract-evolution-evaluator: 配布経路と K9、中止条件、stdout の契約、旧 machine の警告。
  - decision-quality-reviewer: 漏れの窓の扱い（advisory）。
- **除外（2 件）**:
  - greenfield-perspective-reviewer「Goal の文言を、検証済みの範囲（pnpm）まで狭める」: ユーザーの要件「PM の種類と repo に依存しない」を縮める提案のため除外した。同じ指摘の「hoisted を実験で検証する」側を採用した。
  - logic-validator「Goal の『PM の種類に依存しない』を弱める」: 同じ理由で除外した。根拠の過大な主張は、採用案の記述の修正と追加実験で対処した。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: needs-work
- 主指摘: Round 1 の競合・回収・一覧の信頼は解消した。新規の指摘は次のとおり。worktree ごとの `git ls-files` が失敗または空のとき、その worktree の保存先を回収してしまう。終了コード 2 が K2 の「追加だけ」と矛盾する。K5 が host の `.cache` などで誤通知し、パッケージごとに 1 行出る。列挙が `node_modules` の中の `package.json` を除外しない。`mount` はパスを正規化するため、`/proc/<pid>/fd` が効かない可能性がある（`--no-canonicalize` が要り、未検証）。`remove` のパス境界を一致させていない。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘: Round 1 は解消し、範囲の逸脱は 0 件。残りは説明の追加。K6 の各仕組みが防ぐ事故の対応、`--contract` が守るずれ、R7 で上限を設けない理由、手動検証項目（R5、R2）を plan の表に入れること。

### decision-quality-reviewer
- verdict: pass
- 主指摘: 支配軸は整合している。advisory: K6 の fd 経由の mount と事後検証の二重化は、脅威モデル（事故を防ぐ柵）に対して過剰の可能性がある。host への漏れの検出は non-goal に残してよい。

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: Round 1 の 4 件は解消した。R5（`npm ci`）の手動検証は、回避策の記載を通過条件にすること。R1 の docs の行は、症状と回復手順を具体的に書くこと。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: host の `git-worktree-create` → `agent-vm node-modules-sync` の経路に、契約テストが無い。machine が停止中・machine が無いときの終了コードが決まっていない。agent-vm を使わない repo で何もせずに終える条件が書かれていない。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: 親ディレクトリの差し替えは、開いた後の fd の実パスで再検査する。mount の元（`data/`）も fd で固定する。外すときは検証済みの mount を対象にする。パッケージ数の上限を設ける。`ls-files` の失敗を中止条件に加える。key と `path` の対応を検査する。lock は root 所有の場所に置く。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: 契約の版を完全一致で照合するのか上位互換を許すのか、`--contract` 自体の終了コードが未定義。終了コード 2 が「何もしなかった」と「追加だけ行った」の両方を表す。保存先の `path` を読み戻すときも K6 の検査を通す。旧 machine の初回起動で何が起きるかを docs に書く。

## Intent Alignment Triage (Round 2)

- **採用（26 件）**: 上記の全指摘を採用した。decision-quality-reviewer の「K6 は過剰」と security-vulnerability-analyzer の「K6 を強める」は逆向きなので、K6 を 1 本の手順にまとめ、各段が防ぐ事故を明記する形で両方に応えた。
- **除外（0 件）**: 元のオーダーの範囲を縮める指摘は無かった。

<!-- auto-review: verdict=needs-work; hash=2ac8693d3c7264b6e93d01d87f040fd904c45d021df7e4dd995f6c2e7a4e5162; design-hash=8231b721a3fe8a97da7d04a9218179e31e50d484e609b0a3c03d0434c02d1841; round=1; at=2026-10-02T03:43:42.783Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=22; excluded=2; at=2026-10-02T03:46:39.575Z -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: needs-work
- 主指摘: 「対象のパッケージが 0 件」を中止条件にすると、JS でない repo で起動のたびに終了コード 3 の警告が出る。mountinfo の root 欄の完全一致は btrfs の subvolume の接頭辞で外れうる（未検証）。fd を渡す mount で使う pid と、sudo が fd を閉じる問題が曖昧。上限を超えたときと symlink の場合の終了コードが未定義。

### scope-justification-reviewer
- verdict: pass
- 主指摘: Round 2 の指摘はすべて解消した。plan で、500 件の上限と `ls-files` の失敗のテストケースを書くこと。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: Round 2 の 3 件は解消した。plan で、`node-modules-sync` の 3 つの場合（machine の記録が無い、停止中、起動中）をテストに列挙すること。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: S1〜S5 は脅威モデルに照らして解消した。残りは小さな追記。外す対象を自分の行に厳密に絞る（エスケープの復号、重ねた mount を剥がさない）。遅延 unmount の後に行が残っていないか確かめる。上限を超えたときは回収を中止する。許容する残余を明記する。worktree の引数を正規化してから比べる。

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: Round 2 の 4 件は解消した。終了コード 1 と 3 が同時に起きたときの優先順位を決めること。

## Intent Alignment Triage (Round 3)

- **採用（12 件）**: logic-validator 4 件、security-vulnerability-analyzer 5 件、scope-justification-reviewer・architecture-boundary-analyzer・data-contract-evolution-evaluator 各 1 件（テストケースの列挙と終了コードの優先順位）。どれも本義を保ったまま、正確さを上げる指摘である。テストケースの列挙は plan で扱う。
- **除外（0 件）**。

### decision-quality-reviewer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### greenfield-perspective-reviewer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=c1255468512f2d48f3b1ee3fdd76fd35c25659703ca18e964b8bb5633341c0ed; design-hash=2825cf54ed619870de4c222d28f2d9a4b46323bf9a9ba21df942f3343f2b97c3; round=2; at=2026-10-02T03:50:33.786Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=26; excluded=0; at=2026-10-02T03:50:33.804Z -->

## Reviewer Outputs (Round 4)

### logic-validator
- verdict: pass
- 主指摘: Round 3 の 4 件は解消し、新たな矛盾は無い。軽微な点（手順 1 の作成者、上限超過でルートに `package.json` が無い場合）は反映済み。

### decision-quality-reviewer
- verdict: pass
- 主指摘: K6 は脅威モデルと各段の事故の対応が明記され、守る対象（保存先の削除、host と共有の木への mount）に対して釣り合っている。plan では V1 を最初の関門にし、保証を担う 5 と K2 のテストを先に書くこと。

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: 後退も新たな野心ギャップも無い。R5 の通過条件（V5）と R1 の docs の行は要求どおり。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: Round 3 の 5 件は、事故を防ぐ柵の脅威モデルに照らして解消した。advisory（K9 の遅延 unmount にも同じ行の絞り込みを適用）は反映済み。

## Intent Alignment Triage (Round 4)

- **採用（5 件）**: logic-validator の軽微 2 件、security-vulnerability-analyzer の advisory 1 件（spec に反映済み）。decision-quality-reviewer の plan への助言 2 件（V1 を最初の関門にする、保証を担う段のテストを先に書く）は plan で扱う。
- **除外（0 件）**。

### scope-justification-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=e8e06c644b77c132aab08c8d6b2abe3be883b17df05058569f41d22fc9d5c2f8; design-hash=60d2bc4b465b4c7f62b5b4274e8a545c6f48f52948a5fc9690d57db58261549d; round=3; at=2026-10-02T03:53:16.961Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=12; excluded=0; at=2026-10-02T03:53:24.716Z -->

<!-- auto-review: verdict=pass; hash=e2c7ba57e41e8bfa1714bdcfe7eae1040274fcc43701ea97798c7fe3034f76ec; design-hash=14da1a3518f931fb72a680d55fb02f0e4f81a810cfa8b4f1a5881506d7797bdc; round=4; at=2026-10-02T03:54:22.307Z; reviewers=logic-validator+decision-quality-reviewer+greenfield-perspective-reviewer+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=5; excluded=0; at=2026-10-02T03:54:22.369Z -->
