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
待ちを事前に済ませたい場合は `agent-vm prewarm` を実行する。machine を作成し、dotfiles を適用するところまでを、ツールを起動せずに行う。

Claude と Codex は machine ごとに初回だけログインが要る。
表示された URL を mac のブラウザで開いて承認し、コードを VM 側に貼り付ける。
2 回目以降はその machine に保存された認証でそのまま起動する。

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
- `agent-vm sync [--inspect]`: ログ取り込みと git 面検査をその場で実行する。`--inspect` は何も書き換えずに差分だけを表示する。
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
- VM では APM の skills のうち、既定ブランチの解決が要る GitHub のリポジトリの分（9 件中 5 件）が入らず、`refs/heads/.invalid` で失敗する（実機で観測、再現あり）。VM の `~/.gitconfig` の SSH への書き換え（`url."git@github.com:".insteadOf https://github.com/`）と、VM に GitHub のトークンを置かない設計の組み合わせが原因と推測している（推測。host で成功する理由は未検証）。書き換えを無効にすると公開リポジトリは入る。別の課題として扱う。VM では APM の失敗は WARNING に留まり apply は止まらない。成功したかどうかは VM の中に `~/.apm/.install-state` があるかで判別できる。

## 8. 片付け

- `agent-vm list`: machine 名・repo path・repo の存在有無を一覧する。
- `agent-vm gc`: repo が無くなった machine をまとめて削除する。確認を求められる。
- `agent-vm rm [repo]`: 指定した repo の machine を明示的に削除する。作り直したいときや、不要になったときに使う。

machine を侵害された疑いがある場合、または使わなくなった repo の認証を消したい場合は次を行う。

1. claude.ai と ChatGPT のセッション管理画面から、その machine のログインセッションを取り消す。
2. `agent-vm rm <repo>` で machine を削除する。

認証は machine ごとに独立している。1 つの machine が侵害されても、影響はその machine の認証に限られる。

## 9. mac 実機での確認項目

以下は WSL 上のこのセッションでは検証できず、mac 実機で確認する。

| #   | やること                                                                                                                  | 期待する結果                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | isolated machine の mount 先に VM 内から書き込む                                                                          | host 側に反映される（staging 方式が必要であることの確認）                                                                                                                   |
| V2  | VM user の UID と mount 上ファイルの所有者表示を見る                                                                      | host 側と整合した表示になる                                                                                                                                                 |
| V3  | `--forward-ssh-agent` + 1Password agent で `ssh -T git@github.com` と `git commit -S` を行う                              | どちらも成功し、承認プロンプトの粒度を確認できる                                                                                                                            |
| V4  | 新規 machine を作成し初回 claude 起動までの所要時間を計測する（全 mise セット時と軽量セット時の両方）                     | warm 起動時の launcher 追加時間が 3 秒以内に収まる                                                                                                                          |
| V5  | `--isolate-network` 下で claude / codex から API に到達する。`host.orb.internal` に到達を試みる                           | API 疎通は成功し、`host.orb.internal` には到達できない                                                                                                                      |
| V6  | `orb -m <m> …` を実行する                                                                                                 | TTY が付き、claude の対話 UI が動く                                                                                                                                         |
| V7  | 未ログインの VM で claude を起動する                                                                                      | ログイン手順が表示され、mac のブラウザで URL を開いて承認し、表示されたコードを VM 側に貼り付ける経路でログインできる。2 回目以降はログインなしで起動する                   |
| V8  | VM 内のサーバーに mac の `localhost:<port>` または `<machine>.orb.local` で到達を試みる                                   | dev server のプレビューが到達可能かどうかが分かる                                                                                                                           |
| V9  | Codex 内蔵 sandbox（Landlock + seccomp）を VM 内で動かす                                                                  | 動作する、または動作しないことが分かる                                                                                                                                      |
| V10 | `orb -m <m> sh -c` 実行時に `XDG_RUNTIME_DIR` の有無と書き込み先を確認する                                                | 書き込み先が tmpfs である                                                                                                                                                   |
| V11 | 同一ターミナルで claude / codex を連続起動する                                                                            | `op inject` の生体認証プロンプトの頻度が分かる                                                                                                                              |
| V12 | `~/.codex/sessions` の中身を確認する                                                                                      | jsonl のみで構成されているか、付随ファイルの有無が分かる                                                                                                                    |
| V13 | 非対話の `orb -m <m> bash bootstrap.sh` を実行する                                                                        | `SSH_AUTH_SOCK` が有効で、private-skills external の SSH clone が通る                                                                                                       |
| V14 | macOS の bash 3.2 + 標準 perl で fd 9 の flock を取得し、launcher を `kill -9` する                                       | flock は perl 終了後も保持され、`kill -9` で解放される                                                                                                                      |
| V15 | dotfiles を変更して bootstrap の再適用を走らせる                                                                          | VM の `~/.claude/.credentials.json` と `~/.codex/auth.json` が残り、再ログインが要らない                                                                                    |
| V16 | 新規 machine の初回 bootstrap で claude の導入を確認し、2 回目の bootstrap も走らせる。導入をネットワーク遮断で失敗させる | 初回は非対話で導入され `bash -lc` の起動シェルから見つかる。2 回目は installer が再実行されず版も変わらない。導入失敗時は bootstrap が非 0 で終わり、次回起動で再試行される |
| V17 | cloud-init が書く GitHub の host key を確認する                                                                           | 公式の fingerprint と一致し、bootstrap の SSH clone が確認なしで通る                                                                                                        |

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

未確認の項目: V8、V9、V12。
