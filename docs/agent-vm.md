# agent-vm: claude / codex を OrbStack の隔離マシンで動かす

## 1. 何をするか

`agent-vm` は、mac 上で `vclaude` / `vcodex` を打ったときに、その repo 専用の OrbStack isolated machine の中でツールを起動する仕組みである。
素の `claude` / `codex` は agent-vm を通らず、host でそのまま動く。
VM で動かすかどうかは、打つコマンド名で選ぶ（`docs/decisions/0034-agent-vm-opt-in.md`）。

isolated machine は `--isolated --isolate-network --forward-ssh-agent` で作られる。
host のホームディレクトリ全体や、`mac` コマンドによる host 操作には到達できない。
dotfiles（設定・hooks・skills）は VM の中から読めるが、host 側の原本は VM から書き換えられない。
VM に渡すのは repo の tracked files を毎回コピーした専用の複製であり、VM がそこに何を書いても host の原本には影響しない。

1Password の秘密と SSH 署名は mac 側で完結したまま使える。
秘密は起動のたびに mac 側の `op` が解決してから VM に渡し、SSH の署名・認証は 1Password の SSH agent を agent forwarding で使う。
どちらも認証情報そのものを VM に置かない。

VM に入るのは `.chezmoiignore` の VM ブロックに載ったものだけである。VM 用のツールの導入と、VM 向けの設定の絞り込み（Claude と Codex の MCP、音声通知の hook）は bootstrap が行う。

## 2. 最初の準備

1. `chezmoi apply` を実行する。OrbStack が Homebrew cask で導入される。
2. OrbStack を一度起動し、初回セットアップを終える。
3. `chezmoi init` を実行する。config に `agent_vm` キーが入る。実行しなくても動作は変わらない（テンプレート側は `dig "agent_vm" false .` で参照しており、キーが無ければ既定値 `false` として host 扱いになる）。
4. 1Password の SSH agent 設定で、承認を毎回アプリごとに求める側を選ぶ。agent forwarding は鍵全体を VM に使わせるため、承認済みの VM が任意のタイミングで鍵を使えないようにする。
   agent forwarding は、承認済みの間 VM に agent のすべての鍵を使わせる（private-skills の clone もこれで行う）。

## 3. 普段の使い方

VM で動かしたいときは、repo の中で `vclaude` または `vcodex` と打つ。引数はそのまま `claude` / `codex` に渡る。
`agent-vm claude` / `agent-vm codex` も同じ動作である。
素の `claude` / `codex` は host で動き、VM には入らない。

初めてその repo で起動したときだけ、machine の作成を待つ。
進捗は段階ごとに 1 行ずつ表示される。
repo ごとの machine は、bootstrap 済みの golden machine（`agent-vm-golden`）の clone で作る。待ち時間は次のとおり。

- **最初の 1 台**: golden machine の作成を待つ（数分。Ubuntu の mirror が遅いと延びる）。
- **2 台目以降**: golden machine の clone から起動する（数秒）。
- **dotfiles を変えた後の最初の新規作成**: golden machine の差分更新の分だけ待つ（変更の量で延びる）。

`agent-vm golden refresh` を実行すると、これらの待ちを前もって済ませられる。初回セットアップの最後に一度実行しておくとよい。
`agent-vm prewarm` は、machine を作成し、dotfiles を適用するところまでを、ツールを起動せずに行う。

Claude と Codex は machine ごとに初回だけログインが要る。
表示された URL を mac のブラウザで開いて承認し、コードを VM 側に貼り付ける。
2 回目以降はその machine に保存された認証でそのまま起動する。

### VM でブラウザを使う

VM の Claude は、playwright と chrome-devtools の MCP で、VM の中の headless ブラウザを操作できる。dev server の画面確認を、VM を離れずに行える（スクリーンショット、DOM のスナップショット、パフォーマンストレース）。drawio MCP は VM では使わない。

- **Codex では使えない。** VM の Codex にはブラウザの MCP を載せていない。ブラウザが要るときは、同じ VM の Claude を使う。
- **dev server は portless で起動する。**
  - VM の中で `portless run <dev コマンド>` を実行する。例: `portless run pnpm dev`。
  - linked worktree では、ブランチ名が付いて `http://<branch>.<app>.localhost:<port>` になる。
  - 名前は package.json の `name`、無ければ git の根の名前から決まる。`portless <name> <cmd>` の形はブランチ名を付けないので、worktree では使わない。
  - スコープ付きの `name` は、スコープが落ちる（`@berlysia-dotfiles/root` は `root` になる）。ブランチ名は、最後の `/` より後ろが付く（`fix/workflow-identity` は `workflow-identity` になる）。
- **どの URL を開くか。**
  - mac のブラウザで `http://<app>.localhost:<port>` を開く。
  - `<port>` は machine ごとの proxy のポートである。launcher が起動時に 1 行で表示する。後からは、mac で `agent-vm list` を実行し、その machine の行の 4 列目を見る。
  - `<app>` は、VM の `portless run` が起動時に表示する。後からは、VM で `portless list` を実行する。
  - ポートは machine がある間は変わらない。`agent-vm rm` で作り直すと、別のポートになりうる。
  - `portless list` に出ない dev server は、portless を通っていない。
- **portless を通さないとき。**
  - 既定の loopback bind（`127.0.0.1`）のまま、mac の `http://localhost:<port>` で開ける。`<machine>.orb.local` は `0.0.0.0` に bind したときにしか届かない。
  - ただし、複数の machine が同じポートを使うと、`localhost` は先に bind した machine に届く。先に bind した側のサーバーを止めても、転送は後から bind した machine に移らず、応答しなくなる。
  - portless を通せば、人が開くのは machine ごとの proxy のポートだけになり、launcher の割り当てが machine 同士で重なることはない。VM の中のプロセスがほかの machine のポートに直接 bind する場合は防げない（「気をつけること」）。
- **うまく開けないとき。**
  - launcher が `proxy port for <machine> changed ...` を表示したとき、または表示のポートで開けないときは、VM の中で `portless proxy stop` を実行してから dev server を起動し直す。前に起動した proxy が、古いポートで動き続けていることがある。
  - `portless proxy stop` は、proxy を止めたのに `Failed to stop proxy: ENOENT ... proxy.pid` と表示することがある。止まったかどうかは、VM で `ss -ltn | grep <port>` を実行して、待ち受けが無いことで確かめる。
  - mac の `127.0.0.1:<port>` だけが接続拒否になるときも、同じ手順で戻る。ほかの machine がそのポートを bind してやめた後に起きる（「気をつけること」）。
  - 17300〜17399 の枠がすべて使われていると、launcher が起動のたびに警告を出す。その machine では portless を使わない（手でも起動しない）。使わなくなった machine を `agent-vm rm <repo>` で消すと、枠が空く。
  - mac で同じポートを別のプログラムが使っている場合は、その machine を `agent-vm rm` で作り直す。
- **気をつけること。**
  - cookie はホスト名で分かれ、ポートでは分かれない。2 台の machine のアプリが同じ名前（`app.localhost`）だと、同じブラウザのプロファイルでは cookie を共有する。片方の VM の dev server が、もう片方の認証の cookie を受け取る。VM の agent を信頼しない前提では、認証の cookie が、信頼しない VM に渡る。認証つきの dev server を複数の machine で開くときは、ブラウザのプロファイルを分けるか、package.json の `name` を machine の間で重ならないものにする。
  - VM の中のプロセスは、ほかの machine の proxy のポートに直接 bind できる。相手の proxy が動いていない間に bind されると、mac のそのポートは bind した VM に届く。相手の machine からは気づけない。確かめられない dev server の URL に、認証情報を入れない。
  - 奪われる先は、IPv4 と IPv6 で別々に決まる。`127.0.0.1` だけを bind されると、mac の `127.0.0.1:<port>` は bind した VM に届き、`[::1]:<port>` は元の machine の proxy に届く。`<app>.localhost` は `::1` に先に解決されるので、名前で開くときと `127.0.0.1` を直接指すときで、届く先が変わる。bind した側がやめても、mac の `127.0.0.1:<port>` は元の machine に戻らず、接続拒否になる。元の machine の proxy を止めて起動し直すと戻る。
  - `agent-vm list` と VM の `portless list` を突き合わせても、奪われていることは分からない。どちらも奪われた側の正しい情報で、奪われていても一致する。
  - 開いた先が想定の machine かどうかは、存在しない名前への応答を比べて確かめる。portless は、知らない名前に、自分の経路の一覧を含む 404 を返す。mac で `curl -sS -H 'Host: nosuch.localhost' http://127.0.0.1:<port>/` と `curl -sS -H 'Host: nosuch.localhost' 'http://[::1]:<port>/'` を実行し、`orb -m <machine> curl -sS -H 'Host: nosuch.localhost' http://127.0.0.1:<port>/` の応答と比べる。違えば、そのポートは別の machine に届いている。同じでも、奪われていない証明にはならない（bind した側が同じ応答を返せば、差は出ない）。
- **`localhost` の注意。** `localhost` のオリジンはポートをまたいで cookie を共有する。VM の dev server は、`localhost` にログイン済みのセッションを持つ普段のプロファイルでは開かず、シークレットウィンドウなどを使う。host で使うポート（OAuth のコールバックなど）とも重ねない。
- **ブラウザの置き場。** ブラウザ本体（linux-arm64 の headless shell）は、host に 1 部だけ置き、machine ごとに APFS の clonefile で複製して VM に見せる。VM ごとの増分は apt の依存ライブラリとフォントで、約 35 MB である。
- **取得。** 取得は `chezmoi apply` が自動で行う。手で行うときは `agent-vm fetch-browsers` を実行し、ストアが使えなくなったときは `--force` で取り直す。ブラウザ本体は `cdn.playwright.dev` から取得し、内容のハッシュは repo に固定していない。取得した直後のハッシュを記録して複製の前に比べるので、検出できるのは取得後の改変だけである（取得元の侵害は防がない）。
- **版。** ブラウザの版は `package.json` の `@playwright/mcp` の版で決まる。chrome-devtools-mcp を headless shell と組み合わせるのは公式にはサポートされていない。どちらかの版を上げたときは playwright と chrome-devtools の両方で、スクリーンショットとパフォーマンストレースを取る確認をやり直す。

警告は、害が出る場面で出る。どれも起動は失敗させず、ブラウザの MCP だけが使えない状態になる。

| 場面            | 条件                                                     | 回復手順                                                         |
| --------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| `chezmoi apply` | ブラウザの取得の失敗（同じ理由が続くときは 1 行に縮む）  | `agent-vm fetch-browsers`                                        |
| 起動            | ストアに要求された版が無い                               | `agent-vm fetch-browsers`                                        |
| 起動            | ストアの内容が取得時の記録と一致しない                   | `agent-vm fetch-browsers --force`                                |
| 起動            | clonefile の失敗、または別のボリューム                   | `$AGENT_VM_STATE_DIR` が APFS の単一ボリュームにあるかを確かめる |
| bootstrap       | machine にブラウザのマウントが無い                       | `agent-vm rm` で作り直す                                         |
| bootstrap       | ブラウザの実行ファイルが無い、依存ライブラリの欠け       | `agent-vm fetch-browsers` の後に、もう一度起動する               |
| bootstrap       | VM の MCP の版と、複製したブラウザの版が違う（助言のみ） | `chezmoi apply` と `agent-vm fetch-browsers`                     |

machine にブラウザのマウントが無いと、後から足す手段は無い。使うには `agent-vm rm` で作り直す。失うのは VM 内のログイン状態（Claude と Codex）と、VM の中に入れたツールである。repo、セッションログ（outbox 経由で取り込み済み）、host の env ファイルは残る。

### node_modules は host と VM で別になる

VM の中では、repo の各パッケージ（`package.json` を持つディレクトリ）の `node_modules` が、VM ローカルのディスクへの bind mount に差し替わる（`docs/decisions/0022-agent-vm-node-modules.md`）。mac と VM が、互いの install でプラットフォーム別のパッケージ（TS7、oxc 系など）を壊し合わない。

- **VM で一度 install する。** 起動のたびに launcher が差し替えを揃える。VM の `node_modules` が空で host にある worktree では、起動時に 1 行で install を促す。
- **worktree は `git-worktree-create` と `git-worktree-cleanup` で作り、消す。** どちらも VM の中でも host でも、差し替えを追従させる。`git-worktree-create` は、差し替えの後に依存もインストールする（`docs/commands/git-worktree-create.md`）。`git worktree add` / `git worktree remove` を直接使うと追従しない（下の表の最後の行）。
- **host に空の `node_modules` が現れることがある。** 差し替えの mount 先として VM が作ったディレクトリである。Node のモジュール解決は空の `node_modules` を素通りするので、host の動作は変わらない。git も空のディレクトリを追跡しない。
- **VM の Claude は、mount を手で張り直せない**（保護フック）。回復は下の表の手順で行う。

警告は、VM の `node_modules` が host と共有されうる場面か、install が必要な場面で出る。どれも起動と worktree の作成は止めない。

| 場面                                                              | 表示                                                                                                                                      | 回復手順                                                                                                                       |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 起動、host での `git-worktree-create`（machine が動いているとき） | `node_modules in the VM is empty for <dir> (the host has one)`                                                                            | VM の中で、その dir の install を実行する                                                                                      |
| 起動、`agent-vm node-modules-sync`                                | `kept VM-local node_modules that may be stale in <machine> (a worktree or package list could not be trusted)`                             | `cd <repo> && agent-vm shell` の後に `agent-vm-node-modules sync <repo>` を実行し、詳しい警告を見る                            |
| 起動、`agent-vm node-modules-sync`                                | `node_modules may be shared with the host in the VM (the helper is missing)` または `(the helper does not speak contract <n>)`            | `agent-vm rm <repo>` の後に、もう一度起動する                                                                                  |
| 起動、`agent-vm node-modules-sync`                                | `node_modules may be shared with the host in the VM (<それ以外の理由>)`                                                                   | `cd <repo> && agent-vm shell` の後に `agent-vm-node-modules sync <repo>` を実行する                                            |
| VM での `git-worktree-create`                                     | `node_modules of <wt> may be shared with the host (agent-vm-node-modules attach: status <n>)`                                             | 表示どおり `agent-vm-node-modules attach <wt>` を実行する。成功するまで、その worktree で install しない                       |
| VM での `git-worktree-create`                                     | `dependencies are not installed in <wt> (agent-vm-node-modules is missing, so node_modules here is shared with the host)`                 | `agent-vm rm <repo>` の後に、もう一度起動する                                                                                  |
| host での `git-worktree-create`                                   | `the running agent-vm machine may not have VM-local node_modules for <wt> yet`                                                            | 次の起動で揃う。すぐに揃えるなら `agent-vm node-modules-sync <repo>`                                                           |
| VM での `git-worktree-cleanup`                                    | `could not detach its VM-local node_modules`、`another node_modules sync held the lock (try again)`、`the node_modules helper refused it` | worktree は残る。lock なら時間を置いて再実行する。それ以外は、表示されたヘルパーの理由に従う                                   |
| （警告なし）                                                      | host の worktree で `tsc` が `Unable to resolve @typescript/typescript-darwin-arm64` で落ちる                                             | 規約外の `git worktree add` の後に VM で install した。agent-vm を起動し直してから、host のその worktree で install をやり直す |

## 4. 秘密の渡し方

秘密は 2 つのファイルにだけ書く。

- `~/.config/agent-vm/env.1password`: 全 repo 共通。`agent-vm env edit` ではなく直接編集する。
- repo 別のファイル: `agent-vm env edit` で開く。`$EDITOR` が起動し、無ければ新規作成される（パーミッション 600）。

どちらのファイルにも `op://` 参照だけを書く。値をそのまま書いてはならない。
起動のたびに mac 側の `op inject` がこれらのファイルを解決し、結果を VM の tmpfs にだけ渡す。

**repo 内の `.env` / `.env.local` は解決しない。**
repo は VM から書き換えられる領域なので、そこに書かれた `op://` 参照を host 側の認証済み `op` が解決してしまうと、VM が任意の秘密を持ち出す経路になる。

### gh の token

VM の中の `gh` は、repo ごとに作った fine-grained PAT で認証する。token は `GH_TOKEN` として、tool（claude / codex / `agent-vm shell` の bash）を起動するときにだけ注入される。権限は `pull_requests` と `issues` の write、`contents` と `actions` の read に絞られ、push はできない。

使い方:

```bash
cd <repo>
agent-vm env gh [--repo OWNER/REPO] [--vault Personal|Formal]
```

- 初回は、host 側で確かめた repo 名（`OWNER/REPO`）の入力と、token を置く vault の選択がある。origin は VM から書き換えられるので、名前は自分で確かめて入力する。
- 期限は vault で決まる。Personal は 90 日、Formal は 30 日。vault は `--vault` で変えられる。
- 表示される URL で PAT の作成画面が開く（mac では自動で開く）。名前、期限、権限は入力済みなので、Repository access で**この repo だけ**を選び、期限は変えずに Generate して、token を貼り付ける。
- 2 回目以降は記録された repo と vault を使う。origin が記録と違うときは止まる。移したのなら host で origin を直し、`--repo OWNER/REPO` を付けて実行する。
- 期限の 7 日前から、起動のたびに更新を促す表示が出る。更新は同じコマンドを実行するだけでよい。
- `op` は既定のアカウントを使う。保存先のアカウントは PAT を作る前に表示されるので、意図したアカウントか確かめる。`OP_ACCOUNT` と `OP_SERVICE_ACCOUNT_TOKEN` は設定されていない前提である。

気をつけること:

- token は 1Password の item（title は `agent-vm-gh <PAT 名>`）に入る。その vault を読める人は token も読める。
- `GH_TOKEN` は VM の中で claude / codex / bash の環境変数になり、そこから起動される全てのプロセスから読める。
- public repo の選び忘れと、全 repo を対象にした token は、検証では止められない。前者は最初の書き込み系の `gh` 操作が 403 になって分かる。後者は検出できないので、作成画面で選ぶ repo を確かめる。
- `gh pr merge` は host で行う。この token には contents の write が無いので、VM から直接 merge はできない。他者の PR の auto-merge の有効化は、この token では拒否されうる（branch protection の設定による）。
- `agent-vm env gh` を同時に実行しない。後から書いた方だけが env に残り、先の方の item と PAT は使われないまま残る。
- `agent-vm rm` は PAT も 1Password の item も状態ファイルも消さない。状態ファイル（`~/.config/agent-vm/repos/<machine>.gh`）だけが残った場合は手で消してよい。次の `env gh` は repo 名と vault をもう一度聞く。
- `agent-vm env adopt` は env ファイルと一緒に状態ファイルも移す。

更新の後の片付け:

- 更新すると、古い PAT の削除と古い item の archive の手順が表示される。実行しないと、古い token が期限まで有効なまま残る。
- 表示を見逃したときは、`https://github.com/settings/personal-access-tokens` で名前が `<base>-<hash>-` で始まる PAT を、1Password で title が `agent-vm-gh ` で始まる item を探す。adopt した repo では、adopt 前の machine 名の PAT も探す。
- archive した item にも token は残る。期限が切れるまでは有効である。

侵害が疑われるときの失効手順:

1. `https://github.com/settings/personal-access-tokens` で、状態ファイルの `pat_name` の PAT を削除する。
2. 状態ファイルが無いときは、env ファイルの `GH_TOKEN=op://<vault>/<id>/credential` の id の item を開く。title（`agent-vm-gh <PAT 名>`）から PAT の名前が分かる。

## 5. VM で動かすか、host で動かすか

入口は 3 つの契約で決まる。

- (a) 素の `claude` / `codex` は常に host の実行ファイルで、agent-vm を通らない。host で動かしたいときは、そのまま打つ。
- (b) `vclaude` / `vcodex` と `agent-vm claude|codex` は同じ契約で、agent-vm の判定に従う。通常は VM で起動し、repo の外と (c) の一覧に載った repo では host で動く。異常があれば止まる（6 節）。
- (c) `~/.config/agent-vm/config` は、(b) で起動しても host で動かす repo の一覧である。(b) にだけ効き、素の `claude` / `codex` には関係しない。

(c) には repo の絶対パスを 1 行 1 パスで書く。`#` 以降はコメントとして無視される。
このファイルは host にだけ置く。repo の中に置かないのは、VM が書ける場所に隔離の解除設定を置かせないためである。

exclude に載せた repo では、隔離だけでなく、6 節の git 面検査とログの取り込みも行われない。host でそのまま `git` や `claude` を動かすのと同じ状態になる。

VM 経由の入口を `vclaude` / `vcodex` に変えた後は、`chezmoi apply` の後に新しいシェルを開く。開いたままのシェルには古い `claude()` 関数が残る。

## 6. 終了時の表示と復旧

### 終了コード

| コード | 意味                                                                                                                                                                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | 起動を止めた。OrbStack が応答しない、`.git` が壊れている、以前 VM で使った repo の `.git` が消えている、repo の外で `agent-vm shell` を実行した、など。host には切り替わらない。これは意図した挙動であり、host で動かすかどうかは、agent-vm を通さずに `claude` / `codex` を直接打って自分で選ぶ。 |
| 3      | セッション中に `.git/hooks` や `.git/config` の実行系設定など、host で git を使ったときに実行される面が変わっていた。                                                                                                                                                                              |
| 4      | セッションログの一部が host 側の記録と食い違っていて、取り込めなかった。                                                                                                                                                                                                                           |
| 5      | 終了処理のロックを取れず、ログ取り込みと git 面検査を省略した。                                                                                                                                                                                                                                    |

コード 3 と 4 は、内容そのものは失われていない。ツールの起動と終了は正常に完了している。

### 復旧コマンド

- `agent-vm restore-git [repo]`: git 面検査が報告した変更を元に戻す。`.git/hooks` 配下の変更・削除された exec 系設定は取り消す。`.envrc` などの untracked ファイルは削除せず、`*.agent-vm-quarantine` に改名する。
- `agent-vm accept-git [repo]`: host で自分が行った `.git/hooks` の変更（典型は `pnpm install` の `prepare` による hook の再インストール）を、内容 diff を確認して新しい基準に取り込む。host の端末で実行する。
  - 変わった hook ごとに要約（size / lines / mode / sha 先頭 8 桁）と diff を表示し、`y` で確定する。確定した内容が `restore-git` の書き戻し元にもなる。確認は `/dev/tty` から読むので、`printf y |` のようなパイプでは承認できない。
  - 身に覚えのない変更には使わず `restore-git` を使う。
  - hook 以外の項目（実行系 config、`.envrc` など）と、全文を確認できない hook（64 KiB 超、1000 行超、400 バイト超の行、NUL を含む、読めない、名前が `[A-Za-z0-9][A-Za-z0-9._-]*` に合わない、サブディレクトリ内）は受け入れず、理由つきで `not accepted` と一覧に出る。これらは引き続き報告される（設計どおりで、不具合ではない）。
  - 受け入れるのは hook ファイルのバイト列だけで、hook が呼ぶ repo 内のスクリプトは承認しない。それらは `git diff` で確認する。受け入れた後に実行ビットだけ変えられた場合は検知されない。
  - 1 回に受け入れるのは 16 件・表示 3000 行まで。既にある hook の変更を新規の hook より優先する。見覚えのない hook が大量にあるときは `restore-git` で消してから受け入れる。
  - 確認の後で hook や baseline が変わっていたら、何も書かずに終了コード 3 で止まる。VM のセッションを止めてから再実行する。起動中（準備中）は lock 待ちで失敗するので、起動が終わってから実行する。
  - 終了コード: 0 は受け入れて残りなし、または何もしなかった（`n`・EOF を含む）。3 は受け入れた後も報告が残る、または中止した。1 は拒否。
- `agent-vm sync [--inspect]`: ログ取り込みと git 面検査をその場で実行する。`--inspect` は何も書き換えずに差分だけを表示する。
- 初回の準備が途中で止まったマシンは `agent-vm rm` で消し、次の起動で作り直す。
- VM の中で手で `chezmoi apply` すると、次の bootstrap まで音声通知の hook と除外した MCP が戻る。戻したくなければ `agent-vm rm` で作り直す。
- VM の中で user スコープや codex の設定に足した MCP は、dotfiles の変更後の bootstrap で取り除かれる（Claude の project スコープは残る）。

agent-vm 自体が想定外のエラーで止まったとき（OrbStack の不調を含む）は、その場は agent-vm を通さずに `claude` / `codex` を直接打って、host で作業を続けられる。machine を作り直したい場合は `agent-vm rm` で削除し、次回起動時に作り直す。

`.git` が壊れた repo、または以前 VM で使った repo の `.git` が消えている場合だけは host に切り替わらず止まる。
git が失敗したことも、`.git` が消えていることも、それ自体は「repo の外にいる証拠」にならない。VM が `.git` を壊した可能性を否定できないので、host での実行を続けさせないほうが安全である。この場合に host で動かすには、agent-vm を通さずに `claude` / `codex` を直接打つ。

## 7. 気をつけること

- **VM セッション中は、その repo で host の git を使わない。** git 面検査は起動時と終了時にしか走らないので、セッション中に host で git を使うと、検査の前に改変された設定が実行されうる。ターミナルタイトルが `[vm:<machine>] <repo>` に変わっている間は VM セッション中である。
- **VM で使った repo を host で使うときは、VM が書き換えたファイルを自分で確かめる。** 素の `claude` / `codex` や git を host で動かすと、VM が書き換えたファイルを、host が検査なしで読み、実行しうる。確かめる手順は 2 つに分かれる。
  - **`.git/hooks` と `.git/config` の実行系設定**: VM セッションの終了時の報告（終了コード 3）を確かめてから、host で使う。終了コード 3 が守るのは、この `.git` の面だけである。
  - **repo 内で host が読み、実行しうるファイル**（`.claude/` 配下全体、`.mcp.json`、`CLAUDE.md`、`.envrc`、`.vscode/tasks.json` など）: launcher は検査しない。VM セッションの後、host で素の `claude` / `codex` を開く前に、`git status --ignored` と `git diff` で自分で確かめる。`.claude/settings.local.json` のように gitignore されたファイルは `git diff` に出ないので、`--ignored` を使う。
  - 後者を自動で検知する仕組みは無い。確かめ忘れは、残っているリスクである。
- `agent-vm env adopt <machine>` は、孤立した env ファイルが「移動前の同じ repo」のものかどうかを確認しない。記録された repo path が存在しないというだけで孤立と判定する。引き継ぐかどうかは自分で判断する。
- mac のクリップボードにある画像は VM に貼り付けられない。画像は repo 内に保存してパスで渡す（repo は host と同じパスで mount されているので、そのまま VM からも読める）。
- VM の `~/.gitconfig` は、GitHub の取得を SSH に書き換えない。`https://github.com/` の取得は匿名の HTTPS のまま行い、push だけを `pushInsteadOf` で SSH（転送された agent）にする。取得まで SSH に書き換えると、agent の承認が毎回要り、APM などの取得が失敗するか止まるため。そのため、VM の中では private のリポジトリを `https://github.com/` の URL で取得できない。private のリポジトリは `git@github.com:` の URL を直接使う（private-skills はこの形）。
- VM では今、APM の skills が入らない。lockfile のない VM は `mizchi/explainer` の最新版を取りに行き、その `SKILL.md` の frontmatter が読めないため `apm install` 全体が中止される。private の `berlysia/shiori` も、token のない HTTPS では取れない。VM では APM の失敗は WARNING に留まり apply は止まらない。成功したかどうかは VM の中に `~/.apm/.install-state` があるかで判別できる。
- **golden machine（`agent-vm-golden`）には手で入らない。** golden machine の中身はすべての clone に配られる。手で入って停止し直した golden machine は、dotfiles が同じ間は自動では検知されない。`orb -m agent-vm-golden` などで入ってしまった場合は、`agent-vm golden rm` で作り直す。
- golden machine の作成と更新のときに出る「no headless shell」の警告は想定どおりである。golden machine にはブラウザを配らず、ブラウザは repo ごとの machine に配られる。
- apt・mise・APM の上流の更新は、dotfiles を変えない限り golden machine に入らない。取り込むには `agent-vm golden refresh` を実行する。
- golden machine の claude 本体は、golden machine を作ったときの版のまま残る。clone 先の claude が古くて困る場合は、`agent-vm golden rm` で作り直す。
- dotfiles を古い版に戻すときは、先に `~/.local/share/agent-vm/creating/` が空であることを確かめる。古い launcher は作成中の印を知らない。
- VM で `node_modules` を作り直す系のコマンド（`npm ci`、`pnpm install --force`、`yarn install`、`bun install --force`）は、`node_modules` ディレクトリが mount 先でも成功し、mount も保たれる。
- 1 つの worktree で差し替えるパッケージは 500 件までである。超えた worktree はルートのパッケージだけを差し替え、警告を出す。

## 8. 片付け

- `agent-vm list`: machine 名・repo path・repo の存在有無を一覧する。
- `agent-vm gc`: repo が無くなった machine をまとめて削除する。確認を求められる。
- `agent-vm rm [repo]`: 指定した repo の machine を明示的に削除する。作り直したいときや、不要になったときに使う。
- `agent-vm golden refresh`: golden machine を今すぐ更新する。dotfiles が同じでも、bootstrap と seal をやり直す。
- `agent-vm golden rm`: golden machine を削除する。確認を求められる。既存の repo ごとの machine はそのまま動く。golden machine は次の新規作成で作り直される。

machine を侵害された疑いがある場合、または使わなくなった repo の認証を消したい場合は次を行う。

1. claude.ai と ChatGPT のセッション管理画面から、その machine のログインセッションを取り消す。
2. `agent-vm rm <repo>` で machine を削除する。

認証は machine ごとに独立している。1 つの machine が侵害されても、影響はその machine の認証に限られる。

## 9. mac 実機での確認項目

WSL 上では検証できず、mac 実機でしか確かめられない観点の一覧である。仕様の回帰は `tests/agent-vm/` が見る。ここには、何を確かめるかだけを書く。

- V1: isolated machine の mount 先に VM から書き込んだ内容が host に反映されること（staging 方式が必要な理由）
- V2: VM user の UID と mount 上のファイルの所有者表示が host と整合すること
- V3: `--forward-ssh-agent` と 1Password の agent で、`ssh -T git@github.com` と SSH 署名付きの `git commit -S` が通ること、承認プロンプトの粒度
- V4: 新規 machine の作成から初回の claude 起動までの所要時間と、warm 起動での launcher の追加時間（3 秒以内）
- V5: `--isolate-network` の下で API に到達でき、`host.orb.internal` には到達できないこと
- V6: `orb -m <m> …` で TTY が付き、claude の対話 UI が崩れずに動くこと
- V7: 未ログインの VM で、mac のブラウザで承認してコードを貼る経路でログインでき、2 回目以降はログインなしで起動すること
- V8: VM 内のサーバーに、mac の `localhost:<port>` と `<machine>.orb.local` のどちらで届くか
- V9: Codex 内蔵 sandbox（Landlock + seccomp）が VM 内で動くか
- V10: `XDG_RUNTIME_DIR` の書き込み先が tmpfs であること
- V11: 同一ターミナルで claude / codex を連続起動したときの、`op inject` の生体認証プロンプトの頻度
- V12: `~/.codex/sessions` が jsonl だけで構成されるか、付随ファイルがあるか
- V13: 非対話の bootstrap で `SSH_AUTH_SOCK` が有効になり、private-skills の SSH clone が通ること
- V14: macOS の bash 3.2 と標準 perl で取った fd 9 の flock が、perl の終了後も保持され、launcher の `kill -9` で解放されること
- V15: dotfiles の変更後の bootstrap の再適用で、VM の `~/.claude/.credentials.json` と `~/.codex/auth.json` が残り、再ログインが要らないこと
- V16: 新規 machine の初回 bootstrap で claude が非対話で導入されて `bash -lc` から見つかり、2 回目は再導入されず、導入の失敗は bootstrap を非 0 で終わらせて次回起動で再試行されること
- V17: cloud-init が書く GitHub の host key が公式の fingerprint と一致し、bootstrap の SSH clone が確認なしで通ること
- V18: golden machine が無い状態の最初の 1 台で、`agent-vm-golden`（stopped）と repo の machine（running）ができ、`creating the golden machine` が出ること
- V19: dotfiles を変えずに作る 2 台目で、`updating the golden machine` が出ず、30 秒以内に終わること
- V20: dotfiles の tracked file を変えた後の新規作成で、`updating the golden machine` が出ること
- V21: `agent-vm golden rm` の後も既存の clone 先が起動して書き込み内容を保ち、`agent-vm golden refresh` が golden machine を作り直せること
- V22: clone 先の hostname、`/etc/machine-id`、cloud-init の instance、`CLAUDE_COMPUTER_NAME`、ブラウザ系の MCP、`headless_shell` が clone 先ごとに正しいこと
- V23: clone 先でログインしても、`agent-vm golden refresh` の後に作る別の machine に認証の痕跡（`~/.claude/.credentials.json`、`~/.codex/auth.json`、`~/.claude.json` の `oauthAccount`）が無いこと
- V24: root の perl が fd 経由の bind mount（`mount --no-canonicalize --bind /proc/<pid>/fd/<src> /proc/<pid>/fd/<dst>`）に成功し、mountinfo の mountpoint が正規化したパスになること
- V25: bind mount の mount 先と元の device:inode が一致し、mountinfo の root 欄が保存先の `data` で終わること
- V26: host で `node_modules` を消して作り直した後と、worktree を消した後の `agent-vm node-modules-sync` が、失効を検出して張り直し、消した worktree の mount を外して保存先を回収すること
- V27: 空白を含むパスの npm workspace を host と VM の両方で install しても、`tsc` と `oxlint` が両側で動き、片側の install がもう片側を壊さないこと。host に現れた空の `node_modules` が host の動作を変えないこと
- V28: VM の `npm ci`、`pnpm install --force`、`yarn install`、`bun install --force` が、mount を保ったまま成功すること
- V29: VM の Claude から `git-worktree-create` と `git-worktree-cleanup` を実行でき、保護フックに止められずに mount が張られて外されること
- V30: VM の `portless run` のサーバーに mac の Chrome で `http://<app>.localhost:<port>/` から届くこと、mac の待ち受けアドレスが loopback だけであること
- V31: 2 台の machine の proxy のポートが重ならず、同じポートへの直接の bind や片方の proxy の停止が、もう片方の URL に影響しないこと。proxy の停止中に別の machine が bind したときの届く先と、同名のアプリの間の cookie の扱い
- V32: linked worktree と main worktree の `portless run` が、`http://<branch>.<app>.localhost:<port>` と `http://<app>.localhost:<port>` でそれぞれの内容を同時に返すこと
- V33: mac と VM で portless が mise の設定どおりの版で入り、VM の proxy が `127.0.0.1` と `[::1]` だけで待ち受け、`portless list` が起動した dev server の名前を表示すること
