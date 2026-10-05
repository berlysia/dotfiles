# Plan: git-worktree-create が依存をインストールする

## Goal

`git-worktree-create <branch>` を実行した直後に、その worktree でテストや lint を実行できるようにする。
PM（package manager）が一意に決まり、install しても安全な場合は、スクリプトが依存をインストールする。
PM は分かるが実行しない場合は、実行しなかった理由と、実行すべきコマンドを 1 行で示す。
PM を決める手がかり（`packageManager` フィールドと lockfile）が無い repo では、何もしない。

調査の全文は同じディレクトリの `research.md` にある（F1〜F5 はその節の番号）。

## Experience Delta

- **変更前**: `git-worktree-create feat` の後、worktree に `node_modules` が無い。利用者（人と Claude）は PM を自分で判定して install する。忘れると、最初の `test` / `typecheck` が「モジュールが無い」で落ちる。
- **変更後**: `git-worktree-create feat` が `📦 Installing dependencies: pnpm install --frozen-lockfile` と表示して install まで済ませ、`✓ Dependencies installed` で終わる。install しなかった場合は、理由と実行すべきコマンドが出力に残る。
- `package.json` を持たない repo では、依存に関する行は増えない。変わるのは次の 3 点である。`💡 To switch` の行が agent-vm の警告より前に出て、パスが引用される。`-` で始まる未知の引数を usage つきで拒否する。先頭以外の `--help` / `-h` が、無視されずに help を出す。

## Key Decisions

- **K1: 既定で install を実行する。`--no-install` を付けると、コマンドの提示だけにする。**
  オーダーの第一希望は「自動で行う」である。自動化を妨げる制約を調べ、既定を「実行しない」にする理由にはならないと判断した。場面を限る制約は K2〜K4 と K8 で扱う。
  1. Claude 経由の承認の範囲: `(npm|pnpm|yarn|bun) install` は単体ですでに自動承認されている（F1）。`git-worktree-create` の中で実行しても、Claude が承認なしにできることは増えない。
  2. ADR-0022 は launcher の自動 install を、「PM の判定と lifecycle スクリプトの方針は repo ごとに違い、agent の作業と競合する」として却下した。3 つの理由を次のように扱う。
     - 競合: 作成直後の worktree では、作業している agent がいない。当てはまらない（F3）。
     - PM の判定: 一意に決まらなければ実行しない（K2）。
     - lifecycle スクリプト: スクリプトは PM のフラグで方針を上書きしない。依存の script の可否は、PM と repo の設定（pnpm の `onlyBuiltDependencies`、bun の `trustedDependencies`、`.npmrc`）に従う。ルートの `package.json` の script（`preinstall` / `postinstall` / `prepare`）と `.pnpmfile.cjs` は、どの設定でも実行される。これは手で install する場合と同じである。
  3. 人が手で実行する場合は、install と見えないコマンドが、checkout したブランチのコードを実行するようになる。自分の checkout にあるコード（ローカルのブランチ、今の HEAD から作るブランチ）では受容する。origin から初めて持ってくるブランチは K8 で除く。
  - 却下: **提示のみ**（install は常に利用者が実行する）。オーダーの代替案であり、`--no-install` と K2・K3・K8 の場合の表示として残す。既定にすると、変更前と同じく「忘れると落ちる」が残る。
  - 却下: **`--install` を付けたときだけ実行する**。呼び出し側（`/create-worktree`、`/issue-pr`、人の手入力）がすべてフラグを覚える必要があり、付け忘れたときの体験は変更前と同じになる。
  - 参照: `home/dot_claude/hooks/implementations/permission-auto-approve.ts:132-133`、`:172-173`
  - 参照: `docs/decisions/0022-agent-vm-node-modules.md:29`（起動時に install しない）、`:49`（launcher の自動 install を却下した理由）、`:40`（worktree の作成と削除は 2 つのツールに限る）
- **K2: PM は `packageManager` フィールド、次に lockfile で判定する。一意に決まらなければ実行しない。**
  worktree のルートの `package.json` だけを見る。無ければ何もしない。
  1. `packageManager` が `pnpm@` / `bun@` / `npm@` / `yarn@` で始まれば、その PM を使う。
  2. そうでなければ lockfile を数える。pnpm は `pnpm-lock.yaml`、bun は `bun.lock` / `bun.lockb`、npm は `package-lock.json` / `npm-shrinkwrap.json`、yarn は `yarn.lock`。
     lockfile を持つ PM が 1 つならそれを使う。2 つ以上なら実行せず、見つけた lockfile の名前を警告する。0 なら何も出さない（PM を決める手がかりが無く、提示するコマンドを作れない）。
  - PM を取り違えると実害がある（F4 の `completion-gate.ts` のコメント）。`completion-gate.ts` の「無ければ pnpm」という既定は採らない。
  - JSON の読み取りは `sed` の 1 回の呼び出しで行う。jq への依存を足さない（F5）。読み取りに失敗したら、宣言なしとして扱う。
  - 参照: `home/dot_claude/hooks/implementations/completion-gate.ts:92-104`
  - 参照: `home/dot_claude/CLAUDE.md:15`（「lockfile / `packageManager` フィールドに従う」）
- **K3: 実行するのは、lockfile を書き換えない install だけにする。**
  - pnpm と bun は `install --frozen-lockfile`、npm は `ci`。判定した PM 自身の lockfile があるときだけ実行する。作ったばかりの worktree に差分を作らないためである。この repo の root の install も同じ形を使う（F4）。
  - 判定した PM の lockfile が無いとき（`packageManager` だけで決まった場合）は実行せず、`<pm> install` を提示する。install が lockfile を新しく書くためである。
  - yarn は実行せず、`yarn install` を提示する。lockfile を固定するフラグが v1（`--frozen-lockfile`）と v2 以降（`--immutable`）で違う。v2 以降の既定（PnP）は `node_modules` ではなく `.pnp.cjs` と `.yarn/` を worktree に書くので、agent-vm の差し替え（`node_modules` だけが対象）の外に出る。
  - install の標準入力は `/dev/null` にする。確認を求める PM や corepack が、Claude の Bash 呼び出しの中で入力待ちのまま止まらないようにするためである。確認が要る場合、install は失敗し、K5 の警告になる。
  - PM の実行ファイルは、worktree に `cd` する前に絶対パスで解決する。PATH に相対のエントリがある環境で、checkout したブランチの中のファイルを PM 本体として実行しないためである。PM が起動する子プロセス（`node`、`sh`）の解決までは保証しない。
  - 参照: `home/.chezmoiscripts/run_after_10-install-root-deps.sh.tmpl:54`
- **K4: agent-vm の VM では、`node_modules` の差し替えが済んだ worktree でだけ install する。host では、install の後に sync を呼ぶ。**
  - VM で `attach` が成功した（終了コード 0。ヘルパーは、対象のパッケージを 1 つでも取りこぼすと 0 以外で終わる）: install する。
  - VM で `attach` が失敗した: install しない。既存の警告が「do not install there until this succeeds」と回復手順を出しているので、行を足さない。lockfile が 2 種類ある場合の警告も出さない（install を勧める文になるため）。
  - VM の中でヘルパーが無い: install しない。`package.json` から PM か lockfile が見つかる worktree に限り、理由と回復手順を警告する。今は何も出ないが、install をスクリプトが担う以上、実行しなかったことを黙らない。
  - host: install を先に実行し、その後に `agent-vm node-modules-sync` を呼ぶ（今は sync だけを呼んでいる）。sync は VM に、host と共有するツリーの中へ mount 先の `node_modules` を作らせる。sync の後に host で `node_modules` を消して作り直すと、VM の mount は失効し、次の sync まで張り直されない（2026-10-02 の実機の確認 V26）。先に install すれば、sync は出来上がった `node_modules` の上に mount を張るだけで済む。これは本体の checkout で起動のたびに起きている状態と同じである。sync の成否は install に影響しない。
    - この順序では、動いている machine があると、sync が `node_modules in the VM is empty for <wt> (the host has one)` の案内を出す（V27 で確認済みの既存の行）。VM 側にも install が要る、という正しい案内である。
  - VM の中で、mount された `node_modules` に対する `npm ci`、`pnpm install --force`、`bun install --force` は終了コード 0 で、mount も保たれる（2026-10-02 の実機の確認 V28）。`attach` の後に install する順序で問題ない。V28 が試したのは `--force` の形で、この plan が実行する `--frozen-lockfile` の形そのものは記録に無い（`node_modules` を作り直す `--force` と `npm ci` で保たれたことからの推定である）。
  - 参照: `home/dot_local/bin/executable_git-worktree-create:113-129`
  - 参照: `home/dot_local/bin/executable_agent-vm-node-modules:353-356`（取りこぼしがあれば 0 以外）
  - 参照: `docs/agent-vm.md:102`、`:109-116`、`:414-423`（V26〜V28 の結果）
- **K5: install の失敗は作成を失敗させない。作成の経路の終了コード 0 は「worktree を作った」を意味する。**
  警告 1 行に終了コードと再実行のコマンドを入れる。既存の agent-vm 連携と同じ扱いである。PM 自身の出力はそのまま通す。
  「ルートの install が成功した」の合図は、成功時だけに出る `✓ Dependencies installed` の行にする。install の失敗、実行しない場合、Bash の制限時間による打ち切りのどれでも、この行は出ない。
  スクリプトが install を始めたかどうかは、`📦 Installing dependencies` の行で分かる。この行が無ければ、install は始まっていない。呼び出し側が取る行動は、出力の行から決まる（「仕様 > 呼び出し側の読み方」）。
  `💡 To switch to this worktree` の行は、install より前（作成の直後）に出す。打ち切られても、パスが出力に残る。パスは `printf '%q'` で引用する。この行は、人や Claude がそのまま実行する行になるためである（git のブランチ名には `;` や `$` を使える）。
  - 参照: `home/dot_local/bin/executable_git-worktree-create:109-121`、`:130`
- **K6: 今回の範囲は Node の依存のインストールに限る。**
  オーダーの「など付随事項」のうち、根拠を確認できたのは依存のインストールだけである。
  - `mise trust`: 設定ファイルに信頼を与える操作で、install より判断が重い。新しい worktree で mise が trust を求めるかどうかも観測していない。T6 の実機の確認で観測し、結果を Implementation Notes に書く。扱うなら別の変更にする。
  - gitignore されたファイル（`.env` など）の持ち込み: 困った事例を観測していない。
  - repo ごとの任意の処理を登録する仕組み: 設定の置き場は repo の外（`git config --local` など）にも取れるが、登録したい処理が 1 つも挙がっていないので作らない。
  - 参照: `home/dot_local/bin/executable_git-worktree-create:109-130`（付随処理を足す位置）、`scripts/lint-shell.sh:115`（mise の trust error への言及）
- **K7: 新しい ADR は書かず、ADR-0022 に追記する。**
  ADR-0022 は「launcher は install しない」と決め、`git-worktree-create` を差し替えの入口として記述している。作成時に install する理由を ADR から辿れるように、ADR-0022 に「Addendum (2026-10-06)」の節を足す。書くのは 3 点である: 作成時は install を実行すること（launcher は変えない）、却下理由 3 つの扱い（K1 の 2）、VM での前提が `attach` の成功であること（K4）。詳細は `docs/commands/git-worktree-create.md` に書き、互いに参照する。
  記録しない場合に失われるもの: 「launcher は通知だけなのに、なぜ worktree の作成では実行するのか」の答え。
  - 参照: `docs/decisions/0022-agent-vm-node-modules.md:21-24`、`:45-49`
- **K8: origin のブランチから作る worktree では、install を実行せずに提示する。**
  ローカルに無く `origin/<branch>` にあるブランチ（`executable_git-worktree-create:98-101` の分岐）は、この checkout が初めて持ってくるコードである。その `package.json` の script を、install と見えないコマンドで実行しない。
  origin のブランチには、自分以外が書いた内容が入りうる。この repo の規約も、Renovate / Dependabot の PR の中身を「上流パッケージ経由で部分的に攻撃者影響下」と扱っている。
  ローカルのブランチと、今の HEAD から作る新しいブランチでは実行する。提示された 1 行を実行すれば、origin のブランチでも install できる。フラグは足さない。
  出力の行そのものに、origin のブランチなので自動では実行しなかったことと、実行の前に script を見ることを書く。この行を読むのは主に Claude で、次に取る行動を、手順書（`/create-worktree`）を引かなくても出力から決められるようにするためである（2026-10-06、承認の質問への利用者の指示）。
  - 却下: **出所を区別せずに実行する**。Claude 経由の承認の範囲は変わらないが（K1 の 1）、人の手入力では、中身を見る前にコードが走る場面が新しく生まれる。
  - 参照: `home/dot_local/bin/executable_git-worktree-create:94-107`
  - 参照: `home/dot_claude/rules/autonomous-lane.md:35`（「allowlist は injection を防がない」の節）

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

末尾の `💡 To switch to this worktree` の後に、判定した PM の install コマンドを 1 行足す。
スクリプトの差分は判定の関数と表示だけで、実行時間も変わらない。
ただし install は利用者が実行するので、Claude の呼び出しでは `/create-worktree` と `/issue-pr` の手順に「表示された行を実行する」を足す必要がある。手で実行した人は、行を見落とせば変更前と同じ状態になる。

### 白紙設計案 (Greenfield)

ゼロから作るなら、「worktree を作る」と「作業できる状態にする」を 1 つのコマンドの責務にする。
起源: worktree を作る目的は、そこで作業することである。作っただけでテストも実行できない状態を完了とする理由は、最初から設計するなら無い。git 自身も `post-checkout` フックでこの種の準備を想定している。
白紙案はさらに、準備の中身を宣言する形（repo ごとの setup スクリプトや git config）にする。Node の依存に限らず、任意の言語と手順を扱えるためである。

### 採用案と理由

白紙案の前半（作成と準備を 1 コマンドにする）を採り、後半（宣言する仕組み）は採らない。

- 既定で実行する根拠は K1 である（Claude 経由の承認の範囲が変わらない、作成直後は競合しない、危険な場面は K2〜K4 と K8 で除ける）。
- 差分最小案を既定にしない根拠: 呼び出し側は `create-worktree.md:34-41`、`issue-pr.md:14`、人の手入力の 3 つあり、提示だけでは 3 つすべてが追加の 1 手を必要とする。
- 宣言する仕組みを採らない根拠: 宣言が無い repo のための自動判定はどのみち要る。自動判定で足りない具体例は挙がっていない（K6）。
- 差分最小案の中身（コマンドの提示）は、`--no-install` と、実行しない場合の表示として残る。
- 実行しない側の制限（K3 の lockfile なしと yarn、K8 の origin のブランチ）は、白紙から設計しても入る。「作ったばかりの worktree に差分を作らない」と「まだ手元に無かったコードを、install と見えないコマンドで実行しない」は、既存のコードに由来する制約ではない。yarn は、版によるフラグの違いと PnP を扱う分岐を、使っている repo が挙がっていない段階で作らない、という需要の判断である。

## 仕様

### 使い方

```
git-worktree-create [--no-install] <branch-name>
git-worktree-create --help
```

- `--no-install` はブランチ名の前後どちらに置いてもよい。
- `-` で始まる未知の引数は、worktree を作らずに usage を出して終了コード 1 で終わる。今は git が「不正なブランチ名」として拒否している（git のブランチ名は `-` で始められない）。`--no-instal` のような綴り違いに、原因の分かるエラーを返すためである。
- 2 つ目以降のブランチ名は、今までどおり無視する。
- `help` という語は、今までどおり先頭の引数のときだけ help として扱う。`--help` と `-h` は、どの位置にあっても help を出して終了コード 0 で終わり、worktree は作らない（今は、先頭以外の `--help` を無視して作っている）。

### 出力

`<wt>` は `printf '%q'` で引用した worktree のパス、`<cmd>` は K3 のコマンドである。終了コードはすべて 0 である。
`💡 To switch to this worktree: cd <path>` は `✓ Worktree created` の直後に出し、依存に関する行はその後に出す。

| 条件                                                      | 出力先 | 行                                                                                                                                                                                    |
| --------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json` が無い、または PM の宣言も lockfile も無い | —      | なし                                                                                                                                                                                  |
| install を実行する                                        | stdout | `📦 Installing dependencies: <cmd>`                                                                                                                                                   |
| install が終了コード 0                                    | stdout | `✓ Dependencies installed`                                                                                                                                                            |
| install が終了コード N（N≠0）                             | stderr | `⚠️  dependencies are not installed in <wt> (<cmd>: status N); the worktree itself is created. To retry: cd <wt> && <cmd>`                                                            |
| 実行しない（下の 4 つの理由のどれか）                     | stdout | `💡 Dependencies are not installed (<reason>). To install them: cd <wt> && <cmd>`                                                                                                     |
| PM のコマンドが PATH に無い（絶対パスで解決できない）     | stderr | `⚠️  dependencies are not installed in <wt> (<pm> is not on PATH). Once it is: cd <wt> && <cmd>`                                                                                      |
| lockfile を持つ PM が 2 つ以上で、`packageManager` 無し   | stderr | `⚠️  dependencies are not installed in <wt> (found <lockfile>, <lockfile> and no packageManager field in package.json); install with the project's package manager`                   |
| VM で `attach` が失敗                                     | —      | 追加の行なし（既存の警告のみ）                                                                                                                                                        |
| VM でヘルパーが無く、PM か lockfile が見つかる            | stderr | `⚠️  dependencies are not installed in <wt> (agent-vm-node-modules is missing, so node_modules here is shared with the host); recreate the machine from the host: agent-vm rm <repo>` |

`<repo>` は `%q` で引用した本体の checkout である。回復手順は `docs/agent-vm.md:112` の「the helper is missing」の行と同じにする。

「実行しない」の `<reason>` は、上から順に最初に当てはまるものを使う。

| 条件                                    | `<reason>`                                                                                                                          | `<cmd>`        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `--no-install`                          | `--no-install`                                                                                                                      | K3 のコマンド  |
| origin のブランチから作った（K8）       | `not run automatically because the branch comes from origin; an install runs the scripts of its package.json, so review them first` | K3 のコマンド  |
| 判定した PM の lockfile が無い（K3）    | `<pm> has no lockfile here, and an install would write one`                                                                         | `<pm> install` |
| PM が yarn で、`yarn.lock` がある（K3） | `yarn is not run automatically`                                                                                                     | `yarn install` |

VM の 2 つの場合（`attach` の失敗、ヘルパーなし）は、上のどの行よりも優先する。

### 呼び出し側の読み方

`/create-worktree` と `/issue-pr`、`docs/commands/git-worktree-create.md` に、同じ表を書く。上から順に、最初に当てはまる行に従う。`dependencies are not installed` は大文字と小文字を区別せずに探す。

| 出力にある行                                                               | 意味                                                         | 取る行動                                                                                                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `✓ Dependencies installed`                                                 | ルートの install が終了コード 0 で終わった                   | 作業を始める                                                                                                                                                         |
| `do not install there until this succeeds`                                 | VM で差し替えが済んでいない                                  | install しない。その警告の回復手順（`agent-vm-node-modules attach <wt>`）を実行し、成功してから project の PM で install する                                        |
| `agent-vm-node-modules is missing`                                         | VM にヘルパーが無く、`node_modules` が host と共有されている | install しない。host で machine を作り直す必要があることを、ユーザーに伝える                                                                                         |
| `dependencies are not installed` で、理由が `the branch comes from origin` | origin のブランチなので、自動では実行しなかった              | 行に書いてあるとおり、そのブランチの `package.json` の `scripts`（と `.pnpmfile.cjs`）を見てから、表示されたコマンドを実行する。判断がつかなければユーザーに確かめる |
| `dependencies are not installed`（上の 3 つ以外）                          | install していない                                           | その行の手順に従う。行にコマンドが無い場合（lockfile が 2 種類）は、どの PM を使うかをユーザーに確かめる                                                             |
| `📦 Installing dependencies` があり、上のどれも無い                        | install の途中で打ち切られた                                 | `💡 To switch` の行のパスに移り、`📦` の行のコマンドを、制限時間を延ばして実行する                                                                                   |
| どれも無い                                                                 | スクリプトは install を始めていない                          | install しない（Node の project ではないか、PM を決める手がかりが無い）                                                                                              |

`✓ Dependencies installed` が意味するのは、ルートの install の成功だけである。ルート以外の独立したパッケージ（R4）と、host で作ったときの VM 側の install は含まない。

パスをプログラムとして使うときは、`✓ Worktree created:` の行の値（引用していない）を読む。`💡 To switch` の行はシェルに貼るための行で、パスは引用してある（空白は `\ ` になる）。

host で install が打ち切られた場合は、後に続く `agent-vm node-modules-sync` も走っていない。動いている machine があれば、次の起動か `agent-vm node-modules-sync <repo>` で揃う。

### 実装の形

`show_help` の Usage / Options に `--no-install` と、依存のインストールの説明（実行する条件、`✓ Dependencies installed` が合図であること）を足す。
引数の解釈を、次のループに置き換える（`executable_git-worktree-create:56-65` の置き換え）。

```bash
install_deps=true
branch_name=""
if [[ $# -eq 0 ]]; then
    echo -e "${RED}Error: Branch name is required${NC}\n"
    show_help
    exit 1
fi
# The word "help" is the help command only as the first argument, as before
if [[ "$1" == "help" ]]; then
    show_help
    exit 0
fi
while [[ $# -gt 0 ]]; do
    case "$1" in
    --help | -h)
        show_help
        exit 0
        ;;
    --no-install) install_deps=false ;;
    -*)
        # printf, not echo -e: the argument is printed as typed
        printf '%b%s%b\n\n' "$RED" "Error: Unknown option: $1" "$NC"
        show_help
        exit 1
        ;;
    *)
        # Only the first name is used; later ones are ignored, as before
        if [[ -z "$branch_name" ]]; then
            branch_name="$1"
        fi
        ;;
    esac
    shift
done
if [[ -z "$branch_name" ]]; then
    echo -e "${RED}Error: Branch name is required${NC}\n"
    show_help
    exit 1
fi
```

`say_warn` の後に、表示の関数と判定の関数を足す。bash 3.2 で動く書き方に限る（連想配列、`mapfile`、`${var,,}` を使わない）。

```bash
# say_info <color> <message>: a line on stdout, printed without interpreting backslashes in the message
say_info() {
    printf '%b%s%b\n' "$1" "$2" "$NC"
}

# resolve_install <dir>: which install the project at <dir> asks for.
# Sets install_pm (empty when package.json names no package manager and no lockfile does), install_cmd (the command
# to run, or to show), install_skip (why this script does not run it itself; empty when it may), and
# install_conflict (the lockfiles found, when two or more package managers have one and package.json names none).
# A wrong package manager rewrites node_modules, so nothing is guessed: no default, no priority among lockfiles.
resolve_install() {
    local dir=$1 declared pm lock found_pms="" found_locks=""
    install_pm=""
    install_cmd=()
    install_skip=""
    install_conflict=""
    [[ -f "$dir/package.json" ]] || return 0
    # One sed and no pipe: under pipefail, a reader that exits early would end this script after the worktree exists
    declared=$(sed -n '/"packageManager"/{s/.*"packageManager"[[:space:]]*:[[:space:]]*"\([a-z]*\)@.*/\1/p;q;}' "$dir/package.json") || declared=""
    for lock in pnpm:pnpm-lock.yaml bun:bun.lock bun:bun.lockb npm:package-lock.json npm:npm-shrinkwrap.json yarn:yarn.lock; do
        pm=${lock%%:*}
        lock=${lock#*:}
        [[ -f "$dir/$lock" ]] || continue
        found_locks="${found_locks:+$found_locks, }$lock"
        case " $found_pms " in *" $pm "*) ;; *) found_pms="${found_pms:+$found_pms }$pm" ;; esac
    done
    case "$declared" in
    pnpm | bun | npm | yarn) install_pm=$declared ;;
    *)
        case "$found_pms" in
        "") return 0 ;;
        *" "*)
            install_conflict=$found_locks
            return 0
            ;;
        *) install_pm=$found_pms ;;
        esac
        ;;
    esac
    case " $found_pms " in
    *" $install_pm "*) ;;
    *)
        install_cmd=("$install_pm" install)
        install_skip="$install_pm has no lockfile here, and an install would write one"
        return 0
        ;;
    esac
    case "$install_pm" in
    pnpm | bun) install_cmd=("$install_pm" install --frozen-lockfile) ;;
    npm) install_cmd=(npm ci) ;;
    yarn)
        # The flag that keeps the lockfile differs between yarn 1 and later versions, and Plug'n'Play writes outside
        # node_modules, where the agent-vm mount does not reach
        install_cmd=(yarn install)
        install_skip="yarn is not run automatically"
        ;;
    esac
}

# install_dependencies: install what the new worktree asks for, or say why not and what to run.
# Reads worktree_path, repo_root, install_deps, branch_source, deps_target. Never fails: the worktree exists.
install_dependencies() {
    local wt_q cmd_text skip pm_path status=0
    resolve_install "$worktree_path"
    [[ -n "$install_pm$install_conflict" ]] || return 0
    wt_q=$(printf '%q' "$worktree_path")
    case "$deps_target" in
    attach-failed) return 0 ;; # the attach warning already says not to install and how to recover
    no-helper)
        say_warn "dependencies are not installed in $wt_q (agent-vm-node-modules is missing, so node_modules here is shared with the host); recreate the machine from the host: agent-vm rm $(printf '%q' "$repo_root")"
        return 0
        ;;
    esac
    if [[ -n "$install_conflict" ]]; then
        say_warn "dependencies are not installed in $wt_q (found $install_conflict and no packageManager field in package.json); install with the project's package manager"
        return 0
    fi
    cmd_text="${install_cmd[*]}"
    skip=$install_skip
    if [[ "$install_deps" != true ]]; then
        skip="--no-install"
    elif [[ "$branch_source" == remote ]]; then
        # Code this checkout has not had before: its package.json scripts are not run by a command that does not look
        # like an install
        skip="not run automatically because the branch comes from origin; an install runs the scripts of its package.json, so review them first"
    fi
    if [[ -n "$skip" ]]; then
        say_info "$BLUE" "💡 Dependencies are not installed ($skip). To install them: cd $wt_q && $cmd_text"
        return 0
    fi
    # Resolved before the cd, and only to an absolute path: a relative PATH entry must not pick a file of the branch
    pm_path=$(command -v "$install_pm") || pm_path=""
    case "$pm_path" in
    /*) ;;
    *)
        say_warn "dependencies are not installed in $wt_q ($install_pm is not on PATH). Once it is: cd $wt_q && $cmd_text"
        return 0
        ;;
    esac
    say_info "$BLUE" "📦 Installing dependencies: $cmd_text"
    (cd "$worktree_path" && "$pm_path" "${install_cmd[@]:1}" </dev/null) || status=$?
    if [[ $status -eq 0 ]]; then
        say_info "$GREEN" "✓ Dependencies installed"
    else
        say_warn "dependencies are not installed in $wt_q ($cmd_text: status $status); the worktree itself is created. To retry: cd $wt_q && $cmd_text"
    fi
}
```

`"${install_cmd[@]:1}"` を展開するのは実行する分岐だけで、そのとき配列は 2 要素以上を持つ（`pnpm install --frozen-lockfile`、`bun install --frozen-lockfile`、`npm ci`）。bash 3.2 の `set -u` は空の配列の展開で落ちるが、この位置では空にならない。

ブランチの分岐（`:94-107`）で、出所を変数に持つ。それぞれの分岐の中で `branch_source=local` / `branch_source=remote` / `branch_source=new` を代入する。

作成の後（`:109-130`）を、次の順序に置き換える。agent-vm の呼び出しと警告の文面は変えない。

```bash
echo -e "${GREEN}✓ Worktree created: $worktree_path${NC}"
# Before the install: a caller that is cut off while it runs still has the path
say_info "$BLUE" "💡 To switch to this worktree: cd $(printf '%q' "$worktree_path")"
# Whether an install in the new worktree lands in its own node_modules: "yes", "attach-failed" (warned below), or
# "no-helper" (inside a machine whose node_modules is still the host's).
deps_target=yes
if [[ -e "${AGENT_VM_MARKER:-/etc/agent-vm}" ]]; then
    if command -v agent-vm-node-modules >/dev/null 2>&1; then
        # （既存の attach の呼び出しと警告。失敗した分岐の中に deps_target=attach-failed を足す）
    else
        deps_target=no-helper
    fi
    install_dependencies
else
    # On the host the install comes first: the sync makes a running machine create its mount points in this tree,
    # and an install that recreates node_modules afterwards would remove them
    install_dependencies
    if command -v agent-vm >/dev/null 2>&1; then
        # （既存の node-modules-sync の呼び出しと警告）
    fi
fi
```

コード中の括弧つきの日本語 2 行は、既存の `:115-121` と `:124-128` をそのまま置く位置を示す。既存のコメント（`:110-112`）は、VM と host の順序の違いを書いた文に直す。

## Tasks

テストは `tests/git-worktree-create/run.sh` に足す。実行は `/bin/bash tests/git-worktree-create/run.sh [test_name...]`。
各タスクは、テストを書く → 失敗を確かめる → 実装する → 通過を確かめる、の順に進める。

### T1: テストの道具を足す

- 編集: `tests/git-worktree-create/run.sh:39-63`
- 参照: `tests/git-worktree-create/run.sh:48-63`（`stub` と `run_create`）

1. `stub` が作るスクリプトに、作業ディレクトリを `$STUB/<command>.cwd` に書く行を足す: `printf 'pwd -P >%q\n' "$STUB/$1.cwd"`。既存のテストはこのファイルを見ないので、結果は変わらない。
2. `run_create` を `run_create <marker> <args...>` にする（`bash "$CREATE" "${@:2}"`）。既存の呼び出し（引数 2 つ）はそのまま通る。
3. fixture を足す。
   ```bash
   # commit_file <path> [content]: a file committed in $REPO, so that a new worktree checks it out
   commit_file() {
     printf '%s\n' "${2:-}" >"$REPO/$1"
     git -C "$REPO" add -- "$1"
     git -C "$REPO" commit -q -m "add $1"
   }
   # push_origin_branch <name> <branch>: HEAD of $REPO as <branch> on a bare origin, known locally only as origin/<branch>
   push_origin_branch() {
     git init -q --bare "$TMP_BASE/$1/origin.git"
     git -C "$REPO" remote add origin "$TMP_BASE/$1/origin.git"
     git -C "$REPO" push -q origin "HEAD:refs/heads/$2"
     git -C "$REPO" fetch -q origin
   }
   ```
4. 確認: `/bin/bash tests/git-worktree-create/run.sh` が `PASS: 26 FAIL: 0`（2026-10-06 に実行して得た現行の件数）のまま通る。

### T2: 引数の解釈（`--no-install`、未知のオプション）

- 編集: `home/dot_local/bin/executable_git-worktree-create:13-65`
- テスト: `tests/git-worktree-create/run.sh`
- 参照: `home/dot_local/bin/executable_git-worktree-create:56-65`

足すテスト（失敗を確かめてから「実装の形」の引数ループと `show_help` を実装する）:

- `test_D15_unknown_option_creates_nothing`: `run_create "$AGENT_VM_MARKER" --bogus feat` → `STATUS` が 1、`$REPO/.git/worktree/feat` が無い、出力に `Unknown option: --bogus` がある。
- `test_D18_help_exits_zero`: `run_create "$AGENT_VM_MARKER" --help` → `STATUS` が 0、出力に `--no-install` がある。
- `test_D19_no_arguments_exit_one`: `run_create "$AGENT_VM_MARKER"` → `STATUS` が 1、出力に `Branch name is required` がある。
- `test_D30_help_word_after_the_name_is_not_help`: `run_create "$AGENT_VM_MARKER" feat help` → `STATUS` が 0、`$REPO/.git/worktree/feat` がある（`help` は 2 つ目の名前として無視する）。
- `test_D31_help_flag_anywhere_creates_nothing`: `run_create "$AGENT_VM_MARKER" feat --help` → `STATUS` が 0、出力に `Usage:` があり、`$REPO/.git/worktree/feat` が無い。
- `test_D32_the_shown_path_is_quoted`: `make_repo "d 32"` の後に `run_create "$AGENT_VM_MARKER" feat` → 出力に `To switch to this worktree: cd ` と、`printf '%q' "$REPO/.git/worktree/feat"` の結果（空白を `\ ` にしたパス）が続けてある。
- `test_D27_later_names_are_ignored`: `run_create "$AGENT_VM_MARKER" a b` → `STATUS` が 0、`$REPO/.git/worktree/a` があり、`$REPO/.git/worktree/b` が無い（今の挙動を固定する）。

### T3: PM の判定と install（host）

- 編集: `home/dot_local/bin/executable_git-worktree-create`（`say_info`、`resolve_install`、`install_dependencies`、`branch_source`、作成の後の順序）
- テスト: `tests/git-worktree-create/run.sh`
- 参照: `home/dot_claude/hooks/implementations/completion-gate.ts:92-104`、`home/dot_local/bin/executable_git-worktree-create:94-130`

どのテストも `make_repo` の後に `commit_file package.json '{}'` と lockfile を commit し、marker は `$AGENT_VM_MARKER`（VM ではない）を渡す。断りが無ければブランチは `feat`（今の HEAD から作る新しいブランチ）で、`<wt>` は `$REPO/.git/worktree/feat`。

| テスト                                         | fixture                                                                                                                                                           | stub              | 期待                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test_D1_pnpm_lockfile_installs_frozen`        | `pnpm-lock.yaml`                                                                                                                                                  | `pnpm 0`          | `pnpm.log` が `install` / `--frozen-lockfile` の 2 行。`pnpm.cwd` が `<wt>`。出力に `Installing dependencies: pnpm install --frozen-lockfile` と `Dependencies installed`。`STATUS` 0                                                                                                     |
| `test_D2_bun_lockfile_installs_frozen`         | `bun.lock`                                                                                                                                                        | `bun 0`           | `bun.log` が `install` / `--frozen-lockfile`                                                                                                                                                                                                                                              |
| `test_D3_npm_lockfile_runs_ci`                 | `package-lock.json`                                                                                                                                               | `npm 0`           | `npm.log` が `ci` の 1 行                                                                                                                                                                                                                                                                 |
| `test_D4_yarn_is_only_shown`                   | `yarn.lock`                                                                                                                                                       | `yarn 0`          | `yarn.log` が無い。出力に `Dependencies are not installed (yarn is not run automatically). To install them: cd <wt> && yarn install`                                                                                                                                                      |
| `test_D5_declared_pm_without_its_lockfile`     | `package.json` が `{"packageManager": "pnpm@10.0.0"}`、`bun.lock`                                                                                                 | `pnpm 0`、`bun 0` | `pnpm.log` も `bun.log` も無い。出力に `Dependencies are not installed (pnpm has no lockfile here, and an install would write one). To install them: cd <wt> && pnpm install`                                                                                                             |
| `test_D5b_declared_pm_settles_two_lockfiles`   | `package.json` が `{"packageManager": "pnpm@10.0.0"}`、`pnpm-lock.yaml`、`bun.lock`                                                                               | `pnpm 0`、`bun 0` | `pnpm.log` が `install` / `--frozen-lockfile`。`bun.log` が無い                                                                                                                                                                                                                           |
| `test_D6_two_lockfiles_install_nothing`        | `pnpm-lock.yaml` と `bun.lock`                                                                                                                                    | `pnpm 0`、`bun 0` | `pnpm.log` も `bun.log` も無い。出力に `found pnpm-lock.yaml, bun.lock and no packageManager field`。`STATUS` 0                                                                                                                                                                           |
| `test_D7_lockfile_without_package_json`        | `package.json` を commit せず `pnpm-lock.yaml` だけ                                                                                                               | `pnpm 0`          | `pnpm.log` が無い。出力に `ependenc` が無い                                                                                                                                                                                                                                               |
| `test_D8_install_failure_keeps_the_worktree`   | `pnpm-lock.yaml`                                                                                                                                                  | `pnpm 7`          | `STATUS` 0。`<wt>` がある。出力に `dependencies are not installed in <wt> (pnpm install --frozen-lockfile: status 7); the worktree itself is created. To retry: cd <wt> && pnpm install --frozen-lockfile`。出力に `Dependencies installed` が無い                                        |
| `test_D9_no_install_only_shows_the_command`    | `pnpm-lock.yaml`、引数は `--no-install feat` と `feat2 --no-install`                                                                                              | `pnpm 0`          | `pnpm.log` が無い。出力に `Dependencies are not installed (--no-install). To install them: cd <wt> && pnpm install --frozen-lockfile`。2 つ目の呼び出しでも同じ（パスは `feat2`）                                                                                                         |
| `test_D10_missing_package_manager_is_reported` | `bun.lock`                                                                                                                                                        | なし              | 出力に `(bun is not on PATH). Once it is: cd <wt> && bun install --frozen-lockfile`。`STATUS` 0                                                                                                                                                                                           |
| `test_D16_path_with_a_space`                   | `make_repo "d 16"`、`pnpm-lock.yaml`                                                                                                                              | `pnpm 0`          | `pnpm.cwd` が `<wt>`（空白を含む 1 つのパス）                                                                                                                                                                                                                                             |
| `test_D17_package_json_alone_is_silent`        | `package.json` が `{}` だけ                                                                                                                                       | `pnpm 0`          | `pnpm.log` が無い。出力に `ependenc` が無い                                                                                                                                                                                                                                               |
| `test_D21_origin_branch_is_only_shown`         | `pnpm-lock.yaml`、`push_origin_branch d21 remote-feat`、引数は `remote-feat`                                                                                      | `pnpm 0`          | `<wt>`（`remote-feat`）がある。`pnpm.log` が無い。出力に `Dependencies are not installed (not run automatically because the branch comes from origin; an install runs the scripts of its package.json, so review them first). To install them: cd <wt> && pnpm install --frozen-lockfile` |
| `test_D22_local_branch_installs`               | `pnpm-lock.yaml`、`git -C "$REPO" branch local-feat`、引数は `local-feat`                                                                                         | `pnpm 0`          | `pnpm.log` が `install` / `--frozen-lockfile`                                                                                                                                                                                                                                             |
| `test_D25_the_path_comes_before_the_install`   | `pnpm-lock.yaml`                                                                                                                                                  | `pnpm 0`          | 出力のうち `Installing dependencies` より前の部分（`${OUT%%Installing dependencies*}`）に `To switch to this worktree: cd <wt>` がある                                                                                                                                                    |
| `test_D26_two_package_manager_lines`           | `package.json` が 2 行で、どちらも `"packageManager"` を含む（1 行目は `{"x": "packageManager",`、2 行目は `"packageManager": "pnpm@10.0.0"}`）、`pnpm-lock.yaml` | `pnpm 0`          | `STATUS` 0。`<wt>` がある（最初の行で読み取りを終え、宣言なしとして lockfile の判定に落ちる。`pnpm.log` は `install` / `--frozen-lockfile`）                                                                                                                                              |

個別の作りが要るテスト:

- **D10**: テストの PATH（`$STUB:$BASE_PATH`）に本物の `bun` があると成り立たない。テストの先頭で `PATH="$STUB:$BASE_PATH" command -v bun` を確かめ、見つかった場合は `record "PASS D10 skipped (a real bun is on the base PATH)"` を書いて戻る。
- **`test_D20_stdin_is_not_passed_to_the_install`**: `pnpm-lock.yaml`。`stub` を使わず、`$STUB/pnpm` に `#!/bin/sh` と `cat >"$STUB/pnpm.stdin"` の 2 行を書いて実行権を付ける。`OUT=$(cd "$REPO" && printf 'typed\n' | AGENT_VM_MARKER="$AGENT_VM_MARKER" PATH="$STUB:$BASE_PATH" bash "$CREATE" feat 2>&1)` で呼ぶ。期待: `$STUB/pnpm.stdin` があり、0 バイトである。
- **`test_D24_relative_path_entry_is_not_used`**: `pnpm-lock.yaml`。`mkdir "$REPO/relbin"` に、`$STUB/pnpm.log` へ 1 行書く `pnpm` を置く（commit しない）。`OUT=$(cd "$REPO" && AGENT_VM_MARKER="$AGENT_VM_MARKER" PATH="relbin:$BASE_PATH" bash "$CREATE" feat 2>&1)` で呼ぶ。期待: `pnpm.log` が無く、出力に `(pnpm is not on PATH)` がある。D10 と同じく、`$BASE_PATH` に本物の `pnpm` があれば skip を記録して戻る。

### T4: agent-vm の分岐で install の可否と順序を決める

- 編集: `home/dot_local/bin/executable_git-worktree-create:109-129`
- テスト: `tests/git-worktree-create/run.sh`
- 参照: `docs/decisions/0022-agent-vm-node-modules.md:37-40`（Consequences）

断りが無ければ、`package.json`（`{}`）と `pnpm-lock.yaml` を commit する。

| テスト                                              | marker             | fixture / stub                                  | 期待                                                                                                                                                                                                       |
| --------------------------------------------------- | ------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test_D11_vm_attach_failure_installs_nothing`       | `$VM_MARKER`       | `agent-vm-node-modules 1`、`pnpm 0`             | `pnpm.log` が無い。出力に既存の `do not install there until this succeeds` がある。`ependencies are not installed` は無い                                                                                  |
| `test_D12_vm_without_the_helper_installs_nothing`   | `$VM_MARKER`       | `pnpm 0`                                        | `pnpm.log` が無い。出力に `dependencies are not installed in <wt> (agent-vm-node-modules is missing, so node_modules here is shared with the host); recreate the machine from the host: agent-vm rm $REPO` |
| `test_D13_vm_installs_after_the_attach`             | `$VM_MARKER`       | `agent-vm-node-modules 0`、`pnpm 0`             | `agent-vm-node-modules.log` が `attach` / `<wt>`。`pnpm.log` が `install` / `--frozen-lockfile`                                                                                                            |
| `test_D14_host_installs_before_the_sync`            | `$AGENT_VM_MARKER` | `pnpm 0`、`agent-vm` は下記                     | `pnpm.log` が `install` / `--frozen-lockfile`。`$STUB/order` の中身が `after-install`。出力に既存の `(agent-vm node-modules-sync: status 3)` がある                                                        |
| `test_D23_vm_attach_failure_hides_the_conflict`     | `$VM_MARKER`       | `bun.lock` も commit、`agent-vm-node-modules 1` | 出力に `install with the project's package manager` が無い                                                                                                                                                 |
| `test_D28_vm_without_the_helper_wins_over_conflict` | `$VM_MARKER`       | `bun.lock` も commit                            | 出力に `agent-vm-node-modules is missing` があり、`install with the project's package manager` が無い                                                                                                      |
| `test_D29_vm_no_install_without_the_helper`         | `$VM_MARKER`       | `pnpm 0`、引数は `--no-install feat`            | 出力に `agent-vm-node-modules is missing` があり、`To install them` が無い（install を勧めない）                                                                                                           |

- **D14 の `agent-vm`**: `stub` を使わず、`$STUB/agent-vm` に次の 3 行を書く: `#!/bin/sh`、`if [ -e "$STUB/pnpm.log" ]; then echo after-install >"$STUB/order"; fi`（`$STUB` は書き込む時点で `%q` で埋め込む）、`exit 3`。

既存の C1〜C8 は `package.json` の無い repo を使うので、変えずに通ることを確かめる（C4 と C7 が「依存に関する行が増えない」の証明になる）。

### T5: ドキュメントと、自動承認の規則のテスト

- 編集: `docs/commands/git-worktree-create.md`、`home/dot_claude/commands/create-worktree.md`、`home/dot_claude/commands/issue-pr.md`、`docs/agent-vm.md`、`docs/decisions/0022-agent-vm-node-modules.md`、`home/dot_claude/hooks/implementations/permission-auto-approve.ts`、`home/dot_claude/hooks/tests/unit/permission-auto-approve.test.ts`
- 参照: `docs/commands/git-worktree-create.md:9-38`、`home/dot_claude/commands/create-worktree.md:34-41`、`home/dot_claude/commands/issue-pr.md:14-15`、`docs/agent-vm.md:107-116`、`home/dot_claude/hooks/implementations/permission-auto-approve.ts:172-173`

1. `docs/commands/git-worktree-create.md`:
   - 「使用方法」「オプション」に `--no-install` を足す。
   - 「依存のインストール」の節を「agent-vm との連携」の前に足す。書く内容:
     - K2 の判定の順序と、ルートの `package.json` だけを見ること。
     - K3 のコマンドの対応、実行しない 4 つの理由（「仕様 > 出力」の 2 つの表）。
     - 作成の経路の終了コード 0 は「worktree を作った」を意味し、ルートの install が成功した合図は `✓ Dependencies installed` の行であること。「仕様 > 呼び出し側の読み方」の表。出力の最後の行をパスとして読まないこと（`💡 To switch` は `✓ Worktree created` の直後にある）。
     - install の間は作成の完了が遅れること、install の標準入力は閉じてあること。
     - install は checkout したブランチのルートの script（`preinstall` / `postinstall` / `prepare`）を実行すること。origin のブランチでは実行しない理由（K8）。
     - launcher（ADR-0022）が install を実行しないのに、作成では実行する理由（K1 の 2）。ADR-0022 の Addendum へのリンクを張る。
     - `completion-gate` の PM 判定とは規則が違うこと（R6）。
   - 「agent-vm との連携」に、K4 の 4 つの場合と、host では install の後に sync を呼ぶことを足す。
   - 「注意事項」に、`-` で始まる未知の引数を拒否することを足す。
2. `home/dot_claude/commands/create-worktree.md` の Process 2 に、次を足す: `git-worktree-create` は依存もインストールする。出力の読み方は「仕様 > 呼び出し側の読み方」の表（英語で書く）に従う。install が Bash の制限時間を超える repo では、`--no-install` を付けて作り、表示されたコマンドを制限時間を延ばして実行する。
3. `home/dot_claude/commands/issue-pr.md` の手順 5（`Set up development environment`）に、`git-worktree-create` が依存のインストールまで行うことと、出力の読み方は `/create-worktree` の Process 2 の表と同じであることを 1 行で足す。
4. `docs/agent-vm.md`:
   - 警告の表に、「VM での `git-worktree-create`」「`dependencies are not installed in <wt> (agent-vm-node-modules is missing, ...)`」「`agent-vm rm <repo>` の後に、もう一度起動する」の行を足す。
   - `:101` の箇条書きに、`git-worktree-create` は差し替えの後に依存もインストールする、と 1 文足す。
   - 同じ表の「起動」の `node_modules in the VM is empty for <dir> (the host has one)` の行の場面に、「host での `git-worktree-create`（machine が動いているとき）」を足す。
5. `docs/decisions/0022-agent-vm-node-modules.md` の `## References` の前に `## Addendum (2026-10-06): worktree の作成時は install する` を足す。内容は K7 の 3 点と、`docs/commands/git-worktree-create.md` への参照。Decision と Alternatives の本文は変えない。
6. `permission-auto-approve.ts:172` のコメントを `// Git worktree management (custom script; create also installs dependencies, see docs/commands/git-worktree-create.md)` にする。正規表現は変えない。
7. `permission-auto-approve.test.ts:162` の次の行に `"git-worktree-create --no-install feat/new-feature",` と `"git-worktree-create feat/new-feature --no-install",` を足す（今の正規表現で通ることを固定する）。

### T6: 検査と配置

1. `/bin/bash tests/git-worktree-create/run.sh` → `FAIL: 0`。
2. `/bin/bash tests/git-worktree-cleanup/run.sh` → `FAIL: 0`（同じ CI ジョブで走るため）。
3. `scripts/lint-shell.sh` → 終了コード 0。
4. `bun run test` → 失敗 0（`permission-auto-approve.test.ts` を含む）。`bun run typecheck` → 終了コード 0。
5. `chezmoi diff ~/.local/bin/git-worktree-create` で差分がこの変更だけであることを見てから、`chezmoi apply ~/.local/bin/git-worktree-create` で配置する。`~/.claude/commands/create-worktree.md`、`~/.claude/commands/issue-pr.md`、`~/.claude/hooks/implementations/permission-auto-approve.ts` も同じ手順で配置する。
6. 実機の確認（host。この repo は `bun.lock` を持つ）:
   - `time git-worktree-create tmp/install-check` を実行する。`📦 Installing dependencies: bun install --frozen-lockfile` と `✓ Dependencies installed` が出て、worktree に `node_modules` があり、`git -C <wt> status --porcelain` が空であることを見る。所要時間を記録する。
   - その worktree の中で `mise ls` を実行し、trust を求めるエラーが出るかどうかを記録する（K6）。
   - `git-worktree-cleanup tmp/install-check` と `git branch -D tmp/install-check` で消す。
   - 結果を `plan.md` の Implementation Notes に書く。
7. commit: ブランチ `feat/git-worktree-create-install` を切って commit する。push はしない。

## Files

```
# 編集
home/dot_local/bin/executable_git-worktree-create
tests/git-worktree-create/run.sh
docs/commands/git-worktree-create.md
home/dot_claude/commands/create-worktree.md
home/dot_claude/commands/issue-pr.md
docs/agent-vm.md
docs/decisions/0022-agent-vm-node-modules.md
home/dot_claude/hooks/implementations/permission-auto-approve.ts
home/dot_claude/hooks/tests/unit/permission-auto-approve.test.ts
```

## テスト計画 (ISO 25010)

- **機能適合性**: PM の判定とコマンドの対応。
  - `pnpm-lock.yaml` → `pnpm install --frozen-lockfile` を worktree の中で実行する（D1、D16）。`bun.lock` → `bun install --frozen-lockfile`（D2）。`package-lock.json` → `npm ci`（D3）。
  - `packageManager: pnpm@10.0.0` と、pnpm と bun の lockfile → pnpm だけを実行する（D5b）。
  - ローカルにあるブランチ → 実行する（D22）。
  - `💡 To switch` の行が install の行より前に出る（D25）。
- **信頼性**: 実行しない場合と、失敗した場合。
  - lockfile が 2 種類 → どの PM も呼ばず、lockfile の名前を出して終了コード 0（D6）。
  - `packageManager: pnpm@10.0.0` で `pnpm-lock.yaml` が無い → 呼ばず、`pnpm install` を提示する（D5）。`yarn.lock` → 呼ばず、`yarn install` を提示する（D4）。`--no-install` → 呼ばず、コマンドを提示する（D9）。
  - install が終了コード 7 → 終了コード 0、worktree が残り、警告に `status 7` と再実行のコマンドがあり、`Dependencies installed` が無い（D8）。
  - PM が PATH に無い → 終了コード 0、警告に PM の名前とコマンドがある（D10）。
  - `"packageManager"` を含む行が 2 つある `package.json` → 終了コード 0（D26）。
  - 標準入力に `typed\n` を流しても、install の標準入力は 0 バイト（D20）。
  - 未知のオプション → 終了コード 1、worktree を作らない（D15）。
- **セキュリティ**: checkout したブランチのコードを実行する範囲。
  - origin にだけあるブランチ → PM を呼ばず、理由とコマンドを提示する（D21）。
  - PATH の相対のエントリにある `pnpm` → 実行せず、`not on PATH` を警告する（D24）。
  - `git-worktree-create --no-install ...` が、今の自動承認の正規表現で通る（`permission-auto-approve.test.ts` の 2 行）。
- **互換性**: agent-vm と、依存を持たない repo。
  - VM で `attach` が終了コード 1 → PM を呼ばず、lockfile が 2 種類でも install を勧めない（D11、D23）。VM でヘルパーが無い → PM を呼ばず、理由と `agent-vm rm <repo>` を出し、`--no-install` や lockfile 2 種類でも install を勧めない（D12、D28、D29）。
  - VM で `attach` が成功 → `attach` と install の両方を呼ぶ（D13）。host で sync が終了コード 3 → install は sync より前に済んでいる（D14）。
  - `package.json` が無い repo → 既存の C1〜C8 が変更なしで通る。`package.json` が `{}` だけ、または lockfile だけ → 出力に `ependenc` が無い（D17、D7）。
  - 2 つ目のブランチ名は無視する（D27）。`--help` は終了コード 0、引数なしは終了コード 1（D18、D19）。`feat help` は `feat` を作る（D30）。`feat --help` は help を出して作らない（D31）。
  - 空白を含むパスは、`💡 To switch` の行で `\ ` に引用される（D32）。
  - bash 3.2: CI の macOS ジョブ（`.github/workflows/ci-git-worktree-cleanup.yml:35`、`:46`）が `/bin/bash` で同じテストを実行する。
- **使用性**: 警告と案内の文面は、「仕様 > 出力」の表の文字列と一致することをテスト（D4、D5、D6、D8、D9、D10、D12、D21）で確かめる。
- **対象外**:
  - 性能効率性: install の所要時間は repo と PM のキャッシュで決まり、このスクリプトが変えられる量ではない。この repo での所要時間は T6 で 1 回測って記録する。遅い repo のための手段（`--no-install`）を用意し、`create-worktree.md` に書く。

## Risks / Unknowns

- **R1: install の間、作成の完了が遅れる。** Claude の Bash 呼び出しは既定で 120 秒で打ち切られる。打ち切られると `node_modules` は途中までで、警告も出ない。`💡 To switch` の行は install の前に出ているので、パスは残る。呼び出し側は `✓ Dependencies installed` が無いことで気づく（K5、T5 の 2）。依存の多い repo での所要時間は計測していない。
- **R2: `--frozen-lockfile` / `npm ci` は、`package.json` と lockfile が食い違うブランチで失敗する。** 警告に PM の出力と再実行のコマンドが出る。利用者は lockfile を更新する install を自分で選んで実行する。
- **R3: `packageManager` の読み取りは `sed` の 1 回の呼び出しで、`"packageManager"` を含む最初の行だけを見る。** キーと値が別の行にある `package.json` や、先に別の行が一致する `package.json` では読めず、lockfile の判定に落ちる。lockfile も一意でなければ実行しない側に倒れる。
- **R4: ルート以外にある独立したパッケージ（workspace でないもの）は install しない。** 文書に書く（T5）。VM の `attach` も、作成時点の `package.json` だけを差し替える（ADR-0022 の既存の制約）。
- **R5: ローカルのブランチと新しいブランチでは、そのブランチのルートの script が、install と見えないコマンドで実行される。** 自分の checkout にあるコードなので受容する（K1 の 3）。ローカルのブランチが、以前に origin から取り込んだ他人のコードである場合も実行される。避けるには `--no-install` を付ける。文書に書く（T5）。
- **R6: `completion-gate.ts` の PM 判定は、`packageManager` を読まず、lockfile に優先順位（bun → pnpm → yarn → npm）を付ける。** lockfile を 2 種類以上持ち、作成時に選ぶ PM（宣言した PM）の lockfile が gate の順序で他の lockfile に負ける repo では、作成時と gate で PM が食い違う（例: `packageManager: pnpm@...` と、pnpm と bun の lockfile。作成時は pnpm、gate は bun）。この食い違いは gate の既存の規則によるもので、gate の変更はこの plan に含めない。文書に書く（T5）。
- **R7: host で作った worktree は、動いている VM から見ると `node_modules` が空である。** sync が install を促す 1 行を出す（K4）。VM の中で使うには、VM の中で install する。`git-worktree-create` を通した host の「install → sync」の経路そのものは、実機では確かめていない。構成する動作（host の install の後の sync、VM での install）は V26〜V28 で確認済みである。
- **未確認**: corepack が初回のダウンロードで確認を求める環境での挙動。標準入力が `/dev/null` なので入力待ちにはならないと見込むが、実機では確かめていない。その場合の結果は「install が失敗して警告が出る」（K5）になる。

## Open Questions

- origin のブランチから作るときに install を実行しない、という線引き（K8）でよいか。Renovate の PR のブランチを手元で直す、という使い方が多いなら、毎回 1 行を手で実行することになる。出所を区別せずに実行する形にもできる（その場合は K8 と D21 を外す）。なお、この線引きは「ローカルに既にあるか」だけを見る。`gh pr checkout` などで先に取り込んだ他人のブランチでは実行される（R5）。
- 依存のインストール以外に、worktree を作った直後に毎回手でやっている準備はあるか（`mise trust`、`.env` の持ち込みなど）。あれば、根拠つきで別の変更として足す（K6）。

## Implementation Notes（実装後に追記、2026-10-06）

- **実装**: commit `c0af090`（ブランチ `feat/git-worktree-create-install`）。「実装の形」のコードは、`show_help` の説明文を除いてそのまま使った。plan との差分は無い。
- **テスト**（linux、bash 5.2.21）:
  - `/bin/bash tests/git-worktree-create/run.sh` → `PASS: 102 FAIL: 0`（変更前は 26）。D10 と D24 は skip していない（テスト用の PATH に本物の bun / pnpm が無かった）。
  - `/bin/bash tests/git-worktree-cleanup/run.sh` → `PASS: 154 FAIL: 0 SKIP: 1`（この SKIP は変更前からある）。
  - `scripts/lint-shell.sh` → 終了コード 0。`bun run test` → 3138 件中、失敗 0、skip 13。`bun run typecheck` → 終了コード 0。
  - bash 3.2 では実行していない。CI の macOS ジョブで確かめる。
- **実機の確認**（host、WSL2、この repo、bun 1.4.2）:
  - `git-worktree-create tmp/install-check` は、`📦 Installing dependencies: bun install --frozen-lockfile` と `✓ Dependencies installed` を出して終了コード 0 だった。272 パッケージが入り、`git status --porcelain` は空だった。
  - 所要時間は全体で 0.26 秒だった（bun のキャッシュがある状態の 1 回の計測）。依存の多い repo、キャッシュの無い状態では計測していない。
  - **mise**（2026.10.2、`paranoid` は `false`）: 新しい worktree で `mise trust --show` は `trusted` だった。本体の checkout の信頼を、linked worktree が共有する（`mise trust --help` の記述と一致する）。host では `mise trust` は要らない。
  - 片付け: `git-worktree-cleanup tmp/install-check` は、commit の無い worktree を端末の無い実行では残した（仕様どおり、終了時の表示は `kept 1`）。`git worktree remove` と `git branch -D` で消した。
- **確かめていないこと**: agent-vm の VM の中での動作（`attach` の後の install、ヘルパーなしの警告）、host で machine が動いている状態の「install → sync」、npm と pnpm の repo での実機の install。どれもテストは stub で通している。
- **持ち越し**:
  - VM の中で mise が config を未信頼として扱う件。利用者の記憶では VM の中で起きた。mise の信頼の記録は VM と host で別なので、VM では本体の checkout が未信頼である、と推定している（VM では確かめていない）。VM の本体と worktree で `mise trust --show` を見て原因を確定し、agent-vm の起動の側の変更として、ADR-0019 の K6 との関係を整理して扱う。
  - 依存のインストール以外の付随事項（Open Questions の 2 つ目）。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: lockfile が 2 種類の分岐が `deps_target` より先に評価され、VM で差し替えが済んでいない worktree に install を勧める。K1 は ADR-0022 の却下理由のうち lifecycle スクリプトを扱っていない。ADR の引用行が誤り（`:54` → `:49`）。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: 2 つ目のブランチ名の拒否に根拠が無い。`issue-pr.md` が呼び出し側なのに更新対象に無い。`mise trust` を外す理由は「事例が無い」ではなく、信頼の付与という副作用で書くべきである。

### decision-quality-reviewer

- verdict: needs-work
- 主指摘: `packageManager` だけで決まり lockfile が無い場合の `install` は lockfile を作り、K3 の「差分を作らない」と矛盾する。所要時間が未計測のまま既定を実行側にしており、打ち切りを呼び出し側が検知できない。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 白紙案は採用案とほぼ同形である。打ち切られると `To switch` の行も警告も出ないので、出力の順序を変えるか受容を明記する。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: host で sync の後に install すると、`npm ci` などが VM の mount 先のディレクトリを消しうる（順序を入れ替える）。ADR-0022 から、作成時に install する理由へ辿れない。`completion-gate.ts` の PM 判定と規則が分かれる。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: origin のブランチから作ると、そのブランチのルートの lifecycle スクリプトが、install と見えないコマンドで走る（依存の script を止める PM の設定は、ルートの script には効かない）。`sed | head` は `pipefail` の下で作成後に異常終了しうる。PM を cd の後の PATH で解決している。

### data-contract-evolution-evaluator

- verdict: needs-work
- 主指摘: 終了コード 0 が「作業できる状態」と読まれうるのに、install しなかったことを示す合図が場合ごとに違う。既存の呼び出し側を壊す変更は無い。

### 不採用にした指摘と理由（Round 1）

どれもオーダーの範囲を広げる提案で、本義を歪める指摘（divergent）ではない。

- `completion-gate.ts` の PM 判定を同じ規則に直す（architecture）: 別の hook の既存の挙動で、この変更が作る食い違いは「`packageManager` を宣言し、その PM と別の PM の両方の lockfile を持つ repo」に限られる。R6 に記録する。
- lockfile も `packageManager` も無い `package.json` で、`dependencies` を grep して案内を出す（decision-quality）: PM を決める手がかりが無く、提示するコマンドを作れない。Goal の文を事実に合わせて直す。
- install しなかった場合の終了コードを分ける（data-contract）: 指摘者自身が、再実行で `Worktree already exists` になるので劣ると評価している。完了の行（`✓ Dependencies installed`）を合図にする。
- 付随処理の登録表、既定を変える環境変数（greenfield）: 指摘者が受容でよいとしている。使い手が挙がっていない。
- `--`（オプションの終わり）の受け付け、corepack の実機 fixture（data-contract、decision-quality）: 前者は必要な呼び出しが無い。後者は結果がどちらでも K5 の警告に収まる。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: needs-work
- 主指摘: Round 1 の 7 件は解消。VM では `attach` が bind mount を張った後に `npm ci` が走るので、host で避けた「`node_modules` を消す」相互作用が VM に残る（npm の実際の挙動は未確認）。`help` / `-h` が先頭以外でも効くようになる。

### scope-justification-reviewer

- verdict: pass
- 主指摘: Round 1 の 6 件は解消。改訂で増えた変更（K8、yarn の提示のみ、順序、Addendum、承認規則の 2 ファイル）はどれも根拠があり、Files に混入も欠落も無い。

### decision-quality-reviewer

- verdict: pass
- 主指摘: 軸のずれは解消。K3 と K4 は過剰な縮小ではない。K8 はローカルのブランチの出所を見ない中間点で、Open Questions に R5 の受容を書き添えるとよい。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: K3 の提示のみ 2 種と K8 は、白紙から設計しても近い線引きになる。採用案の節に、その理由を 1〜2 行足すとよい。

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: host の「install → sync」は、本体の checkout で起動のたびに起きている状態と同じで、問題ない。R6 の食い違いの条件が実際より狭い。host で VM が動いていると、sync が「VM の `node_modules` が空」の案内を新しく出す。

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: Round 1 の 5 件は解消。呼び出し側への案内が、K8 で止めた install をエージェントに実行させる。`To switch` の行のパスが引用されていない。PATH の対策が効くのは PM 本体だけである。

### data-contract-evolution-evaluator

- verdict: needs-work
- 主指摘: 「`✓` が無ければ install する」という案内は、VM で `attach` が失敗した場合（install してはいけない）と矛盾する。出力の行ごとに取る行動を決める。`feat help` が worktree を作らずに終了コード 0 で終わる。

### 不採用にした指摘と理由（Round 2）

- 所要時間が閾値を超えたら既定を見直す、という基準を足す（decision-quality、任意）: この repo の 1 回の計測で既定を決めるのは過大だと、指摘者自身が書いている。
- install の子プロセスの PATH から相対のエントリを除く（security、2 案のうちの 1 つ）: もう 1 つの案（保証の範囲を PM 本体に狭めて書く）を採る。
- VM では npm を提示のみにする（logic-validator、2 案のうちの 1 つ）: 懸念（mount された `node_modules` への `npm ci`）は、2026-10-02 の実機の確認 V28 で、終了コード 0 で mount も保たれると確かめてある（`docs/agent-vm.md:423`）。K4 に根拠として書いた。

<!-- auto-review: verdict=needs-work; hash=21185002644d51b8b74f642db8471156392e60224e07f26e0d0a32d609e68ddd; design-hash=9977fb2e5b210fbd08caf6c9bc20b8a38a447f196f95fd7fd383a0cd40f1537f; round=1; at=2026-10-05T15:25:59.779Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=21; excluded=0; at=2026-10-05T15:25:59.795Z -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: pass
- 主指摘: Round 2 の 2 件は解消。V26・V28 の記録は K4 を支える（V28 が試したのは `--force` の形である点を書き添える）。読み方の表は、列挙した全ての場合を、対応する行に振り分ける。lockfile が 2 種類の行にはコマンドが無いので、その扱いを足すとよい。

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘: Round 2 の 5 件は解消。VM でヘルパーが無い警告を独立した行にする（回復手順が host でしか実行できない）。`attach` の回復後に install することと、パスは `✓ Worktree created:` の行から読むことを書く。

軽微な指摘は反映した（読み方の表の 2 行、パスの読み先、host で打ち切られた場合の sync、V28 の但し書き）。新しい round は起こさない。

### scope-justification-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### decision-quality-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=b72630526e24c7c8235325367edf4e75576e7dc2f1ff47257e9bfd569d3882df; design-hash=b4e269c296057a059f3e171190020de293cf9ff99051fc2b1fb73895e4785c8a; round=2; at=2026-10-05T15:32:50.397Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=13; excluded=0; at=2026-10-05T15:32:50.412Z -->

## Reviewer Outputs (Round 4)

### logic-validator

- verdict: pass
- 主指摘: origin の理由の新しい文字列は、表・コード・D21 の期待値の 3 か所で一致する。読み方の表の他の行の照合を満たさず、順序も保たれる。古い文字列の残りは無い。指摘なし。

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### scope-justification-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### decision-quality-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=pass; hash=fa59d0d7d045c4aa7ad9a6c133bc6e8216eb39a173e61d8798140ed9af2d7645; design-hash=ccb72808e3a4b92a18097e7e1336c8b3619d45e1bddbba5771430ca4fe7d20c0; round=3; at=2026-10-05T15:36:44.629Z; reviewers=logic-validator+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=7; excluded=0; at=2026-10-05T15:36:44.646Z -->

<!-- auto-review: verdict=pass; hash=fedc67b8d36f9e6988dd6925150f1d8c066c5ba97a396cefa90df96dca3f40d1; design-hash=cc417e4698cccbbb5360a1fbc47a82f3b40bfe7a9dd959b99af78147c6484615; round=4; at=2026-10-05T15:46:35.950Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=0; excluded=0; at=2026-10-05T15:46:35.966Z -->
