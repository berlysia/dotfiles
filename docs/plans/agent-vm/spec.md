# Spec: agent-vm — OrbStack isolated machine で Claude / Codex を repo ごとに隔離起動する

## Goal

macOS 上で任意の git repo から `claude` / `codex` を打つと、その repo 専用の OrbStack isolated machine 内で起動する。home の道具類（dotfiles 由来の設定・hooks・skills）は VM から読めるが、host の原本は VM から書き換えられない。1Password の秘密と SSH 署名は mac 側で完結したまま VM で使える。VM 内のセッションログは host に戻る。

**支配軸はエルゴノミクス**（ユーザー明示）。安全境界（isolated machine）はユーザー決定済みの制約で、その内側で「普段の打鍵・待ち時間・手作業」を増やさないことを最優先にする。

## Experience Delta

- 変更前: `claude` / `codex` は mac のホームでそのまま動き、agent が `~` 全体・1Password desktop 連携・host コマンドに到達できる。
- 変更後: repo 内で `claude` / `codex` と打つだけ（打鍵は同じ）で repo 専用 VM に入る。初回だけ VM 作成の待ち（段階ごとの進捗表示付き）があり、2 回目以降の launcher 追加時間は 3 秒以内。dotfiles を編集すると（コミット前でも）次回起動時に自動で VM に反映される。VM 内のセッションログは起動・終了のたびに mac の `~/.claude/projects` 等に戻り、mac 側の `claude --resume` や insight 蒸留に載る。Claude と Codex のログインは repo（VM）ごとに初回 1 回だけで、以降はその VM に保存された認証で起動する。

## Architecture

```
mac (host)                                                   OrbStack isolated machine "agent-<repo>-<hash6>"
──────────────────────────────────────────                   ──────────────────────────────────────────────
~/.local/bin/agent-vm  (launcher, bash)
 0. health: orb 有無 + 3 秒制限付き `orb status`、chezmoi workingTree 解決。失敗なら fail closed（host 起動はしない、AGENT_VM=off を案内）
 1. repo root = dirname(git common dir)、machine 名導出、machines/<m> に repo path 記録、machine 単位の lock 取得（2〜6 を排他）
 2. build/ (VM から不可視) に tracked files を      ──mount──▶ /opt/agent-vm/src/<gen>   (この VM 専用コピー)
    コピーし hash 計算 → staging/<m>/<gen> へ mv、旧世代を削除
 3. ensure machine: orb create --isolated --isolate-network
      --forward-ssh-agent -c cloud-init.yaml                   ──▶ /etc/agent-vm (marker)、git/curl/rsync、chezmoi、GitHub host key
      --mount <repo>:<repo> --mount staging/<m>:/opt/agent-vm/src
      --mount outbox/<m>:/opt/agent-vm/outbox
 4. git 面スナップショット検査（前回セッション分）→ 取得
 5. outbox 取り込み（前回分の catch-up）
 6. hash ≠ VM applied-hash なら orb -m <m> bootstrap.sh    ──▶ src/<gen> を ~/.local/share/chezmoi へ rsync --delete
                                                                claude 未導入なら公式 installer（K16）
                                                                chezmoi init -W ~/.local/share/chezmoi --apply
                                                                symlink: ~/.claude/projects, ~/.codex/sessions → outbox
 7. op inject (mac, host 所有の env ファイルのみ) ─stdin──▶ ${XDG_RUNTIME_DIR:-/dev/shm}/agent-vm.env (0600)
 8. orb -m <m> exec claude|codex (cwd = 同一パス)             起動シェルが env を読み即削除して exec
 9. exit trap: lock 下で outbox 取り込み + git 面検査
~/.config/agent-vm/{config, env.1password, repos/<m>.env.1password}   (host のみ。VM から不可視)
darwin.sh: claude()/codex() → repo 内なら agent-vm へ
```

責務と所有:
- **launcher (`agent-vm`)**: machine ライフサイクル、下り（staging 再生成）、上り（outbox 取り込み）、秘密注入、git 面検査、起動。host にのみ存在。
- **cloud-init**: 一度きりの OS レベル準備（marker、パッケージ、chezmoi の導入、GitHub の host key の固定）。host key を固定するのは、VM の git が host の gitconfig の `url "git@github.com:" insteadOf https://github.com/`（`home/dot_gitconfig.tmpl:67-68`）で GitHub への通信を SSH にし、bootstrap の非対話 apply で private-skills の clone（K2）が走るため、初回接続の確認で止まらず、かつ初回接続で鍵を無条件に信用しないようにするため。mise は chezmoi apply の既存スクリプト（`run_onchange_install-packages-1-linux.sh.tmpl`）が host と同じ方法で入れる。
- **bootstrap.sh**: VM 側の冪等な再適用、chezmoi の宣言的管理外の VM 専用 symlink（`~/.claude/projects`, `~/.codex/sessions`）の作成、claude が未導入なら導入（K16）。
- **導入経路の分担**: OS パッケージと chezmoi 本体は cloud-init、host でも chezmoi が入れているツール（mise とその管理下）は chezmoi apply、host で chezmoi 管理外のもの（claude）は bootstrap。VM での導入経路は host と同じ層にそろえる。staging 内のものを実行するので host と VM で同じ版になる。
- **chezmoi `agent_vm` フラグ**: VM 内 apply の分岐スイッチ（mise 軽量化のみ）。
- **シェル統合**: 既存の打鍵を VM 経由にする入口。

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

既存 `ope -i claude`（`home/dot_shell_common/functions.sh:58-`）の横に `orb` 呼び出しを足す関数を 1 つ追加し、VM は手で `orb create` する。同期は手動 `rsync`、ログ回収なし。変更は 1 ファイル。
→ VM 作成・同期・ログインの手作業が repo 数に比例して増え、支配軸（エルゴノミクス）を満たさない。

### 白紙設計案 (Greenfield)

ゼロから作るなら「repo = 再生成可能な VM」を宣言的に扱う専用 CLI を置く。起源: 分離単位（repo）と状態の正本（host）を最初に決めると、(1) VM 作成は冪等な ensure、(2) 設定は host の正本から毎回導出（双方向同期ではなく一方向の再適用）、(3) 秘密は起動時の一時注入、(4) VM 内で生まれた価値ある状態（ログ）だけを明示的に回収、(5) VM に書かせた場所（repo）が host で実行されうる面を検査、という形に落ちる。devcontainer 型（`.devcontainer/` を repo に置く）は、VM から書ける場所に隔離設定を置くことになり、agent が自分の隔離を書き換えられるため採らない。

### 採用案と理由

白紙設計案を採用する。根拠:
- ユーザー明示の支配軸がエルゴノミクスであり、差分最小案は VM 作成・同期・ログインの手作業を残す。
- 設定の下り同期を VM 内 `chezmoi apply` の再実行として実装できる基盤が既にある: `~/.claude/settings.json`・`~/.claude.json`・hook deps・skills はすべて apply 時に生成される（research C3）。MCP も Linux では stdio に自動 fallback する（research C4）。
- staging の毎回再生成は計測で 494 files / 4.3MB のコピー 0.07s、tar+sha256 0.01s（本 repo、WSL 上で計測）であり、warm 起動 3 秒目標に対して無視できる。

## Key Decisions

- **K1: 境界は repo ごとの isolated machine（`--isolated --isolate-network --forward-ssh-agent`）** — ユーザー決定。通常 machine は `/Users` 全体 rw と `mac` による host コマンド実行を持ち、選択的に無効化できない（research R1/R2）。machine 名は `agent-<repo basename を [a-z0-9-] に正規化し先頭20字>-<repo 絶対パス（realpath）の sha256 先頭6桁>`。repo root は `git rev-parse --path-format=absolute --git-common-dir` の dirname とし、`.git/worktree/<branch>` 配下の worktree でも同じ machine を使う。launcher は `~/.local/share/agent-vm/machines/<machine>` に `format=1` と `repo_path=<絶対パス>` の key=value 行を記録する（`list` / `gc` / `restore-git` の入力。フィールド追加は key の追加で行い、未知 key は読み飛ばす）。同一 machine への並行起動（別ターミナルで claude と codex を同時に開く等）で staging 再生成と bootstrap が交錯しないよう、host 側で machine の共有状態に触る区間（手順 2〜6 と、手順 9 の取り込み・検査）をカーネルの `flock(2)` 排他で囲む。macOS 標準に `flock` コマンドが無いため、launcher（bash）が `exec 9>~/.local/share/agent-vm/machines/<machine>.lock` で fd を開き、macOS 標準の perl で `open(my $f, ">&=", 9)`（fdopen による同一 fd の別名。パスを開き直さない）に対し `flock($f, LOCK_EX|LOCK_NB)` を取る。lock 保持中に起動する外部コマンド（`orb`・`rsync`・`git` 等）はすべて `9>&-` を付けて fd 9 を継承させない（常駐する子プロセスが lock を延命しないため）。手順 6 の直後に `exec 9>&-` で解放し、対話セッション（手順 8）は lock を持たずに動く（同じ repo で claude と codex を並行して開けるように）。手順 9 の終了時処理では fd 9 を開き直して同じ方法で取り直す。flock の lock は open file description に属し、同じ description を共有する fd がすべて閉じるまで保持される（flock(2)）ので、perl が終了しても bash が fd 9 を持つ間は保持され、launcher が kill・crash しても OS が自動で解放する。stale lock という状態自体が生じないため、pid 記録や回収手順を持たない（mkdir + pid 方式は回収手順の競合を繰り返し生んだため採らない）。起動時に取れなければ 1 秒ごとに「同じ repo の別セッションが準備中」と 1 行表示して再試行し、60 秒で諦めて終了する（起動しない側に倒れるだけなので安全）。終了時に 60 秒で取れなかった場合は取り込みと検査を省略したことを警告し、`recover: agent-vm sync <repo>`（取り込みと git 面検査を lock 下で行う）を表示する。次回起動時の手順 4・5 でも同じ処理が走るので、省略分は黙って失われない。`repo_path` の値は最初の `=` 以降の残り全部とし、改行を含むパスの repo では launcher が起動を拒否する。
  - 参照: https://docs.orbstack.dev/machines/isolated（`--mount SOURCE[:DEST]`、read-only 指定なし、isolated は `mac` 不可）
  - 参照: `home/dot_local/bin/executable_git-worktree-create`（worktree は repo の `.git/worktree/` 配下）
- **K2: 「読み込み限定」は machine 専用 staging の毎回再生成で実現する** — isolated の `--mount` に ro 指定が無い（research F1）。launcher は起動ごとに、VM から見えない `~/.local/share/agent-vm/build/` 配下の一時ディレクトリに、chezmoi repo root（`.chezmoiroot` の親。`.skills/`・root `package.json` を含む）の `git ls-files -z` が列挙する tracked files を working tree の内容で `rsync --files-from` コピーし、内容 hash（K3）もこの一時ディレクトリで計算する。完成したら mount されている `~/.local/share/agent-vm/staging/<machine>/` の直下へ `mv`（同一ファイルシステム内の rename）で新しい世代ディレクトリとして移し、それ以外の直下エントリを `rm -rf` で消す。host は VM が書ける領域の中にファイル内容を書き込まない（書き込むのは rename 1 回だけで、rename は宛先の symlink を辿らない）ので、VM が staging 内を symlink に差し替えても host 上の別パスへの書き込みには化けない。`rm -rf` は symlink を辿らず unlink するだけなので削除も安全。bootstrap には世代ディレクトリのパスを渡す。staging は machine ごとに分けるので VM 間の書き込み経路にならず、VM が staging を書き換えても次回起動で消える。untracked の秘密ファイルは列挙されないので入らない。VM は staging を直接の chezmoi source にせず、bootstrap.sh が VM ローカルの `~/.local/share/chezmoi` へ `rsync -a --delete --exclude node_modules --exclude .git` してから `chezmoi init -W ~/.local/share/chezmoi --apply` する（`-W` は chezmoi の global flag `--working-tree`、v2.72.2 の `chezmoi help` で確認。コピーには `.git` が無いので初回 init は chezmoi の仕様どおり空の git repo を作る。これは無害な想定内の副作用で、`--exclude .git` により毎回の rsync で消されない）（`run_onchange_install-packages-7b-node-modules.sh.tmpl` の `bun install` が workingTree に書くため、その書き込みを VM ローカルに閉じる）。private-skills は staging に含めず、VM 内 apply が既存の chezmoi external（`home/.chezmoiexternal.toml.tmpl` の `.local/share/private-skills` git-repo）として転送 agent 経由で clone する（配布経路を 1 つにする）。
  - 参照: `home/.chezmoiexternal.toml.tmpl`（private-skills は git-repo external）
  - 参照: `home/.chezmoiscripts/run_after_sync-skills.sh.tmpl`（skills を workingTree の `.skills/` から rsync）
  - 参照: `home/.chezmoiscripts/run_onchange_install-packages-7b-node-modules.sh.tmpl`（workingTree で `bun install`）
- **K3: 下り同期は内容 hash の変化で自動実行** — hash は `v1:` + K2 の build ディレクトリ（staging へ rename する前）内の全ファイルについて「相対パスと内容 sha256」の一覧を `LC_ALL=C` でソートしたものの sha256（`find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256`。macOS の bsdtar には `--sort` が無く、`sha256sum` も標準に無いため、両 OS に標準である `shasum` を使う）。working tree の bytes を hash するので未コミット編集も反映される。VM の `~/.local/state/agent-vm/applied-hash` と一致すれば bootstrap を省略する。`v1:` は hash 方式を変えたとき全 VM が一度だけ再 apply される（安全側）ための版。
- **K4: VM 向け分岐は chezmoi データ `agent_vm` 1 つ、既存 host は無変更で動く** — `home/.chezmoi.toml.tmpl` に `agent_vm = {{ stat "/etc/agent-vm" | not | not }}` を追加する。テンプレート側は必ず `dig "agent_vm" false .` で参照し、`chezmoi init` を再実行していない既存 host の config（キー無し）でも apply が失敗しないようにする。既存 host では `chezmoi init` を再実行するまで config に `agent_vm` キーが無いが、`dig` の既定値 false により VM 向け分岐は無効のままで、これは意図した挙動（host は VM ではない）。`/etc/agent-vm` は cloud-init が作る。marker 方式にするのは、VM 内で手動 `chezmoi init` を再実行してもフラグが保たれるため（init 引数渡しでは失われる）。hostname overlay（`home/dot_codex/private_config.toml.tmpl:10`）は machine 名が repo ごとに変わるため使えない。
  - 参照: `home/.chezmoi.toml.tmpl:8-9`（`only_private` を init 時に導出する既存パターン）
  - 参照: `home/.chezmoiignore:24`（`dig "only_private" false .` のガード付き参照の前例）
- **K5: VM の global mise ツールは軽量セットに絞る（V4 で見直し）** — `home/dot_config/mise/config.toml` を `.tmpl` 化し、`dig "agent_vm" false .` のとき `go` / `rust` ツールチェインと `cargo:` / `go:` backend のツール（similarity-ts, zizmor, octorus, git-sequential-stage）を除外する。根拠: これらは repo ごとの初回待ちで最大のダウンロード・ビルド対象（rust / go ツールチェイン本体と、cargo backend のビルド）で、hooks / skills / agent の動作に不要。repo 固有のツールは repo 自身の mise 設定が入れる。V4 で全セットでも初回待ちが許容範囲と分かれば除外を撤回する。
  - 参照: `home/dot_config/mise/config.toml:6-40`
- **K6: 秘密は host 所有の env ファイルだけを mac 側 `op inject` で解決し、stdin で VM tmpfs に渡す** — ユーザー決定（host 側注入、Service Account なし）。解決対象は `~/.config/agent-vm/env.1password`（chezmoi 管理、全 repo 共通）と `~/.config/agent-vm/repos/<machine>.env.1password`（repo 別、host にのみ存在、`agent-vm env edit` で `$EDITOR` を開く）の 2 つに限る。**repo 内の `.env` / `.env.local` は解決しない**。repo は VM から書けるので、そこに任意の `op://` 参照を書き込まれると host の認証済み `op` が無関係な秘密を解決して VM に渡してしまうため。launcher はまず `op inject` の出力を host 側 bash の変数に受ける（生体認証の待ちはここで済ませる。変数はメモリ上だけで、ディスクにもプロセス引数にも出ない）。その後、組み込みの `printf` で値を `orb -m <m> sh -c 'd=${XDG_RUNTIME_DIR:-/dev/shm}; umask 077; f=$(mktemp "$d/agent-vm.env.XXXXXX"); cat > "$f"; echo "$f"'` の stdin に流し（起動ごとに別名なので、同じ machine で並行起動しても互いのファイルを消さない）、返ってきたパスを起動コマンドに渡す。起動シェルは `set -a; . "$f"; rm -f "$f"` してから exec する。書き込みから読み込みまでの間に launcher が kill されると秘密入りファイルが残るため、書き込み前に同じディレクトリの 60 秒より古い `agent-vm.env.*` を削除する。生体認証の待ちはファイル作成より前に終わっているので、正常な起動ではファイル作成から削除まで `orb` の起動数秒で済み、並行起動の掃除が他の起動の未読ファイルを消すことはない。host のディスク・プロセス引数には現れない。bootstrap は書き込み先が tmpfs であることを `stat -f -c %T` で確認し、tmpfs でなければ失敗する。
  - 参照: `home/dot_shell_common/functions.sh:58-`（`ope` の `op inject` / `op run` の既存形）
  - 参照: `home/dot_env.1password.tmpl`（`op://` 参照ファイルを chezmoi で管理する既存パターン）
- **K7: Claude も Codex も VM ごとに初回ログインし、認証はその VM の中にだけ置く** — ユーザー決定。Claude は未ログインの VM で最初に起動したとき、claude 自身がログイン手順（表示された URL をブラウザで開いて承認）を出すので、launcher は何もしない。認証は VM 内の `~/.claude/.credentials.json` に保存される（research R8）。このファイルは chezmoi の管理外で、`home/dot_claude` に `exact_` 属性が無いので、K3 の再 apply でも消えない（V15 で確認）。ログイン待ちの間も K6 の値は claude の環境変数にあるが、これはセッション全体を通じた K6 の設計どおりの状態で、ログイン待ちが露出を増やすわけではない（Codex の認証確認を注入より前に置くのは、秘密入りの tmpfs ファイルが人の操作を待つ間に残らないようにするためで、Claude でもファイルは exec の前に消えている）。長期 token（`claude setup-token`）を 1Password から毎回注入する案は採らない。理由は (a) 同じ token を全 VM の環境変数に載せると、1 つの VM の侵害で全 repo 分の資格情報が漏れる、(b) Codex で VM ごとのログインを受け入れている以上、Claude だけ手間を省く理由が薄く、手順がそろうほうが分かりやすい、の 2 点。Codex の auth.json を全 VM で共有する案も採らない。理由は (a) 1 VM の侵害で他 repo の VM が使う token を差し替えられる、(b) 更新時に temp 書き込み→rename する実装だと symlink が黙って外れる、の 2 点。代わりに launcher は VM に `~/.codex/auth.json` が無ければ `codex` の起動前に `codex login --device-auth` を実行する（repo ごとに初回 1 回、表示されたコードをブラウザで承認するだけ）。この認証確認は K6 の秘密注入より前に行い、人の操作を待つ間に秘密入りファイルが VM に存在しないようにする（起動シェルは env ファイルを読んだ直後、ほかの処理を挟まずに削除してから exec する）。
  - 参照: `home/dot_codex/private_config.toml.tmpl:7-9`（chezmoi は `~/.codex/config.toml` のみ管理し auth.json に触れない）
- **K8: git の SSH 認証・署名は agent 転送のみで行い、gitconfig は変更しない** — ユーザー決定。非 WSL Linux では `home/dot_gitconfig_gpg_ssh.tmpl` が `program` を設定しないため git 既定の `ssh-keygen` が使われ、`user.signingkey` はリテラル公開鍵（`home/.chezmoidata/user.toml:6`）なので `SSH_AUTH_SOCK` の 1Password agent で署名できる。`allowedSignersFile`（`home/dot_gitconfig.tmpl:19`）は `/home/berlysia/...` だが OrbStack の VM user は mac と同名なので一致する。agent 転送は鍵全体を VM に使わせるため、1Password 側の承認設定（アプリ単位で毎回承認させる設定）を導入ガイドに明記し、V3 で承認粒度を観測する。
  - 参照: `home/dot_gitconfig_gpg_ssh.tmpl:1-10`
- **K9: 上り同期はログを常時 outbox に置き、起動時と終了時に host へ取り込む** — bootstrap.sh が VM の `~/.claude/projects` と `~/.codex/sessions` を `/opt/agent-vm/outbox/{claude-projects,codex-sessions}` への symlink にする（chezmoi 管理外の VM 専用状態なので bootstrap が所有）。ログは書かれた時点で host の `~/.local/share/agent-vm/outbox/<machine>/` に存在する。launcher は起動時（前回の crash・強制終了分の catch-up）と終了時（trap）と `agent-vm sync` で、host の `~/.claude/projects` / `~/.codex/sessions` に取り込む。取り込み先はこの 2 つを launcher 内に固定する。取り込みは rsync ではなく launcher 内の関数で、outbox 内の通常ファイルかつ `*.jsonl` だけを対象に（symlink は無視）、ファイルごとに次の規則で行う。セッションログは追記専用という前提に立ち、その前提が破れたら黙らずに知らせる:
  - host 側に無い → コピー
  - outbox 側が長く、host 側の長さ分の先頭が一致（`cmp -n <host 側 size>`）→ 差分の末尾だけ追記
  - 同じ長さで内容一致 → 何もしない
  - それ以外（outbox 側が短い、または先頭不一致 = 既存行の書き換え・切り詰め）→ host 側を変更せず、ファイルパスと `recover: agent-vm sync --inspect <machine>` を警告として表示する
  mtime 比較は VM と host の時計ずれで追記を取りこぼし、rsync `--append` は既存部分の書き換えを検知しないため、どちらも使わない。host 側の `~/.local/share/agent-vm/ingested/<machine>`（`format=1`、1 行に path・outbox 側 size・host 側 size。VM から書ける outbox の外に置く）を持ち、読めない・形式が不正な行は「記録なし」として判定に入る。両側の size がともに前回記録と同じファイルは判定を省く（host 側の削除・編集も size の変化で再判定に入る）。size を保ったままの outbox 側の書き換えは判定されないが、host 側には一切伝わらない（host 側は先頭一致を確かめた追記でしか変わらない）ので、host 側の完全性は保たれる。検知されないのはその書き換えの存在だけで、これは VM が書いたログの内容をもともと信頼しない前提と同じ扱いとする。jsonl 以外の付随ファイル（V12 で有無を確認）は意図的に取り込まない。repo を host と同一パスで mount するので Claude の project dir 名（cwd 由来）が host と一致し、`claude --resume` と `home/.chezmoiscripts/run_after_distill-insights.sh.tmpl` がそのまま拾う。
- **K10: 既定で経由する（opt-out）、opt-out 設定は host 側のみ、OrbStack 不調時は fail closed** — `darwin.sh` に `claude()` / `codex()` を定義し、cwd が git repo 内、`AGENT_VM` が `off` でない、repo root が `~/.config/agent-vm/config` の exclude に該当しない、の 3 条件で `agent-vm <tool> "$@"` に回す。それ以外は `command claude`。config の書式は 1 行 1 絶対パス、`#` 以降はコメント、比較は realpath 化した repo root に対するディレクトリ境界での prefix 一致。opt-out を repo 内に置かないのは、VM から書ける場所で隔離を解除できないようにするため。`orb` が無い、または 3 秒の時間制限付き `orb status` が失敗したときは（macOS 標準に `timeout` コマンドが無いため、標準の perl で `perl -e 'alarm shift; exec @ARGV' 3 orb status` とする） host で起動せず、原因と `AGENT_VM=off claude` の案内を 1 行出して終了する（隔離の黙った迂回と、無応答時のハングの両方を避ける）。VM セッション中はターミナルタイトルを `[vm:<machine>] <repo>` にし、終了時に戻す（host と VM のどちらで操作しているかを取り違えないため。R8 の緩和も兼ねる）。
  - 参照: `home/dot_shell_common/init.sh:57`（darwin.sh は darwin でのみ読まれる）
- **K11: host 側ファイルは darwin のみに deploy** — `agent-vm` launcher と `~/.config/agent-vm/` は `.chezmoiignore` で darwin 以外を除外する。cloud-init と bootstrap.sh は chezmoi の deploy 対象にせず repo root 配下（`agent-vm/`）に置く。launcher は実行のたびに `git -C "$(chezmoi source-path)" rev-parse --show-toplevel` で workingTree を解決し（render 時に固定すると sourceDir 変更で古くなるため）、そこから cloud-init を読み、K2 の staging もこのパスから作る。解決に失敗したら K10 と同じく fail closed。bootstrap.sh は staging 経由で VM に届く。
  - 参照: `home/.chezmoiignore:28-32`（OS 別除外の既存パターン）
- **K12: OrbStack を Homebrew cask で宣言管理** — `home/.chezmoidata/packages.yaml` の `darwin.casks` に `orbstack` を追加する。
  - 参照: `home/.chezmoidata/packages.yaml:37`
- **K13: repo 内の「host で実行されるが `git diff` に出ない面」を検査する** — repo は rw mount なので、VM は `.git/hooks/*` や `.git/config`（`core.hooksPath`, `core.fsmonitor`, `core.sshCommand` 等）を書き換えられ、それは host で git を使ったときに host 権限で実行される。launcher は起動時にスナップショットを取り（`~/.local/share/agent-vm/snapshots/<machine>/`）、終了時と次回起動時に比較する。対象: `.git/hooks/` のファイル一覧と内容 hash、`.git/config` と `.git/worktrees/*/config.worktree` の実行系キー（`core.hooksPath|fsmonitor|sshCommand|pager|editor|askPass`, `sequence.editor`, `filter.*`, `diff.*.textconv`, `diff.external`, `merge.*.driver`, `alias.*`, `include.path`, `includeIf.*`, `credential.*`, `gpg.program`, `gpg.*.program`）、`.git/info/attributes`、untracked の `.envrc` / `mise.local.toml` / `.mise.local.toml`。hooks は `realpath(.git/hooks)` と、`core.hooksPath` が設定されていればその解決先ディレクトリも中身ごと hash する（symlink 差し替えやリダイレクト先の中身の改変を拾うため）。スナップショットは `format=1` と監視対象セットの版を持つ。版が上がったときも、前の版から監視していた項目は通常どおり比較し（差分があれば改変として表示し、その項目の baseline は更新しない）、新しい版で増えた項目だけを初回値として baseline に加える（版上げの機会に既存の改変が正規化されないようにするため）。baseline の更新は比較で差分が無かった項目に限る。K13 の処理が V4 の時間予算を超えた場合は、監視範囲を削らず hash / 走査の実装側を最適化する。差分があれば差分内容と `recover:` 行（`agent-vm restore-git <repo>`）を表示し、終了コードで知らせる。`restore-git` は `machines/<m>` の `repo_path` と引数の repo の realpath が一致するスナップショットだけを対象にし、差分を表示して確認を取ってから戻す。
- **K14: machine の一覧と掃除** — `agent-vm list`（machine 名・repo path・repo 存在有無）、`agent-vm gc`（repo path が存在しない machine を列挙し、確認後に `orb delete` と staging / outbox / snapshots / machines の該当エントリを削除）、`agent-vm rm [repo]`（repo が存在するうちに、その machine を作り直したい・不要になったときの明示削除。`gc` は repo 消失が契機なので対象が重ならない）。repo の rename / move は新しい machine として扱い、旧 machine は `gc` で消える。exclude は rename 後に効かなくなるが、その場合は VM 経由（安全側）に倒れる。repo 別の秘密参照ファイル `repos/<machine>.env.1password` は host で人が書いた状態なので `gc` でも削除しない。repo path が存在しない machine に属する env ファイルは孤立として `list` / `gc` に表示し、その repo で起動したときに自分の env ファイルが無く孤立ファイルがあれば「移動した repo なら `agent-vm env adopt <旧 machine>`」と 1 行知らせる（`env adopt` は孤立ファイルを現 machine 名へ rename する）。孤立の判定は「記録された repo path が存在しない」ことだけで、旧 repo と現 repo が同じプロジェクトかは確かめない。引き継ぐかどうかは人が判断し、導入ガイドにこの前提を明記する。
- **K16: VM の claude は host と同じ公式 installer で入れ、bootstrap が未導入時だけ実行する** — host では claude は chezmoi の管理外で公式 installer により入っており（research C10）、VM も同じ経路にそろえる。bootstrap.sh は非対話で動きシェルの profile を読まないので、判定の前に installer の導入先 `~/.local/bin` を自分で PATH に加えたうえで、`claude` が PATH に無いときだけ `curl -fsSL https://claude.ai/install.sh | bash` を実行し、以降は claude 自身の更新に任せる。導入が失敗すると bootstrap は `set -euo pipefail` によりその場で止まり applied-hash を書かないので、dotfiles に変更が無くても次回起動で bootstrap ごと再試行される（V16 で確認）。codex は既存どおり mise（`npm:@openai/codex`）で入る。mise で claude を入れる案は、host と導入経路が分かれ、host の claude と二重管理になるため採らない。installer を curl で取得する方式は、repo が mise の導入で既に採っている方式（`run_onchange_install-packages-1-linux.sh.tmpl` の `curl https://mise.run | sh`）と同等の信頼モデルとする。
  - 参照: `home/.chezmoiscripts/run_onchange_install-packages-1-linux.sh.tmpl:11-17`（公式 installer を curl で実行する既存の前例）
- **K15: 初回待ちは明示の `agent-vm prewarm` で前倒しする（自動 prewarm はしない）** — cd のたびに VM を作る案は、agent を使わない repo にも数 GB の machine を作るため採らない。launcher は初回作成時に段階（machine 作成 / dotfiles の適用）を 1 行ずつ表示する。bootstrap 内の claude 導入・chezmoi apply・mise の各処理は、それぞれの出力がそのまま流れる。

## Risks

- **R1: OrbStack 挙動は WSL の本セッションで検証不能** → 依存挙動を V1-V17 として plan のテスト計画で mac 実機検証に渡す。launcher のロジック（名前導出・引数組立・opt-out 判定・hash 比較・取り込みフィルタ・git 面検査）は `orb` / `op` を stub にした smoke test で Linux 上で検証する。
- **R2: 1Password agent と OrbStack 転送の相性（orbstack/orbstack#185）** → V3 で検証。失敗時は署名だけ mac 側で行う運用に落ちる。gitconfig を変えないので、失敗は VM 内の署名エラーとして顕在化し、黙って未署名にはならない。
- **R3: agent 転送で VM は承認後に全鍵で署名・認証できる** → K8 の 1Password 承認設定を導入ガイドに記載し、V3 で承認粒度を観測して結果を ADR に記録する。
- **R4: 各 VM に Claude / Codex の認証ファイルが残る** → 侵害された VM はその VM の認証を持ち出せる。VM ごとに別の認証なので影響はその 1 つに限られる。失効手順（claude.ai / ChatGPT のセッション管理からの取り消しと `agent-vm rm`）を導入ガイドに記載する。
- **R5: 初回プロビジョニングの待ち時間** → K5・K15。V4 で計測。
- **R6: VM 内 default user は passwordless sudo** → isolated machine の外には及ばない（research F2）。VM 内 root が書ける host パスは repo・staging/<m>・outbox/<m> で、いずれも元々 rw で渡している範囲と同じ。
- **R7: outbox 取り込みは VM 由来のデータを host に書く** → 通常ファイルの jsonl 以外と symlink を除外し、取り込み先は 2 箇所に固定し、既存の host 側ファイルは先頭一致を確かめた追記しかしない（書き換え・切り詰めは警告して取り込まない）。取り込んだ jsonl は insight 蒸留の入力になるが、蒸留結果の skills / rules への昇格は `/insight-digest` による人間判断を経る。
- **R8: K13 は事後検知であり、VM セッション実行中に host で同じ repo の git を使うと検査前に実行されうる** → 導入ガイドに「VM セッション中はその repo で host の git を使わない」と明記する。完全な防止には `.git` を mount から外す必要があるが、VM 内で commit できなくなりオーダー（repo で作業する）を満たさないため採らない。この運用ルールはツールで吸収しきれないエルゴノミクス上の残余コストであり、K10 のターミナルタイトル表示で取り違えを減らす。
- **R9: Codex 内蔵 sandbox（Landlock + seccomp）が OrbStack の kernel で動かない可能性（research R9）** → V9 で確認。動かない場合は VM 境界を sandbox とみなし、VM 内の Codex だけ `sandbox_mode` を緩める設定を K4 のフラグで分岐する別 plan とする。

## Phase 1 で意図的に提供しない体験

### egress の許可リスト制御

- **代替経路確認**: `--isolate-network`（K1）で host・他 machine への到達は遮断済み。internet 全体への egress 制限は OrbStack に機構が無く、Anthropic 公式 devcontainer の `init-firewall.sh` 相当を VM 内に入れる必要がある（research R10）。
- **非提供対象**: VM から internet への宛先制限。
- **将来の予定**: 運用で必要が見えたら VM 内 nftables を bootstrap に追加する別 plan とする。

### mac クリップボード画像の貼り付け

- **代替経路確認**: isolated machine は `mac` コマンドを使えない（research F2）。画像は repo 内に保存してパスで渡せば VM から読める（repo は同一パス mount）。
- **非提供対象**: Claude Code の画像ペースト。
- **将来の予定**: 恒久的に非提供（隔離と引き換え）。

### 1Password 以外の host 資格情報ストア

- **代替経路確認**: `gh` は `GH_TOKEN` を `op://` 参照で `env.1password` に書けば K6 の経路で渡る。git の push は K8 の agent 転送で通る。
- **非提供対象**: macOS Keychain・各種クラウド CLI の資格情報ファイルの VM への受け渡し。
- **将来の予定**: 必要な資格情報は 1Password に寄せて K6 で渡す方針とし、個別ストア連携は提供しない。

## ISO 25010 次元選択

- **使用性（運用操作性）**: 支配軸。打鍵が変わらないこと、warm 起動の launcher 追加時間 3 秒以内、下り同期の自動化、失敗時の 1 行案内。
- **セキュリティ（機密性・完全性）**: host 原本への書き込み不可、VM 間の書き込み経路なし、VM が選べる `op://` 参照なし、秘密がディスク・引数に残らない、git 面改変の検知。
- **機能適合性（機能正確性）**: machine 名導出、worktree での同一 machine 解決、ログ取り込みのフィルタと追記反映。
- **移植性（設置性）**: darwin 以外に deploy されないこと、`agent_vm` キー無しの既存 config で apply が通ること。
- **性能効率（時間効率）**: warm 起動 3 秒目標の計測（V4）に限定する。
- **対象外**: 保守性の独立評価（shellcheck が既存 CI で走るため個別特性として立てない）。

## mac 実機検証項目（plan-N のテスト計画から参照）

- V1: isolated machine の mount 先への VM 内書き込みが host に反映されること（= staging 方式が必要であることの確認）
- V2: VM user の UID と、mount 上ファイルの所有者表示
- V3: `--forward-ssh-agent` + 1Password agent で `ssh -T git@github.com` と `git commit -S` が成功すること、承認プロンプトの粒度
- V4: 新規 machine → 初回 claude 起動までの所要時間（全 mise セット時と K5 軽量セット時）、warm 起動の launcher 追加時間 ≤ 3 秒（K2 staging 再生成・K9 取り込み・K13 検査・health check を含む全体で測る）
- V5: `--isolate-network` 下で claude / codex の API 疎通、`host.orb.internal` 不達
- V6: `orb -m <m> …` に TTY が付き claude の対話 UI が動くこと
- V7: 未ログインの VM で claude を起動するとログイン手順が表示され、mac のブラウザで URL を開いて承認し、表示されたコードを VM 側に貼り付ける経路でログインできること（VM のポートを host に開けずに済むこと）。2 回目以降はログインなしで起動すること
- V8: VM 内のサーバーに mac の `localhost:<port>` / `<machine>.orb.local` で到達できるか（dev server プレビュー）
- V9: Codex 内蔵 sandbox が VM 内で動くこと
- V10: `orb -m <m> sh -c` 実行時の `XDG_RUNTIME_DIR` の有無と、書き込み先が tmpfs であること
- V11: 同一ターミナルで連続起動したときの `op inject` の生体認証プロンプト頻度
- V12: `~/.codex/sessions` が jsonl のみで構成されるか（付随ファイルの有無）
- V13: 非対話の `orb -m <m> bash bootstrap.sh` 実行時に `SSH_AUTH_SOCK` が有効で、private-skills external の SSH clone が通ること
- V15: dotfiles を変更して bootstrap の再 apply が走った後も、VM の `~/.claude/.credentials.json` と `~/.codex/auth.json` が残り、再ログインが要らないこと
- V16: 新規 machine の初回 bootstrap で claude が非対話に導入され、`bash -lc` の起動シェルから見つかること。dotfiles を変えて 2 回目の bootstrap を走らせても installer が再実行されず、claude の版が変わらないこと。導入を失敗させた（ネットワーク遮断）場合は bootstrap が非 0 で終わり、次回起動で再試行されること
- V17: cloud-init が書く GitHub の host key が公式の fingerprint と一致し、bootstrap の SSH clone が確認なしで通ること
- V14: macOS の bash 3.2 + 標準 perl で、fd 9 の flock が perl 終了後も保持され、launcher の `kill -9` で解放されること（Linux 上の smoke test でも同じ手順を検証する）

## Resolved Questions（ユーザー回答）

- K10 の既定 VM 経由（opt-out）: ユーザー確認済み（OK）。
- K7 の Codex 認証: VM ごとの初回 device 認証をユーザーが選択（API キー方式は採らない）。
- K7 の Claude 認証: Codex と同じく VM ごとの初回ログインにする（長期 token の注入はやめる）とユーザーが決定。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘: 共有 staging は rw で VM 間汚染経路になり、VM 内 `chezmoi apply` の `bun install` が staging に node_modules を書く。`git ls-files -s` hash は未コミット編集を反映せず、`--ignore-existing` は追記された jsonl を取りこぼす。private-skills は chezmoi external と二重経路。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘: K5 の根拠が計測なし。Codex 内蔵 sandbox のネスト動作が V 項目に無い。K10 の既定 opt-out は推論による決定なので承認時に明示すべき。

### decision-quality-reviewer
- verdict: needs-work
- 主指摘: 支配軸がエルゴノミクスなのに warm 起動の目標値が無い。`op` の生体認証が毎回の割り込みになりうる点と、OrbStack daemon 無応答時のハングが未検討。

### greenfield-perspective-reviewer
- verdict: needs-work
- 主指摘: 秘密注入の頻度、初回待ちが手動 prewarm 頼み、ログ回収が exit trap 依存で crash 時に欠落しうる。「1Password等」の範囲を明記すべき。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: staging root を repo root に固定すべき（`.skills/`・root `package.json` を含める）。VM 側 symlink の作成責任者が未定義。共有 staging は VM 間の書き込み経路。

### security-vulnerability-analyzer
- verdict: blocker
- 主指摘: VM が書ける repo `.env` の `op://` 参照を host が解決すると任意の秘密を持ち出せる。共有 staging は VM 間 RCE 経路。rw mount された `.git/hooks`・`.git/config` は host の git 実行時に走る（`git diff` に出ない）。共有 codex-auth は 1 VM の侵害で全 VM の token を差し替えられる。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: `agent_vm` キーを持たない既存 host の config で apply が失敗しうる（要 `dig` ガード）。repo の rename/move で machine が孤児化し、exclude の書式が未定義。Codex sessions の jsonl 以外のファイルが未確認。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: needs-work
- 主指摘: `chezmoi init -W` は存在しないと指摘（→ `chezmoi help` で global flag `-W, --working-tree` の存在を確認、計器側の誤りとして不採用）。`.git` の無い source での init は `git init` を伴う。同一 machine への並行起動に排他が無い。bootstrap 時の非対話 exec で `SSH_AUTH_SOCK` が有効かの V 項目が無い。

### scope-justification-reviewer
- verdict: pass
- 主指摘: K13/K15 は根拠十分。K14 の `rm` だけ根拠行が無い。

### decision-quality-reviewer
- verdict: needs-work
- 主指摘: K9/K13 の毎回の処理が warm 起動 3 秒目標の計測対象に入っていない。R8 の運用ルールはエルゴノミクス上の残余コストとして明記すべき。

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: Round 1 は解消または明示的トレードオフ化済み。VM 内か host かを示す表示が無い点は判断事項。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: `~/.local/bin` に置かれる launcher が chezmoi workingTree を実行時に解決する方法が未定義。解決失敗時も fail closed にすべき。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: Round 1 の blocker は解消（K13 は検知のみで R8 に残余として明記済み）。staging 再生成と bootstrap の排他が無い。`core.hooksPath` の向き先や symlink 化した hooks の中身を hash していない。`restore-git` の repo への結び付けが未定義。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: `machines/<m>` と snapshot に形式版が無い。`rsync --update` は VM と host の時計ずれで追記を黙って取りこぼしうる。

<!-- auto-review: verdict=blocker; hash=5bea8d371fd3066135ee0a39d752ef676ed548b1a0da6179e00c74178df3819c; design-hash=36f65417bdedfa63fdc1db3ff5b05c4b51764ccdd9c0b38376514c0f683bcfa6; round=1; at=2026-09-28T13:42:54.225Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=37; excluded=0; at=2026-09-28T13:43:20.623Z -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: needs-work
- 主指摘: Round 2 は解消。stale lock の回収に TOCTOU がある（2 プロセスが同じ死んだ pid を見て、後から来た側が先に取った側の lock を消しうる）。

### decision-quality-reviewer
- verdict: pass
- 主指摘: V4・R8 は解消。K13 のコスト超過時に網羅範囲を黙って削らないことを注記するとよい。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: workingTree の実行時解決と fail closed で解消。新規の境界問題なし。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: 版上げ時の再ベースラインが既存の改変を正規化しうる。`--append` は既存部分の書き換えを検知しない。手順 7〜9（env ファイル・終了時処理）が lock の外で並行起動と競合する。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: `--append` は先頭一致を検証せず、切り詰め・書き換えを黙って無視する。再ベースラインの範囲（新規キーのみか全体か）が曖昧。

### scope-justification-reviewer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### greenfield-perspective-reviewer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=1402f23d87cafc8415000e0e16c9188940c2c23c786f04f1316d64e9a04499ba; design-hash=70f2f2ac69418daa4504a90b397b1ec2a9979589453398318032b42830ed6a58; round=2; at=2026-09-28T13:48:53.919Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=21; excluded=0; at=2026-09-28T13:48:53.935Z -->

## Reviewer Outputs (Round 4)

### logic-validator
- verdict: needs-work
- 主指摘: rename 方式の回収は、遅れて来たプロセスの `mv` が新しく取られた生きた lock を動かしてしまい、二重保持が再発する。`.ingested` が outbox 側の size だけを鍵にしており、host 側の削除・編集を修復しない。retry に上限が無い。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: 起動ごとに別名の env ファイルは、crash 時に tmpfs に溜まり続ける。size が変わらない書き換えは比較されず、警告も出ない。

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: Round 3 は解消。`.ingested` にも形式版があるとよい。

### decision-quality-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### scope-justification-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### greenfield-perspective-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=f9726e04b5faca6c2ad47cacf0f465fe2c740e6f245be9b7f137792a71bc6ae6; design-hash=9c36433b67df72365fbe9e330b491bd5401bf37ce841c53cb2fe2d93a15c8e14; round=3; at=2026-09-28T13:52:26.729Z; reviewers=logic-validator+decision-quality-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=7; excluded=0; at=2026-09-28T13:52:26.745Z -->

## Reviewer Outputs (Round 5)

### logic-validator
- verdict: needs-work
- 主指摘: fd 9 を閉じないまま `orb exec` で対話セッションに入ると、lock がセッション中ずっと保持され、同じ repo での並行起動が 60 秒後に失敗する。終了時処理での lock の再取得と、取れなかったときの扱いが未定義。perl の fd 受け渡し形式を固定すべき。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: 60 秒の掃除は lock の外で動くため、`op` の生体認証待ちが長いと別の起動が未読の env ファイルを消しうる。`.ingested` は VM が書ける outbox 内にあり、信頼できない状態として扱う必要がある。

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### decision-quality-reviewer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### scope-justification-reviewer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### greenfield-perspective-reviewer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=c685cee360dcc11aa42b2d83e8c8adc323c0371cbf66e64ce361e90457b904e2; design-hash=41b521c7f7033c8ff628e0d20dc62b211ebeff202076a961bec409df1ca47e33; round=4; at=2026-09-28T13:59:13.381Z; reviewers=logic-validator+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=6; excluded=0; at=2026-09-28T13:59:13.398Z -->

## Reviewer Outputs (Round 6)

### logic-validator
- verdict: pass
- 主指摘: Round 5 は解消し、plan-1 とも整合。K3 の「staging 内」は build ディレクトリの誤記（反映済み）。

### security-vulnerability-analyzer
- verdict: needs-work（本人が minor・non-blocking と明記）
- 主指摘: Round 5 は解消。Codex の device 認証待ちと env ファイル削除の順序を明記すべき（plan-1 は認証確認が注入より先で既に安全、spec に明記して反映済み）。`env adopt` が同一プロジェクトかを確かめない前提を明記すべき（反映済み）。

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### decision-quality-reviewer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### scope-justification-reviewer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### greenfield-perspective-reviewer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=1b918f4ea5c80a848da305b7a996a5fc50a0691146e2d1448a74ea65848f0248; design-hash=f5904fb14ea73eed847a992d4604a84333035ae124da399683ba85337ea45716; round=5; at=2026-09-28T14:06:27.701Z; reviewers=logic-validator+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=5; excluded=0; at=2026-09-28T14:06:27.719Z -->

## Reviewer Outputs (Round 7)

### logic-validator
- verdict: pass
- 主指摘: K7・R4・V7・Experience Delta に旧 token 方式の残りや矛盾なし。K6 との順序の記述も Codex に限定され plan-1 と整合。

### scope-justification-reviewer
- verdict: pass
- 主指摘: 部品を 1 つ減らす変更で、根拠（被害範囲・Codex との一貫性）が具体的。

### decision-quality-reviewer
- verdict: pass
- 主指摘: この部分判断ではユーザーが手間より安全と一貫性を明示的に選んでおり、支配軸のずれではない。Experience Delta も手間を隠していない。

### greenfield-perspective-reviewer
- verdict: needs-work（1 件、不採用）
- 主指摘: ログイン待ちの間 K6 の値が環境変数にあるので、Codex と同様に注入前にログインさせるべき。→ 不採用: K6 の値はログイン後もセッション全体で環境変数にあり、待ち時間で露出は増えない。Codex で確認を先にするのは tmpfs ファイルを待ち時間中に残さないためで、Claude もファイルは exec 前に消える。誤読を防ぐため K7 にこの説明を追記。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: 境界の問題なし。`.credentials.json` が再 apply で消えないことを明記するとよい（K7 に追記）。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: VM 内のログインがコード貼り付け経路で済むか確認すべき（V7 に追記）。失効の本筋はセッション取り消しで、R4 はそれを記載済み。

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: `home/dot_claude` に `exact_` が無く `.credentials.json` は再 apply で消えないが、専用の確認項目を足すべき（V15 を追加）。

<!-- auto-review: verdict=pass; hash=38b06a1ecf916f3e230bbc5c3985ce0f516438f7b4a7950d29c58ab34ab06f8e; design-hash=5d274f4d82f7d52f5db3cf0613b38b4cde75c6d247504100bbd3dabc81e25148; round=6; at=2026-09-28T14:42:44.935Z; reviewers=logic-validator+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=3; excluded=0; at=2026-09-28T14:42:44.950Z -->

## Reviewer Outputs (Round 8)

### logic-validator
- verdict: needs-work（minor、反映済み）
- 主指摘: K16 の claude 導入が責務・Architecture 図の手順 6・K15 の進捗段階に反映されていない。非対話 shell の PATH で判定すると毎回再導入しうる。→ 3 箇所に反映、K16 に「判定前に `~/.local/bin` を PATH に加える」を明記。

### scope-justification-reviewer
- verdict: pass（1 件の根拠補足、反映済み）
- 主指摘: K16 は根拠十分。cloud-init の GitHub host key 固定に理由が無い → 責務に insteadOf と private-skills clone を根拠として追記。

### decision-quality-reviewer
- verdict: pass
- 主指摘: host と導入経路をそろえる判断は支配軸に整合。版の固定より host との一致を優先していることも既存の前例と同じ。

### greenfield-perspective-reviewer
- verdict: needs-work（反映済み）
- 主指摘: claude 導入の検証項目が無い → V16 を追加。導入失敗時に次の dotfiles 変更まで入らない → 実際は `set -euo pipefail` で applied-hash が書かれず次回起動で再試行されることを K16 に明記。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: bootstrap の責務一覧に K16 を足し、cloud-init / chezmoi apply / bootstrap の導入経路の分担原則を明文化すべき → 責務に「導入経路の分担」を追記。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: installer は隔離された VM 内で走り、既存の mise 導入と同じ信頼モデル。host key の固定は初回接続の確認を不要にする正味の改善。

### data-contract-evolution-evaluator
- verdict: needs-work（反映済み）
- 主指摘: 非対話 bootstrap の PATH に `~/.local/bin` が無いと毎回再導入して自己更新後の版を上書きしうる → K16 に PATH の追加を明記、V16 に 2 回目で再導入されないことを追加。

<!-- auto-review: verdict=pass; hash=95a0fa3a0ffb18b339e4336bd35d1744ff2966373282db17c2b43f395f49a2b9; design-hash=897163654065344879ae9d4abeae964317a12c5f0ed49bb16a3b29b1168b69b4; round=7; at=2026-09-28T16:03:32.323Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=3; excluded=1; at=2026-09-28T16:03:32.337Z -->

<!-- auto-review: verdict=pass; hash=34a1ddc3b9669296fa9387fc587f25c25cffe7efcb918cbc6fc5ab05da33a858; design-hash=f9988a2c37dfbb39f82687511f7649fd3121da3c732d25c1102e1870ad46d102; round=8; at=2026-09-28T16:19:10.416Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=7; excluded=0; at=2026-09-28T16:19:10.432Z -->
