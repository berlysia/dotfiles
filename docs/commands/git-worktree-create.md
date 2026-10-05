# git-worktree-create

Create a new git worktree in `.git/worktree` directory

## 概要

`git-worktree-create` は、gitリポジトリ内で複数のブランチを同時に作業できるworktreeを簡単に作成するコマンドです。worktreeは`.git/worktree/<branch-name>`ディレクトリに作成され、一貫した場所に配置されます。

## 使用方法

```bash
git-worktree-create [--no-install] <branch-name>
git-worktree-create --help
```

## 引数

- `<branch-name>`: worktreeで使用するブランチ名

## オプション

- `--no-install`: 依存をインストールせず、実行するコマンドの表示だけにする。ブランチ名の前後どちらに置いてもよい
- `--help`, `-h`: ヘルプメッセージを表示。どの位置にあっても、worktree を作らずに help を出して終了コード 0 で終わる

## 動作

コマンドは以下の優先順位でブランチを処理します：

1. **ローカルブランチが存在する場合**: 既存のローカルブランチからworktreeを作成
2. **リモートブランチが存在する場合**: リモートブランチをトラッキングするローカルブランチを作成し、worktreeを作成
3. **ブランチが存在しない場合**: 現在のHEADから新しいブランチを作成し、worktreeを作成

## 依存のインストール

worktree を作った直後に、その worktree のルートで依存をインストールする。作った worktree で、そのままテストや lint を実行できるようにするためである。

### package manager の判定

worktree のルートの `package.json` だけを見る。`package.json` が無ければ、何もしない。

1. `packageManager` フィールドが `pnpm@` / `bun@` / `npm@` / `yarn@` で始まれば、その package manager（PM）を使う。
2. そうでなければ lockfile を数える。pnpm は `pnpm-lock.yaml`、bun は `bun.lock` / `bun.lockb`、npm は `package-lock.json` / `npm-shrinkwrap.json`、yarn は `yarn.lock`。
   - lockfile を持つ PM が 1 つなら、それを使う。
   - 2 つ以上なら、何も実行せず、見つけた lockfile の名前を警告する。
   - 0 なら、何も出さない。PM を決める手がかりが無く、提示するコマンドを作れない。

PM を取り違えると `node_modules` を壊すので、既定の PM も、lockfile どうしの優先順位も持たない。`packageManager` は `"packageManager"` を含む最初の行だけを読む。読めなければ、宣言なしとして lockfile の判定に進む。

### 実行するコマンド

実行するのは、lockfile を書き換えない install だけである。作ったばかりの worktree に差分を作らないためである。

| PM   | コマンド                              |
| ---- | ------------------------------------- |
| pnpm | `pnpm install --frozen-lockfile`      |
| bun  | `bun install --frozen-lockfile`       |
| npm  | `npm ci`                              |
| yarn | 実行しない。`yarn install` を提示する |

- 実行するのは、判定した PM 自身の lockfile があるときだけである。
- yarn は、lockfile を固定するフラグが v1（`--frozen-lockfile`）と v2 以降（`--immutable`）で違う。v2 以降の既定（PnP）は `node_modules` ではなく `.pnp.cjs` と `.yarn/` を書くので、agent-vm の差し替え（`node_modules` だけが対象）の外に出る。
- PM の実行ファイルは、worktree に `cd` する前に絶対パスで解決する。PATH の相対のエントリにある、checkout したブランチの中のファイルを実行しないためである。PM が起動する子プロセス（`node`、`sh`）の解決までは保証しない。
- install の間は、作成の完了が遅れる。install の標準入力は閉じてある（`/dev/null`）。確認を求める PM や corepack が、入力待ちで止まらないためである。確認が要る場合、install は失敗し、警告になる。

### 出力

`<wt>` は引用した worktree のパス、`<cmd>` は上のコマンドである。終了コードはすべて 0 である。`💡 To switch to this worktree: cd <path>` は `✓ Worktree created` の直後（install より前）に出す。パスは `printf '%q'` で引用する。

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

`<repo>` は引用した本体の checkout である。

実行しない場合の `<reason>` は、上から順に最初に当てはまるものを使う。

| 条件                              | `<reason>`                                                                                                                          | `<cmd>`        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `--no-install`                    | `--no-install`                                                                                                                      | 上のコマンド   |
| origin のブランチから作った       | `not run automatically because the branch comes from origin; an install runs the scripts of its package.json, so review them first` | 上のコマンド   |
| 判定した PM の lockfile が無い    | `<pm> has no lockfile here, and an install would write one`                                                                         | `<pm> install` |
| PM が yarn で、`yarn.lock` がある | `yarn is not run automatically`                                                                                                     | `yarn install` |

VM の 2 つの場合（`attach` の失敗、ヘルパーなし）は、上のどの行よりも優先する。

### 呼び出し側の読み方

install の失敗は、作成を失敗させない。作成の経路の終了コード 0 は「worktree を作った」を意味し、依存が入ったことは意味しない。ルートの install が成功した合図は、成功時だけに出る `✓ Dependencies installed` の行である。install の失敗、実行しない場合、Bash の制限時間による打ち切りのどれでも、この行は出ない。

出力の行から、取る行動を決める。上から順に、最初に当てはまる行に従う。`dependencies are not installed` は大文字と小文字を区別せずに探す。

| 出力にある行                                                               | 意味                                                         | 取る行動                                                                                                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `✓ Dependencies installed`                                                 | ルートの install が終了コード 0 で終わった                   | 作業を始める                                                                                                                                                         |
| `do not install there until this succeeds`                                 | VM で差し替えが済んでいない                                  | install しない。その警告の回復手順（`agent-vm-node-modules attach <wt>`）を実行し、成功してから project の PM で install する                                        |
| `agent-vm-node-modules is missing`                                         | VM にヘルパーが無く、`node_modules` が host と共有されている | install しない。host で machine を作り直す必要があることを、ユーザーに伝える                                                                                         |
| `dependencies are not installed` で、理由が `the branch comes from origin` | origin のブランチなので、自動では実行しなかった              | 行に書いてあるとおり、そのブランチの `package.json` の `scripts`（と `.pnpmfile.cjs`）を見てから、表示されたコマンドを実行する。判断がつかなければユーザーに確かめる |
| `dependencies are not installed`（上の 3 つ以外）                          | install していない                                           | その行の手順に従う。行にコマンドが無い場合（lockfile が 2 種類）は、どの PM を使うかをユーザーに確かめる                                                             |
| `📦 Installing dependencies` があり、上のどれも無い                        | install の途中で打ち切られた                                 | `💡 To switch` の行のパスに移り、`📦` の行のコマンドを、制限時間を延ばして実行する                                                                                   |
| どれも無い                                                                 | スクリプトは install を始めていない                          | install しない（Node の project ではないか、PM を決める手がかりが無い）                                                                                              |

- `✓ Dependencies installed` が意味するのは、ルートの install の成功だけである。ルート以外の独立したパッケージ（workspace でないもの）と、host で作ったときの VM 側の install は含まない。
- パスをプログラムとして使うときは、`✓ Worktree created:` の行の値（引用していない）を読む。出力の最後の行をパスとして読まない。`💡 To switch` の行はシェルに貼るための行で、パスは引用してある（空白は `\ ` になる）。
- host で install が打ち切られた場合は、後に続く `agent-vm node-modules-sync` も走っていない。動いている machine があれば、次の起動か `agent-vm node-modules-sync <repo>` で揃う。
- install が Bash の制限時間（既定で 120 秒）を超える repo では、`--no-install` を付けて作り、表示されたコマンドを制限時間を延ばして実行する。

### script の実行と、origin のブランチ

install は、checkout したブランチのルートの `package.json` の script（`preinstall` / `postinstall` / `prepare`）と `.pnpmfile.cjs` を実行する。依存パッケージの script の可否は、PM と repo の設定（pnpm の `onlyBuiltDependencies`、bun の `trustedDependencies`、`.npmrc`）に従い、このスクリプトは PM のフラグで上書きしない。これは手で install する場合と同じである。

- 自分の checkout にあるコード（ローカルのブランチと、今の HEAD から作る新しいブランチ）では、実行する。ローカルのブランチが、以前に origin から取り込んだ他人のコードである場合も実行される。避けるには `--no-install` を付ける。
- ローカルに無く `origin/<branch>` にあるブランチは、この checkout が初めて持ってくるコードである。origin のブランチには、自分以外が書いた内容が入りうる（Renovate / Dependabot の PR の中身も、上流パッケージ経由で部分的に攻撃者の影響下にある）。そのため install を実行せず、コマンドを提示する。`package.json` の script を確かめてから、表示された 1 行を実行する。この線引きは「ローカルに既にあるか」だけを見るので、`gh pr checkout` などで先に取り込んだブランチでは実行される。

### launcher との違い

agent-vm の launcher は、起動時に install を実行しない。作成時だけ実行するのは、launcher の自動 install を却下した理由が、作成直後の worktree には当てはまらないためである。作業している agent がいなくて競合せず、PM は一意に決まらなければ実行せず、script の方針は PM と repo の設定に従う。詳細は `docs/decisions/0022-agent-vm-node-modules.md` の Addendum にある。

### 制限

- ルート以外にある独立したパッケージ（workspace でないもの）は install しない。
- `completion-gate` の PM 判定とは規則が違う。`completion-gate` は `packageManager` を読まず、lockfile に優先順位（bun → pnpm → yarn → npm）を付ける。このコマンドは宣言を先に読み、lockfile が 2 種類で宣言が無ければ実行しない。`packageManager: pnpm@...` を宣言し、pnpm と bun の lockfile を持つ repo では、作成時は pnpm、`completion-gate` は bun を選ぶ。

## agent-vm との連携

agent-vm を使う repo では、作った worktree の `node_modules` を VM ローカルに差し替える（`docs/decisions/0022-agent-vm-node-modules.md`）。

- **VM の中**（`/etc/agent-vm` があり、`agent-vm-node-modules` がある）: 作成の後に `agent-vm-node-modules attach <worktree>` を実行する。失敗したら、警告と回復手順を 1 行出す。作成そのものは成功のままである。警告が出ている間は、その worktree で install しない（host の worktree に linux 用のパッケージが入る）。
  - `attach` が成功したら、依存をインストールする（終了コード 0。ヘルパーは、対象のパッケージを 1 つでも取りこぼすと 0 以外で終わる）。mount された `node_modules` に対する `npm ci`、`pnpm install --force`、`bun install --force` で mount が保たれることは、実機で確かめてある（`docs/agent-vm.md` の V28）。ここで実行する `--frozen-lockfile` の形そのものは、VM の実機では確かめていない。
  - `attach` が失敗したら、install しない。既存の警告が回復手順を出すので、依存に関する行は足さない。lockfile が 2 種類ある場合の警告も出さない。
  - `agent-vm-node-modules` が無ければ、install しない。`package.json` から PM か lockfile が見つかる worktree に限り、理由と回復手順（host での `agent-vm rm <repo>`）を警告する。`--no-install` を付けていても、install を勧めない。
- **host**（`agent-vm` がある）: 依存をインストールした後に、`agent-vm node-modules-sync <repo>` を実行する。この repo の machine が動いていなければ、何もしない。動いていれば、起動中の処理が repo の lock を持っている間（最大で約 5 秒）と VM での sync の間、作成の完了が遅れる。失敗したら、agent-vm の警告に続けて 1 行出す。次の agent-vm の起動で揃う。sync の成否は install に影響しない。
  - install を先にするのは、sync が VM に、host と共有するツリーの中へ mount 先の `node_modules` を作らせるためである。sync の後に host で `node_modules` を消して作り直すと、VM の mount は失効し、次の sync まで張り直されない。
  - 動いている machine があると、sync は `node_modules in the VM is empty for <wt> (the host has one)` の案内を出す。VM 側にも install が要る、という案内である。
- どちらも無い環境では、依存のインストールだけが動く。

## 使用例

### 既存ブランチのworktreeを作成

```bash
git-worktree-create feature-login
```

### 新規ブランチのworktreeを作成

```bash
git-worktree-create new-feature
```

### リモートブランチからworktreeを作成

```bash
git-worktree-create origin-feature
```

## worktreeの場所

Worktreeは以下の場所に作成されます：

```
<repo-root>/.git/worktree/<branch-name>
```

`<repo-root>` は本体の checkout です。linked worktree の中で実行しても、`git rev-parse --git-common-dir` で本体の `.git/worktree/` を求めてそこに作ります。

例：

```
/home/user/myproject/.git/worktree/feature-login
```

## 注意事項

- worktreeは既にディレクトリが存在する場合は作成されません
- `-` で始まる未知の引数は、worktree を作らずに usage を出して終了コード 1 で終わる（`--no-instal` のような綴り違いに、原因の分かるエラーを返すため）
- 2 つ目以降のブランチ名は無視する。`help` という語は、先頭の引数のときだけ help として扱う
- リポジトリのルートディレクトリ内でgitコマンドが実行可能である必要があります

## 関連コマンド

- `git-worktree-cleanup`: 不要なworktreeを削除
- `git worktree list`: 既存のworktreeを一覧表示
- `git worktree remove`: 特定のworktreeを削除

## 実装

スクリプトの場所: `~/.local/bin/git-worktree-create`

ソースコード: `dot_local/bin/executable_git-worktree-create`
