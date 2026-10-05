# agent-vm: claude / codex を OrbStack の隔離マシンで動かす

## 1. 何をするか

`agent-vm` は、mac 上で `claude` / `codex` を打ったときに、その repo 専用の OrbStack isolated machine の中でツールを起動する仕組みである。

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

repo の中で `claude` または `codex` と打つだけでよい。打鍵は変わらない。

初めてその repo で起動したときだけ、machine の作成を待つ。
進捗は段階ごとに 1 行ずつ表示される。
repo ごとの machine は、bootstrap 済みの golden machine（`agent-vm-golden`）の clone で作る。待ち時間は次のとおり（2026-10-02 の実測）。

- **最初の 1 台**: golden machine の作成を待つ。実測 332 秒。Ubuntu の mirror が遅いと、さらに延びる（遅かった回は 27 分）。
- **2 台目以降**: golden machine の clone から起動する。実測 6 秒。
- **dotfiles を変えた後の最初の新規作成**: golden machine の差分更新の分だけ待つ。差分更新と clone を合わせて実測 10 秒（変更の量で延びる）。

`agent-vm golden refresh` を実行すると、これらの待ちを前もって済ませられる。初回セットアップの最後に一度実行しておくとよい。
1 台分の待ちを事前に済ませたい場合は、今までどおり `agent-vm prewarm` も使える。machine を作成し、dotfiles を適用するところまでを、ツールを起動せずに行う。

Claude と Codex は machine ごとに初回だけログインが要る。
表示された URL を mac のブラウザで開いて承認し、コードを VM 側に貼り付ける。
2 回目以降はその machine に保存された認証でそのまま起動する。

### VM でブラウザを使う

VM の Claude は、playwright と chrome-devtools の MCP で、VM の中の headless ブラウザを操作できる。dev server の画面確認を、VM を離れずに行える（スクリーンショット、DOM のスナップショット、パフォーマンストレース）。drawio MCP は VM では使わない。

- **Codex では使えない。** VM の Codex にはブラウザの MCP を載せていない（Codex の playwright は `@latest` の指定で、利用頻度が低いため別 issue とした）。ブラウザが要るときは、同じ VM の Claude を使う。
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
  - ただし、複数の machine が同じポートを使うと、`localhost` は先に bind した machine に届く。先に bind した側のサーバーを止めても、転送は後から bind した machine に移らず、応答しなくなる（#207）。
  - portless を通せば、人が開くのは machine ごとの proxy のポートだけになり、launcher の割り当てが machine 同士で重なることはない。VM の中のプロセスがほかの machine のポートに直接 bind する場合は防げない（「気をつけること」）。
- **うまく開けないとき。**
  - launcher が `proxy port for <machine> changed ...` を表示したとき、または表示のポートで開けないときは、VM の中で `portless proxy stop` を実行してから dev server を起動し直す。前に起動した proxy が、古いポートで動き続けていることがある。
  - `portless proxy stop` は、proxy を止めたのに `Failed to stop proxy: ENOENT ... proxy.pid` と表示することがある（0.15.6 で、4 回のうち 3 回。原因は調べていない）。止まったかどうかは、VM で `ss -ltn | grep <port>` を実行して、待ち受けが無いことで確かめる。
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
- **版。** ブラウザの版は `package.json` の `@playwright/mcp` の版で決まる。chrome-devtools-mcp を headless shell と組み合わせるのは公式にはサポートされていない。動作を確認した版は 0.25.0 で、版を上げたときは playwright と chrome-devtools の両方で、スクリーンショットとパフォーマンストレースを取る確認をやり直す。

警告は、害が出る場面で出る。どれも起動は失敗させず、ブラウザの MCP だけが使えない状態になる。

| 場面            | 条件                                                     | 回復手順                                                         |
| --------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| `chezmoi apply` | ブラウザの取得の失敗（同じ理由が続くときは 1 行に縮む）  | `agent-vm fetch-browsers`                                        |
| 起動            | ストアに要求された版が無い                               | `agent-vm fetch-browsers`                                        |
| 起動            | ストアの内容が取得時の記録と一致しない                   | `agent-vm fetch-browsers --force`                                |
| 起動            | clonefile の失敗、または別のボリューム                   | `$AGENT_VM_STATE_DIR` が APFS の単一ボリュームにあるかを確かめる |
| bootstrap       | machine にブラウザのマウントが無い（古い machine）       | `agent-vm rm` で作り直す                                         |
| bootstrap       | ブラウザの実行ファイルが無い、依存ライブラリの欠け       | `agent-vm fetch-browsers` の後に、もう一度起動する               |
| bootstrap       | VM の MCP の版と、複製したブラウザの版が違う（助言のみ） | `chezmoi apply` と `agent-vm fetch-browsers`                     |

ブラウザの対応より前に作った machine には、マウントが無く、後から足す手段も無い。使うには `agent-vm rm` で作り直す。失うのは VM 内のログイン状態（Claude と Codex）と、VM の中に入れたツールである。repo、セッションログ（outbox 経由で取り込み済み）、host の env ファイルは残る。

### node_modules は host と VM で別になる

VM の中では、repo の各パッケージ（`package.json` を持つディレクトリ）の `node_modules` が、VM ローカルのディスクへの bind mount に差し替わる（`docs/decisions/0022-agent-vm-node-modules.md`）。mac と VM が、互いの install でプラットフォーム別のパッケージ（TS7、oxc 系など）を壊し合わない。

- **VM で一度 install する。** 起動のたびに launcher が差し替えを揃える。VM の `node_modules` が空で host にある worktree では、起動時に 1 行で install を促す。
- **worktree は `git-worktree-create` と `git-worktree-cleanup` で作り、消す。** どちらも VM の中でも host でも、差し替えを追従させる。`git-worktree-create` は、差し替えの後に依存もインストールする（`docs/commands/git-worktree-create.md`）。`git worktree add` / `git worktree remove` を直接使うと追従しない（下の表の最後の行）。
- **host に空の `node_modules` が現れることがある。** 差し替えの mount 先として VM が作ったディレクトリである。Node のモジュール解決は空の `node_modules` を素通りするので、host の動作は変わらない。git も空のディレクトリを追跡しない。
- **VM の Claude は、mount を手で張り直せない**（保護フック）。回復は下の表の手順で行う。
- **移行**: このリリースより前に VM で install したことのある repo は、host の `node_modules` が linux 用に上書きされている可能性がある。最初の起動の前に、host でその repo の install をやり直す。

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
- `gh pr merge` は host で行う。この token には contents の write が無いので、VM から直接 merge はできない。他者の PR の auto-merge の有効化は、2026-10-01 に 1 つの repo で試して拒否された（`FORBIDDEN`）が、branch protection の設定によって結果が変わりうる。
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

## 5. host で動かしたいとき

1 回だけ host で動かすには `AGENT_VM=off claude`（または `codex`）と打つ。

常にその repo を host で動かしたい場合は、`~/.config/agent-vm/config` に repo の絶対パスを 1 行 1 パスで書く。`#` 以降はコメントとして無視される。
このファイルは host にだけ置く。repo の中に置かないのは、VM が書ける場所に隔離の解除設定を置かせないためである。

exclude に載せた repo では、隔離だけでなく、6 節の git 面検査とログの取り込みも行われない。host でそのまま `git` や `claude` を動かすのと同じ状態になる。

起動が終了コード 1 で止まったときも、`AGENT_VM=off` を付ければ host に切り替えられる（6 節を参照）。

## 6. 終了時の表示と復旧

### 終了コード

| コード | 意味                                                                                                                                                                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | 起動を止めた。OrbStack が応答しない、`.git` が壊れている、以前 VM で使った repo の `.git` が消えている、repo の外で `agent-vm shell` を実行した、など。host には切り替わらない。これは意図した挙動であり、host で動かすかどうかは `AGENT_VM=off` を付けて自分で選ぶ。 |
| 3      | セッション中に `.git/hooks` や `.git/config` の実行系設定など、host で git を使ったときに実行される面が変わっていた。                                                                                                                                                 |
| 4      | セッションログの一部が host 側の記録と食い違っていて、取り込めなかった。                                                                                                                                                                                              |
| 5      | 終了処理のロックを取れず、ログ取り込みと git 面検査を省略した。                                                                                                                                                                                                       |

コード 3 と 4 は、内容そのものは失われていない。ツールの起動と終了は正常に完了している。

### 復旧コマンド

- `agent-vm restore-git [repo]`: git 面検査が報告した変更を元に戻す。`.git/hooks` 配下の変更・削除された exec 系設定は取り消す。`.envrc` などの untracked ファイルは削除せず、`*.agent-vm-quarantine` に改名する。
- `agent-vm accept-git [repo]`: host で自分が行った `.git/hooks` の変更（典型は `pnpm install` の `prepare` による hook の再インストール）を、内容 diff を確認して新しい基準に取り込む。host の端末で実行する。
  - 変わった hook ごとに要約（size / lines / mode / sha 先頭 8 桁）と diff を表示し、`y` で確定する。確定した内容が `restore-git` の書き戻し元にもなる。確認は `/dev/tty` から読むので、`printf y |` のようなパイプでは承認できない。
  - 身に覚えのない変更には使わず `restore-git` を使う。
  - hook 以外の項目（実行系 config、`.envrc` など）と、全文を確認できない hook（64 KiB 超、1000 行超、400 バイト超の行、NUL を含む、読めない、名前が `[A-Za-z0-9][A-Za-z0-9._-]*` に合わない、サブディレクトリ内）は受け入れず、理由つきで `not accepted` と一覧に出る。これらは従来どおり報告され続ける（設計どおりで、不具合ではない）。
  - 受け入れるのは hook ファイルのバイト列だけで、hook が呼ぶ repo 内のスクリプトは承認しない。それらは `git diff` で確認する。受け入れた後に実行ビットだけ変えられた場合は検知されない。
  - 1 回に受け入れるのは 16 件・表示 3000 行まで。既にある hook の変更を新規の hook より優先する。見覚えのない hook が大量にあるときは `restore-git` で消してから受け入れる。
  - 確認の後で hook や baseline が変わっていたら、何も書かずに終了コード 3 で止まる。VM のセッションを止めてから再実行する。起動中（準備中）は lock 待ちで失敗するので、起動が終わってから実行する。
  - 終了コード: 0 は受け入れて残りなし、または何もしなかった（`n`・EOF を含む）。3 は受け入れた後も報告が残る、または中止した。1 は拒否。
- `agent-vm sync [--inspect]`: ログ取り込みと`: ログ取り込みと git 面検査をその場で実行する。`--inspect` は何も書き換えずに差分だけを表示する。
- 初回の準備が途中で止まったマシンは `agent-vm rm` で消し、次の起動で作り直す。
- VM の中で手で `chezmoi apply` すると、次の bootstrap まで音声通知の hook と除外した MCP が戻る。戻したくなければ `agent-vm rm` で作り直す。
- VM の中で user スコープや codex の設定に足した MCP は、dotfiles の変更後の bootstrap で取り除かれる（Claude の project スコープは残る）。

agent-vm 自体が想定外のエラーで止まったとき（OrbStack の不調を含む）は、その場は `AGENT_VM=off` で host に切り替えて作業を続けられる。machine を作り直したい場合は `agent-vm rm` で削除し、次回起動時に作り直す。

`.git` が壊れた repo、または以前 VM で使った repo の `.git` が消えている場合だけは host に切り替わらず止まる。
git が失敗したことも、`.git` が消えていることも、それ自体は「repo の外にいる証拠」にならない。VM が `.git` を壊した可能性を否定できないので、host での実行を続けさせないほうが安全である。この場合に host で動かすには `AGENT_VM=off` を明示する。

## 7. 気をつけること

- **VM セッション中は、その repo で host の git を使わない。** git 面検査は起動時と終了時にしか走らないので、セッション中に host で git を使うと、検査の前に改変された設定が実行されうる。ターミナルタイトルが `[vm:<machine>] <repo>` に変わっている間は VM セッション中である。
- `agent-vm env adopt <machine>` は、孤立した env ファイルが「移動前の同じ repo」のものかどうかを確認しない。記録された repo path が存在しないというだけで孤立と判定する。引き継ぐかどうかは自分で判断する。
- mac のクリップボードにある画像は VM に貼り付けられない。画像は repo 内に保存してパスで渡す（repo は host と同じパスで mount されているので、そのまま VM からも読める）。
- VM の `~/.gitconfig` は、GitHub の取得を SSH に書き換えない。`https://github.com/` の取得は匿名の HTTPS のまま行い、push だけを `pushInsteadOf` で SSH（転送された agent）にする。取得まで SSH に書き換えると、agent の承認が毎回要り、APM などの取得が失敗するか止まるため（#194）。そのため、VM の中では private のリポジトリを `https://github.com/` の URL で取得できない。private のリポジトリは `git@github.com:` の URL を直接使う（private-skills はこの形）。
- VM では今、APM の skills が入らない。lockfile のない VM は `mizchi/explainer` の最新版を取りに行き、その `SKILL.md` の frontmatter が読めないため `apm install` 全体が中止される。private の `berlysia/shiori` も、token のない HTTPS では取れない（#231）。VM では APM の失敗は WARNING に留まり apply は止まらない。成功したかどうかは VM の中に `~/.apm/.install-state` があるかで判別できる。
- **golden machine（`agent-vm-golden`）には手で入らない。** golden machine の中身はすべての clone に配られる。手で入って停止し直した golden machine は、dotfiles が同じ間は自動では検知されない。`orb -m agent-vm-golden` などで入ってしまった場合は、`agent-vm golden rm` で作り直す。
- golden machine の作成と更新のときに出る「no headless shell」の警告は想定どおりである。golden machine にはブラウザを配らず、ブラウザは repo ごとの machine に配られる。
- apt・mise・APM の上流の更新は、dotfiles を変えない限り golden machine に入らない。取り込むには `agent-vm golden refresh` を実行する。
- golden machine の claude 本体は、golden machine を作ったときの版のまま残る。clone 先の claude が古くて困る場合は、`agent-vm golden rm` で作り直す。
- dotfiles を古い版に戻すときは、先に `~/.local/share/agent-vm/creating/` が空であることを確かめる。古い launcher は作成中の印を知らない。
- VM で `node_modules` を作り直す系のコマンド（`npm ci`、`pnpm install --force`、`yarn install`、`bun install --force`）は、`node_modules` ディレクトリが mount 先でも成功し、mount も保たれる（V28）。
- 1 つの worktree で差し替えるパッケージは 500 件までである。超えた worktree はルートのパッケージだけを差し替え、警告を出す。

## 8. 片付け

- `agent-vm list`: machine 名・repo path・repo の存在有無を一覧する。
- `agent-vm gc`: repo が無くなった machine をまとめて削除する。確認を求められる。
- `agent-vm rm [repo]`: 指定した repo の machine を明示的に削除する。作り直したいときや、不要になったときに使う。
- `agent-vm golden refresh`: golden machine を今すぐ更新する。dotfiles が同じでも、bootstrap と seal をやり直す。
- `agent-vm golden rm`: golden machine を削除する。確認を求められる。既存の repo ごとの machine はそのまま動く（V21）。golden machine は次の新規作成で作り直される。

machine を侵害された疑いがある場合、または使わなくなった repo の認証を消したい場合は次を行う。

1. claude.ai と ChatGPT のセッション管理画面から、その machine のログインセッションを取り消す。
2. `agent-vm rm <repo>` で machine を削除する。

認証は machine ごとに独立している。1 つの machine が侵害されても、影響はその machine の認証に限られる。

## 9. mac 実機での確認項目

以下は WSL 上のこのセッションでは検証できず、mac 実機で確認する。

| #   | やること                                                                                                                                                                                        | 期待する結果                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | isolated machine の mount 先に VM 内から書き込む                                                                                                                                                | host 側に反映される（staging 方式が必要であることの確認）                                                                                                                                                                             |
| V2  | VM user の UID と mount 上ファイルの所有者表示を見る                                                                                                                                            | host 側と整合した表示になる                                                                                                                                                                                                           |
| V3  | `--forward-ssh-agent` + 1Password agent で `ssh -T git@github.com` と `git commit -S` を行う                                                                                                    | どちらも成功し、承認プロンプトの粒度を確認できる                                                                                                                                                                                      |
| V4  | 新規 machine を作成し初回 claude 起動までの所要時間を計測する（全 mise セット時と軽量セット時の両方）                                                                                           | warm 起動時の launcher 追加時間が 3 秒以内に収まる                                                                                                                                                                                    |
| V5  | `--isolate-network` 下で claude / codex から API に到達する。`host.orb.internal` に到達を試みる                                                                                                 | API 疎通は成功し、`host.orb.internal` には到達できない                                                                                                                                                                                |
| V6  | `orb -m <m> …` を実行する                                                                                                                                                                       | TTY が付き、claude の対話 UI が動く                                                                                                                                                                                                   |
| V7  | 未ログインの VM で claude を起動する                                                                                                                                                            | ログイン手順が表示され、mac のブラウザで URL を開いて承認し、表示されたコードを VM 側に貼り付ける経路でログインできる。2 回目以降はログインなしで起動する                                                                             |
| V8  | VM 内のサーバーに mac の `localhost:<port>` または `<machine>.orb.local` で到達を試みる                                                                                                         | dev server のプレビューが到達可能かどうかが分かる                                                                                                                                                                                     |
| V9  | Codex 内蔵 sandbox（Landlock + seccomp）を VM 内で動かす                                                                                                                                        | 動作する、または動作しないことが分かる                                                                                                                                                                                                |
| V10 | `orb -m <m> sh -c` 実行時に `XDG_RUNTIME_DIR` の有無と書き込み先を確認する                                                                                                                      | 書き込み先が tmpfs である                                                                                                                                                                                                             |
| V11 | 同一ターミナルで claude / codex を連続起動する                                                                                                                                                  | `op inject` の生体認証プロンプトの頻度が分かる                                                                                                                                                                                        |
| V12 | `~/.codex/sessions` の中身を確認する                                                                                                                                                            | jsonl のみで構成されているか、付随ファイルの有無が分かる                                                                                                                                                                              |
| V13 | 非対話の `orb -m <m> bash bootstrap.sh` を実行する                                                                                                                                              | `SSH_AUTH_SOCK` が有効で、private-skills external の SSH clone が通る                                                                                                                                                                 |
| V14 | macOS の bash 3.2 + 標準 perl で fd 9 の flock を取得し、launcher を `kill -9` する                                                                                                             | flock は perl 終了後も保持され、`kill -9` で解放される                                                                                                                                                                                |
| V15 | dotfiles を変更して bootstrap の再適用を走らせる                                                                                                                                                | VM の `~/.claude/.credentials.json` と `~/.codex/auth.json` が残り、再ログインが要らない                                                                                                                                              |
| V16 | 新規 machine の初回 bootstrap で claude の導入を確認し、2 回目の bootstrap も走らせる。導入をネットワーク遮断で失敗させる                                                                       | 初回は非対話で導入され `bash -lc` の起動シェルから見つかる。2 回目は installer が再実行されず版も変わらない。導入失敗時は bootstrap が非 0 で終わり、次回起動で再試行される                                                           |
| V17 | cloud-init が書く GitHub の host key を確認する                                                                                                                                                 | 公式の fingerprint と一致し、bootstrap の SSH clone が確認なしで通る                                                                                                                                                                  |
| V18 | golden machine が無い状態で、新しい repo で `agent-vm prewarm` を実行する（最初の 1 台）                                                                                                        | 成功し、`agent-vm-golden`（stopped）と repo の machine（running）ができる。`creating the golden machine` が出る。golden machine の bootstrap の「no headless shell」の警告は想定どおり                                                |
| V19 | dotfiles を変えずに、別の新しい repo で `agent-vm prewarm` を実行する（2 台目）                                                                                                                 | `updating the golden machine` が出ず、30 秒以内に終わる                                                                                                                                                                               |
| V20 | dotfiles の tracked file を 1 つ変えてから、別の新しい repo で `agent-vm prewarm` を実行する                                                                                                    | `updating the golden machine` が出る                                                                                                                                                                                                  |
| V21 | 2 台の clone 先に書き込んで停止し、`agent-vm golden rm` の後に両方を起動して読み出す。最後に `agent-vm golden refresh` を実行する                                                               | 両方が起動して書き込んだ内容を返す。`golden refresh` が golden machine を作り直して成功する                                                                                                                                           |
| V22 | clone 先で hostname、`/etc/machine-id`、`/var/lib/cloud/instances` と sem の時刻、`CLAUDE_COMPUTER_NAME`、browser 系 MCP、`headless_shell` を確かめる                                           | hostname と `CLAUDE_COMPUTER_NAME` は clone 先の名前。machine-id は clone ごとに違う。cloud-init の instance は `agent-vm-golden` の 1 つで、sem は clone より前の時刻。playwright と chrome-devtools が残り、`headless_shell` がある |
| V23 | clone 先で claude と codex にログインしてから `agent-vm golden refresh` を実行し、別の新しい repo の machine の認証の痕跡を確かめる                                                             | 新しい machine に `~/.claude/.credentials.json` と `~/.codex/auth.json` が無く、`~/.claude.json` に `oauthAccount` が無い                                                                                                             |
| V24 | VM で、fd 経由の bind mount（`mount --no-canonicalize --bind /proc/<pid>/fd/<src> /proc/<pid>/fd/<dst>`）を root の perl から行う                                                               | 成功し、mountinfo の mountpoint が正規化したパスになる                                                                                                                                                                                |
| V25 | bind mount の mount 先と元の device:inode、mountinfo の root 欄と major:minor を見る                                                                                                            | device:inode が一致し、root 欄が保存先の `data` で終わる                                                                                                                                                                              |
| V26 | host で `node_modules` を消して作り直し、`agent-vm node-modules-sync` を実行する。host で worktree を消してから同じく実行する                                                                   | sync が失効を検出して張り直す。消した worktree の mount は sync が外し、保存先を回収する                                                                                                                                              |
| V27 | 空白を含むパスの npm workspace を host と VM の両方で install し、両側で `tsc` と `oxlint` を実行する。host に現れた空の `node_modules` のまま、host で `npm install` と `tsc` をやり直す       | どれも成功し、片側の install がもう片側を壊さない。host の空の `node_modules` は host の install と `tsc` を変えない                                                                                                                  |
| V28 | VM で `npm ci`、`pnpm install --force`、`yarn install`、`bun install --force` を実行する                                                                                                        | 成功するか、失敗するものに回避策がある（7 節）                                                                                                                                                                                        |
| V29 | VM の Claude から `git-worktree-create` と `git-worktree-cleanup` を実行する                                                                                                                    | 保護フックに止められず、mount が張られて、外される                                                                                                                                                                                    |
| V30 | VM で `portless run` でサーバーを起動し、mac の Chrome で `http://<app>.localhost:<port>/` を開く。mac から `127.0.0.1` と `[::1]` に Host を付けて curl し、`lsof` で待ち受けアドレスを見る    | Chrome で開く。待ち受けアドレスは loopback だけである                                                                                                                                                                                 |
| V31 | 2 台の machine でそれぞれ `portless run` でサーバーを起動する。両方で同じポートに直接 bind する。1 台目の proxy を止め、2 台目から 1 台目のポートに bind する。同じ名前のアプリで cookie を見る | それぞれのポートが自分の machine に届く。直接の bind と 1 台目の停止は、2 台目の URL に影響しない。奪取の再現と cookie の共有は記録する                                                                                               |
| V32 | linked worktree と main worktree で同時に `portless run` でサーバーを起動する                                                                                                                   | `http://<branch>.<app>.localhost:<port>` と `http://<app>.localhost:<port>` が、それぞれの内容を返す                                                                                                                                  |
| V33 | mac と VM で `mise ls portless` と `portless --version` を実行する。VM で `ss -ltn` と `~/.portless/proxy.log` と `portless list` を見る                                                        | どちらも 0.15.6。proxy は `127.0.0.1` と `[::1]` だけで待ち受ける                                                                                                                                                                     |

### V30〜V33 の手順

人が mac で実行し、結果を下の確認結果に日付つきで記録する。コマンドの細部を実機で補正するときは、この節を直す。

**前提**: この変更を含む dotfiles で `chezmoi apply` を済ませる。2 つの repo（X、Y）で `agent-vm shell` を開いておく。下の例では、X のポートを 17300、Y のポートを 17301 とする。実際の値は、launcher の起動時の表示か `agent-vm list` の 4 列目で確かめる。

**先に実行する場合**（V30 だけ、launcher の変更なし）: 既存の machine の `agent-vm shell` で `mise use -g portless@0.15.6` を実行し、手順 3 のコマンドの前に `PORTLESS_PORT=17300 PORTLESS_HTTPS=0` を付ける。launcher が未変更の間は、17300 を割り当てる仕組みが無いので、ほかの machine で同じポートを使わない。ほかの手順は同じである。

- **V30（mac から届くこと）**
  - 操作:
    1. X のポートを控える。
    2. X の VM で `mkdir -p /tmp/vx && cd /tmp/vx && printf '{"name":"vx"}\n' >package.json` を実行する。
    3. 同じ dir で `portless run sh -c 'exec python3 -m http.server --bind 127.0.0.1 "$PORT"'` を実行する。
    4. mac の Chrome で `http://vx.localhost:17300/` を開く。
    5. mac で `curl -sS -H 'Host: vx.localhost:17300' 'http://127.0.0.1:17300/'` を実行する。名前の解決を通さずに、IPv4 の loopback に直接つなぐ。Host は Chrome が送るのと同じ形にする（portless 0.15.6 は Host のポートを落としてから照合するので、ポートの有無で結果は変わらない。research H21）。
    6. mac で `curl -sS -H 'Host: vx.localhost:17300' 'http://[::1]:17300/'` を実行する。
    7. mac で `curl -sS http://vx.localhost:17300/` を実行する（research U2）。
    8. mac で `lsof -nP -iTCP:17300 -sTCP:LISTEN` を実行する。
  - 判定（R1）: 手順 4 と 5 の結果で決める。

    | 手順 4（Chrome） | 手順 5（`127.0.0.1`） | 判定                                                                        |
    | ---------------- | --------------------- | --------------------------------------------------------------------------- |
    | 開く             | どちらでも            | 可。R1 は解消                                                               |
    | 開かない         | 届く                  | 不可（spec を改訂する）。原因は `::1` の転送か名前の解決                    |
    | 開かない         | 届かない              | 不可（spec を改訂する）。転送そのものが想定と違う。research O1 から調べ直す |

  - 判定（R11）: 手順 8 の出力の待ち受けアドレスが `127.0.0.1` か `[::1]` だけなら可。`*` や LAN のアドレスがあれば、不可とし、扱いを決める。出力が空のときは、可としない。`sudo lsof -nP -iTCP:17300 -sTCP:LISTEN` を試すか、`netstat -an -p tcp | grep 17300` で待ち受けアドレスを確かめる。どちらでも見えなければ、R11 は未確認とする。
  - 記録だけするもの: 手順 6 と 7 の結果。起動時の 1 行の表示（K11）が役に立ったか、ポートを後から探すのに手間が掛かったか（K6）。

- **V31（machine 間で衝突しないこと）**
  - 操作:
    1. Y でも V30 の 1〜3 を、`/tmp/vy` と `"name":"vy"` で行う。
    2. mac で `curl -sS -H 'Host: vx.localhost:17300' 'http://127.0.0.1:17300/'` と `curl -sS -H 'Host: vy.localhost:17301' 'http://127.0.0.1:17301/'` を実行する。
    3. X と Y の両方の VM で、別の端末から `python3 -m http.server 5174 --bind 127.0.0.1` を起動する（portless を通さない、同じポートへの直接の bind）。その状態で 2 をもう一度実行する（R12）。
    4. X の VM で `portless proxy stop` を実行する。mac で `curl -sS -H 'Host: vy.localhost:17301' 'http://127.0.0.1:17301/'` を実行する。
    5. X の proxy が止まっている状態で、Y の VM で `python3 -m http.server 17300 --bind 127.0.0.1` を起動する。その後、X の VM で `portless run ...` を起動し直す（X の proxy が起動する）。mac で `curl -sS -H 'Host: vx.localhost:17300' 'http://127.0.0.1:17300/'` を実行し、続けて `orb -m <X の machine 名> curl -sS -H 'Host: vx.localhost:17300' http://127.0.0.1:17300/` を実行する。確かめたら Y の bind を止める（R9）。
    6. X と Y の両方で `"name":"app"` の dir を作って同じように起動し、Chrome で `http://app.localhost:17300/` を開いて開発者ツールで cookie を 1 つ設定する。`http://app.localhost:17301/` を開いたときに、その cookie が送られるかを見る。さらに、Y の dev server が `Set-Cookie: t=1; Domain=localhost` を返す状態で `http://app.localhost:17301/` を開き、その後 `http://app.localhost:17300/` を開いて、`t` が X に送られるかを見る（R10）。
  - 判定: X のポートと Y のポートが異なる。2 と 3 は、`vx` の側が `/tmp/vx` の一覧を、`vy` の側が `/tmp/vy` の一覧を返す。4 は `/tmp/vy` の一覧を返す。どれかが崩れたら不可（spec を改訂する）。
  - 2 つの一覧はどちらも `package.json` だけで、見分けがつかない。Host を入れ替えた curl（17300 に `vy.localhost`、17301 に `vx.localhost`）も実行し、404 の本文の経路の一覧が、17300 では X のもの、17301 では Y のものであることで見分ける。
  - 記録だけするもの: 5 で R9 が再現したか（mac の応答が Y の一覧になるか）と、X の中から見た応答との比べ方で差が出たか。差が出れば、この比べ方を 3 節の確かめ方に書く。6 の結果と、Domain つきの cookie の結果。
- **V32（worktree）**
  - 操作:
    1. X の VM で `cd /tmp/vx && git init -q && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -qm init` を実行する。
    2. `git worktree add ../vx-feat -b feat/ui` を実行する。
    3. `/tmp/vx` と `/tmp/vx-feat` のそれぞれで、V30 の 3 と同じ `portless run ...` を実行する。
  - 判定: `/tmp/vx-feat` の側が表示する URL は `http://ui.vx.localhost:17300` である。mac の `curl -sS -H 'Host: ui.vx.localhost:17300' 'http://127.0.0.1:17300/'` と `curl -sS -H 'Host: vx.localhost:17300' 'http://127.0.0.1:17300/'` が、同時にそれぞれの dir の一覧を返す。崩れたら不可（spec を改訂する。worktree 間の衝突はオーダーの半分である）。
- **V33（導入と、VM の中の待ち受け）**
  - 操作:
    1. mac と VM の両方で、`mise ls portless` と `portless --version` を実行する。
    2. VM で、proxy が動いている状態で `ss -ltn | grep 17300` を実行する。
    3. VM で `grep -i hosts ~/.portless/proxy.log` を実行する（research U5）。
    4. VM で `portless list` を実行する。
  - 判定: 1 は、どちらも 0.15.6 を示す。2 の待ち受けアドレスは `127.0.0.1` と `[::1]` だけである（`0.0.0.0`、`*`、`[::]` があれば、境界の前提が崩れているので不可）。3 に /etc/hosts の書き込みの失敗が出ていても、V30 の手順 5 は届いている。4 は、起動した dev server の名前を表示する。
  - mise が install を拒否した場合は、その出力を記録し、対処を別途決める。

### 2026-09-30 の確認結果（macOS、OrbStack 2.2.3、Ubuntu resolute arm64）

確認できた項目:

- V1: VM から 3 つの mount 先（repo、staging、outbox）に書き込め、host に反映された。staging を host 側で作り直す方式が必要という前提は正しい。
- V2: VM の user は uid 501 で、mount 上のファイルも 501:501 と表示される。
- V3（素の machine で確認）: forwarded agent で `ssh -T git@github.com` と、SSH 署名付きの `git commit -S` が通った。launcher 経由の確認は未実施。
- V4: 新規 machine の初回 prewarm は 282 秒（軽量の mise セット、VM 用ツールと APM・プラグインの導入を含む）。2 回目以降の prewarm は再 bootstrap が無ければ 1〜2 秒。
- V5: API（api.anthropic.com、api.openai.com、github.com）には到達でき、host で待ち受けているポートへの `host.orb.internal` からの接続は拒否された。
- V10: `XDG_RUNTIME_DIR` は `/run/user/501` で tmpfs。
- V13: 非対話の bootstrap の中で、private-skills を SSH で clone できた。
- V14: macOS の bash 3.2 と標準 perl で、fd 9 の flock は perl の終了後も保持され、launcher の `kill -9` で解放された。
- V16（一部）: 初回の bootstrap で claude が非対話で導入され、再 bootstrap では再導入されない。ネットワーク遮断での失敗は未確認。
- V17: GitHub の host key の fingerprint が公式の値（`SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`）と一致した。
- 再 bootstrap（dotfiles の変更後）: rc=0 で通り、`update-claude-json` の再実行で戻った MCP も後処理で取り除かれた。
- V6: `agent-vm claude` / `agent-vm codex` の対話画面が崩れずに動いた。
- V7: Claude と Codex のどちらも、mac のブラウザで承認してコードを貼る経路でログインでき、2 回目以降の起動ではログインを求められなかった。
- V15: ログイン後に再 bootstrap を起こしても、`~/.claude/.credentials.json` と `~/.codex/auth.json` はサイズ・権限（600）・更新時刻とも変わらず、`~/.claude.json` のログイン情報（`oauthAccount`）も後処理の後に残った。
- V3（launcher 経由）: VM の中の `git commit` が SSH 署名付きになった（host の `git log --format=%G?` で `U`）。このとき 1Password の承認は求められなかった。以前の承認が一定時間有効になっていたためと推測する（未検証）。2 節のとおり毎回の承認を求めるには、1Password 側の設定を確認する。

- V11: テスト用の参照を `env.1password` に置き、`op signout` の直後に launcher 経由で 3 回続けて起動した。1Password の承認は 1 回目だけで、2 回目と 3 回目は求められなかった（`op` の CLI の承認が一定時間有効なため）。VM の中で `printenv` すると、注入した値が見えた。
- 観測（原因未特定）: V11 の 3 回の起動の間に、iTerm に対する macOS のアクセス許可（「"書類"フォルダ内のファイル」「ほかのアプリのデータ」）が合わせて 4 回出た。launcher が触れるのは状態の置き場、`~/.config/agent-vm`、`~/.claude/projects`、`~/.codex/sessions`、repo だけで、「書類」やほかのアプリのデータには触れない。その後、launcher を使わずに `orb delete` と `op item delete` / `op item get` だけを実行したときにも「ほかのアプリのデータ」の許可が出たので、launcher ではなく `orb` か `op` の CLI が原因と考えられる（どちらかは切り分けていない）。

- V8: VM の loopback（`127.0.0.1`）に bind したサーバーに、mac の `localhost:<port>` から届く。`<machine>.orb.local` は `0.0.0.0` に bind したときにしか届かず、loopback のサーバーには接続できない。`--isolate-network` の下でも同じだった（設計時の probe machine で測定し、loopback への `localhost` の到達は 2026-10-02 の下記の確認でも再確認した）。

未確認の項目: V9、V12。

### 2026-10-02 の確認結果（VM のブラウザ、macOS、OrbStack、Ubuntu resolute arm64）

VM でブラウザを使う構成（3 節）を、実機で確かめた。古い machine での警告を先に確かめ、`agent-vm rm` の後に新しい machine で残りを確かめた。

確認できた項目:

- ストア: `chezmoi apply` の後、`browser-store/` には `mcp-0.0.75` が 1 つだけあり、mode は 700。host での容量は約 337 MB（ffmpeg を含む）で、1 部だけ。
- 古い machine（マウントが無い本物の machine）: `agent-vm prewarm` は終了コード 0 で、bootstrap が「ブラウザのマウントが無く、ブラウザの MCP は無効」「有効にするには `agent-vm rm` の後に起動し直す。失うのは VM 側のログインと VM の中に入れたツール、残るのは repo、セッションログ、env ファイル」という警告を出した。VM の `~/.claude.json` の MCP は readability、context7、excalidraw だけで、ブラウザの MCP は外れていた。
- 新しい machine: `agent-vm prewarm` は終了コード 0 で、bootstrap の警告は 0 件。playwright と chrome-devtools の `args` は固定の実行パス（`/opt/agent-vm/browsers/current/bin/headless_shell`）と `--headless --isolated` を持ち、playwright の `env.LD_LIBRARY_PATH` は VM の `~/.local/lib/agent-vm-browser` を指す。Codex の設定に playwright は残らない。`/opt/agent-vm` にストアはマウントされない。
- `headless_shell` は `LD_LIBRARY_PATH` が無いと libgbm が見つからず起動に失敗する。これは設計どおりで、MCP には環境変数で渡している。付けて実行すると Chromium 149 が起動し、`ldd` に not found は無い。
- 容量: ブラウザの依存の apt は 48 パッケージ、Installed-Size の合計が 35.1 MB で、目標の 40 MB 以内に収まった。
- MCP の動作: VM の `~/.claude.json` のコマンドと env をそのまま使って MCP サーバーを起動し、stdio の JSON-RPC で確かめた。
  - playwright: `browser_navigate`（ページのタイトルは `vm-a`）と `browser_take_screenshot`（PNG）がエラー無しで応答した。
  - chrome-devtools: `navigate_page`、`take_screenshot`（PNG）、`performance_start_trace`（reload、autoStop）がエラー無しで応答し、trace の応答に `The performance trace has been stopped` を含んでいた。
  - どちらのスクリーンショットでも、見出し「こんにちは playwright」は豆腐にならずに描画された。`fc-match "sans-serif:lang=ja"` は IPAPGothic を返す。
  - VM の Claude を `agent-vm claude` で起動すると、`/mcp` で playwright と chrome-devtools が connected になった（人が確認）。上の 3 項目は、Claude を介さずに同じコマンドと env で MCP サーバーを起動して確かめたものである。
- 人の閲覧とポートの衝突（mac から curl、cookie なし）: VM の loopback に bind したサーバーに、mac の `localhost:5174` が届いた。2 台目の machine が後から同じポートに bind しても、届く先は 1 台目のままだった（F8 の再確認）。2 台目を `agent-vm rm` すると、その machine のブラウザの複製と記録だけが消え、1 台目の分は残った。
- 版の更新: `@playwright/mcp` を 0.0.74（playwright は exact の版）に一時的に変えて `chezmoi apply` を実行すると、ストアは `mcp-0.0.74` に入れ替わって `mcp-0.0.75` は消え、host の `~/.claude.json` も 0.0.74 になった。続く `agent-vm prewarm` は警告 0 件で、`current` は新しい世代を指し、古い世代は machine に残った。`git checkout package.json` の後に `chezmoi apply` と `agent-vm prewarm` を実行すると、ストアと `~/.claude.json` は 0.75 に戻った。

観測と、未確認の項目:

- 観測（切り替わりの条件は未確認）: 1 台目のサーバーを止めると、2 台目が同じポートに bind していても、mac の `localhost:5174` は 30 秒間応答しなかった。1 台目を再起動すると、再び 1 台目に届いた。最初に bind した machine に転送が固定されるように見える。2 台目に切り替わる条件は確かめていない。
- 観測: `package.json` の版だけを変えて `chezmoi apply` を実行したときは、`bun install --frozen-lockfile` が lockfile の不一致で失敗し、apply 自体の終了コードは 1 になった。ブラウザのストアの更新とは無関係で、`package.json` を戻して再実行すると終了コード 0 になった。
- 観測（この確認の範囲外）: `agent-vm rm` の確認プロンプトに EOF を渡すと「failed unexpectedly」と出る。

### 2026-10-02 の確認結果（golden clone、macOS、OrbStack 2.2.3、Ubuntu resolute arm64）

repo ごとの machine を golden machine の clone で作る構成（3 節）を、使い捨ての repo 4 つで確かめた。V18〜V23 はすべて期待どおりだった。

- V18: golden machine の作成を含む最初の 1 台は 332 秒、終了コード 0。`agent-vm-golden` は stopped、repo の machine は running で残った。警告は golden machine の bootstrap の「no headless shell」だけだった。
- V19: dotfiles を変えずに 2 台目を作ると 6 秒で、`updating the golden machine` は出なかった。
- V20: dotfiles の tracked file を 1 つ変えてから作ると 10 秒で、`updating the golden machine` が出た。
- V22: clone 先の hostname と `CLAUDE_COMPUTER_NAME` は clone 先の名前になった。machine-id は 32 桁の 16 進で、2 台の clone で違った。cloud-init の instance は `agent-vm-golden` の 1 つだけで、package の導入の sem は clone より前の時刻だった（clone 先の起動で per-instance の module は再実行されていない）。playwright と chrome-devtools の MCP が残り、playwright の args に `--executable-path /opt/agent-vm/browsers/current/bin/headless_shell` が入り、その実体もあった。
- V23: clone 先で claude と codex にログインしてから `agent-vm golden refresh`（6 秒）と別の repo の `agent-vm prewarm`（6 秒）を実行した。新しい machine には `~/.claude/.credentials.json` と `~/.codex/auth.json` が無く、`~/.claude.json` の `oauthAccount` も無かった。
- V21: 2 台の clone 先に書き込んで停止し、`agent-vm golden rm` の後に起動すると、どちらも起動して書き込んだ内容を返した。最後の `agent-vm golden refresh` は golden machine を作り直して終了コード 0 で終わった。

観測:

- V21 の `agent-vm golden refresh`（golden machine の作り直し）は 1632 秒かかった。cloud-init の apt が `archive.ubuntu.com` から約 70 KB/s でしか取得できなかったためで、同じファイルを host から取得しても同じ速さだった。mirror 側の一時的な遅さで、golden machine の仕組みとは関係がない。

### 2026-10-02 の確認結果（VM ローカルの node_modules、macOS、OrbStack 2.2.3、Ubuntu resolute arm64）

試験用の repo は、空白を含むパス（`.../nm check`）に置いた npm workspace である（ルートが `typescript` 7.0.2 と `oxlint` 1.86.0、`packages/a` が衝突する `typescript` 6.0.3）。

- V24、V25（plan-1 の T0）: fd 経由の mount は成功し、device:inode は一致した。mountinfo の root 欄は `/scon/containers/<id>/rootfs/var/lib/agent-vm/node_modules/<key>/data` の形で、major:minor（0:37）は stat の st_dev（0:64）と一致しなかった。このため、自分の mount の判定は major:minor を使わず、root 欄の末尾一致で行う（ADR-0022）。
- V26 の準備で、ヘルパーの差し替えが一度も成立していなかったことが分かった。共有 mount（virtiofs）は所有者を見ている側の uid の写しとして返し（VM で `chown` しても変わらない）、root の perl による mount 先の所有者の検査が必ず失敗していた。検査を外して直した（ADR-0022、`docs/plans/agent-vm/node-modules/plan-4.md`）。以下は直した後の結果である。
- V26:
  - host で `node_modules` を消して作り直しても、mountinfo の行は `//deleted` にならず、元のパスのまま残った。続く `agent-vm node-modules-sync` は終了コード 0 で、失効を検出して張り直した。張り直した後、`node_modules` の device:inode は保存先の `data` と一致した。
  - host で worktree を足して sync すると、mount と保存先が 2 つずつ増えた。host で `git worktree remove` すると、VM の行は元のパスのまま残った。次の sync（終了コード 0）で外れ、保存先も回収された（4 から 2）。
- V27:
  - host の `npm install` と、`tsc`（7.0.2）、`oxlint` は終了コード 0 だった。host には darwin-arm64 のパッケージが入った。
  - sync は、install を促す 1 行を出して終了コード 0 だった。
  - VM の `npm install`、`tsc`、`oxlint` も終了コード 0 で、VM には linux-arm64 のパッケージが入った。
  - その後も、host の `tsc` と `oxlint` は終了コード 0 で、darwin-arm64 のままだった。
  - host の `packages/a/node_modules` には、host の npm が入れた実物（`typescript` 6）があり、host での install のやり直しも終了コード 0 だった。
- V28: `npm ci`、`pnpm install --force`（pnpm 10）、`yarn install`（yarn 1.22.22）、`bun install --force`（bun 1.4.0）は、どれも終了コード 0 だった。どのパッケージの mount も保たれた。bun は VM に mise が入れたものを使った（`npx bun@1` は postinstall が走らずに失敗した。mount とは関係がない）。
- V29:
  - VM の Claude から `git-worktree-create v6` を実行すると、保護フックに止められずに終了コード 0 で、6 パッケージ分の mount が張られた。
  - `git-worktree-cleanup v6` は、作成後に commit の無い worktree なので、端末の無い VM の Claude からは確認できずに残した（仕様どおり）。
  - `agent-vm shell` で同じコマンドを実行して確認に `y` と答えると、worktree は消えた。mount の行も、保存先（12 から 6）も残らなかった。

### 2026-10-04 の確認結果（portless、macOS、OrbStack 2.2.3、Ubuntu resolute arm64）

dev server を portless に通す構成（3 節）を、2 台の machine（X は 17300、Y は 17301）で確かめた。V30〜V32 と、V33 の待ち受けアドレスは期待どおりだった。V33 の導入は一部が未確認である。

手順から外れたところ:

- V30〜V32 の間は `chezmoi apply` をせず、launcher はこの変更の版を取り出して直接実行した。VM は変更前の dotfiles から作られていて、mise の設定に portless は入っていなかった。portless は `mise exec portless@0.15.6 --` で動かした。
- mise の設定からの導入（V33）は、その後に確かめた。mac には、この変更が変える 4 つのファイルだけを apply した（ブランチが master より古く、全体を apply するとほかの変更が巻き戻るため）。VM は Y だけで確かめ、X では確かめていない。
- V32 は、`/tmp/vx` に repo を作る代わりに、dotfiles の repo の既存の linked worktree（ブランチ `fix/workflow-identity`）で行った。サーバーは自分の cwd を返すものを使った。
- V31 の手順 5 は、`portless run` を起動し直す代わりに `portless proxy start` を使った。
- V30 の手順 4 だけを Chrome 本体で行い、V31 の手順 6 はアプリ内ブラウザ（Chromium）で行った。

確認できた項目:

- launcher: `agent-vm prewarm` で X に 17300、Y に 17301 が割り当てられ、meta に `proxy_port` の行が入った。`agent-vm list` の 4 列目に出て、ポートの無い machine の行は tab で終わった。`agent-vm shell` のセッションには `PORTLESS_PORT=17300` と `PORTLESS_HTTPS=0` が渡り、起動時に `dev servers: ...` の 1 行が表示された。
- V30:
  - mac の Chrome で `http://vx.localhost:17300/` が開き、`/tmp/vx` の一覧を返した（R1 は解消）。
  - `127.0.0.1` と `[::1]` に Host を付けた curl は、どちらも 200 だった。OrbStack は mac の `[::1]:<port>` も転送する。名前での curl も 200 で、接続先は `::1` だった。
  - mac の `lsof` では、OrbStack が `127.0.0.1:17300` と `[::1]:17300` だけで待ち受けていた（R11 は可）。
- V31:
  - `Host: vx.localhost` は 17300 で 200、17301 で 404 だった。`Host: vy.localhost` はその逆だった。404 の経路の一覧は、17300 が X のもの、17301 が Y のものだった。
  - 両方の VM で 5174 を直接 bind しても、結果は変わらなかった（R12）。
  - X の proxy を止めても、`vy.localhost:17301` は 200 を返した。
- V32: `http://root.localhost:17300` が main worktree の dir を、`http://workflow-identity.root.localhost:17300` が linked worktree の dir を、同時に返した。
- V33:
  - VM の `ss -ltn` では、proxy は `127.0.0.1:17300` と `[::1]:17300` だけで待ち受けていた。
  - `~/.portless/proxy.log` に hosts を含む行は無かった。
  - `portless list` は、起動した 3 つの経路を表示した。
  - mac と両方の VM で、mise が portless 0.15.6 を install でき、`portless --version` は 0.15.6 を返した。
  - その後、この変更の `~/.config/mise/config.toml` を mac に apply し、Y にはこの変更の dotfiles で bootstrap をやり直した。mac と Y のどちらでも、`mise ls portless` は `portless  0.15.6  ~/.config/mise/config.toml  0.15.6` を返した。Y で portless を外してから `mise install` を実行すると、設定の行だけから 0.15.6 が入った（1.5 秒）。

記録だけの項目:

- R9（奪取）は再現した。
  - X の proxy が止まっている間に Y が `127.0.0.1:17300` を bind すると、mac の `127.0.0.1:17300` は Y に届いた。
  - その後 X の proxy を起動すると、mac の `127.0.0.1:17300` は Y に、`[::1]:17300` は X に届いた。
  - Y が bind をやめると、mac の `127.0.0.1:17300` は接続拒否になった。X の proxy は `127.0.0.1:17300` で待ち受けたままだった。
  - X の proxy を止めて起動し直すと、`127.0.0.1` と `[::1]` の両方が X に届いた。
  - 存在しない名前への応答は、奪取の間、mac から（Python の一覧）と X の中から（portless の 404）で違った。この比べ方を 3 節に書いた。
- R10（cookie）: `app.localhost:17300` で設定した cookie は、`app.localhost:17301` の Y に送られた。Y が返した `Set-Cookie: t=1; Domain=localhost` の cookie は保存されず、X には送られなかった。
- K11、K6: 起動時の 1 行と `agent-vm list` の 4 列目で、ポートは探さずに分かった。確認は agent が行ったので、人にとっての手間は測っていない。

観測と、未確認の項目:

- 観測（原因未特定）: `portless proxy stop` は、4 回のうち 3 回、`Failed to stop proxy: ENOENT: no such file or directory, unlink '/home/berlysia/.portless/proxy.pid'` と表示した。その 3 回とも proxy は止まっていて、終了コードは 0 だった。
- 観測: package.json の `name` が `@berlysia-dotfiles/root` の repo は、`root` という名前になった。
- 観測: Y の bootstrap の 1 回目は、mac のディスクの空きが無くなって失敗した（launcher は `failed unexpectedly`、続く `orb` は `wait for sconrpc ready event: ... EOF`）。空きを作ってからやり直すと、終了コード 0 で通った。何がディスクを埋めたかは切り分けていない。
- 未確認: Chrome 本体での cookie の挙動。
- V30 のやり直し（手順の前提どおり）: この変更を apply した状態で、launcher が開いたセッションの中から、`PORTLESS_PORT` を手で付けずに `portless run` を実行した。Y のポートは 17301 だった。`127.0.0.1`、`[::1]`、名前での curl はどれも 200 で、mac の待ち受けは `127.0.0.1:17301` と `[::1]:17301` だけだった。mac で `open -a "Google Chrome" http://vx.localhost:17301/` を実行すると、VM のサーバーのログに `GET /` の 200 と `GET /favicon.ico` が出た。画面は見ていない。
- ポートの付け替え（K12）: Y の proxy を 17301 で動かしたまま、別の machine の記録に 17301 を書いてから、Y を起動した。
  - launcher は `proxy port for agent-shiori-ac9943 changed 17301 -> 17302; ... recover: run 'portless proxy stop' in the VM, then start the dev server again` を表示し、セッションには `PORTLESS_PORT=17302` を渡した。
  - その状態の `portless run` は、`Proxy is running` と表示して、古い 17301 の URL を出した。新しい `PORTLESS_PORT` は使われなかった。
  - `portless proxy stop` の後に `portless run` を実行すると、proxy は 17302 で起動した。回復手順は表示のとおりに効いた。
- `agent-vm rm` で Y を消すと、記録も消え、`agent-vm list` から行が無くなった。
