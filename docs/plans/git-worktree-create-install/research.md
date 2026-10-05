# Research: git-worktree-create が依存のインストールなどの付随事項を扱う

## オーダー

> git-create-worktree が依存のインストールなど付随事項をいい感じにやるようにしたい、ないしは推奨するようにしたい

対象は `git-worktree-create`（`home/dot_local/bin/executable_git-worktree-create`）。オーダーは「自動で行う」を第一に、「推奨を出す」を代替として挙げている。

## 現状

- スクリプトは worktree を作り、agent-vm 連携（`node_modules` の差し替え）を行い、`cd` の案内を出して終わる（`executable_git-worktree-create:94-130`）。依存のインストールには触れない。
- 引数は `$1` をそのままブランチ名にする。オプションは `--help` / `-h` / `help` だけである（同 `:57-65`）。
- 付随処理の失敗は作成を失敗させない。`nm_status=0; cmd || nm_status=$?` で受けて、警告を 1 行出す（同 `:113-129`）。
- テストは `tests/git-worktree-create/run.sh`。`stub <command> <status>` で PATH の先頭に偽のコマンドを置き、引数を 1 行ずつ log に書く（同 `:48-59`）。現行の fixture はすべて `package.json` を持たない空コミットの repo である。
- CI は ubuntu と macOS で `/bin/bash tests/git-worktree-create/run.sh` を実行する。macOS の `/bin/bash` は 3.2 である（`.github/workflows/ci-git-worktree-cleanup.yml:41-46`）。
- 呼び出し側: `/create-worktree`（`home/dot_claude/commands/create-worktree.md:34-41`）、`/issue-pr`（`home/dot_claude/commands/issue-pr.md:14`）、グローバル CLAUDE.md の Key Commands、`docs/agent-vm.md:101`。

## 設計を縛る事実

### F1: install コマンドはすでに自動承認されている

`permission-auto-approve.ts:132-133` は `^(npm|pnpm|yarn|bun)\s+(install|add|remove|ci)\b` を「Package installation (safe in dev context)」として自動承認する。`git-worktree-create` も `:172-173` で自動承認される。
したがって、`git-worktree-create` の中で install を実行しても、Claude が承認なしに実行できる操作の範囲は広がらない。

### F2: agent-vm の VM では、差し替えが済むまで install してはいけない

ADR-0022 の Consequences: 「VM で直接 add した worktree でそのまま install すると、host の worktree に linux 用のパッケージが入る」。
現行スクリプトの警告も、`attach` が失敗したとき「do not install there until this succeeds」と書いている（`executable_git-worktree-create:118-120`）。
VM の中でヘルパー `agent-vm-node-modules` が無い場合も、`node_modules` は host と共有されたままである（`docs/agent-vm.md` の表「the helper is missing」）。

host 側の install は host の `node_modules` に入る。VM の mount は VM の中だけで有効なので、host の install と VM の install は互いに影響しない（ADR-0022 Consequences「両側が独立して動く」）。

### F3: ADR-0022 は「launcher が install を自動で実行する」を却下している

理由は「PM の判定と lifecycle スクリプトの方針は repo ごとに違い、agent の作業と競合する」。launcher は起動のたびに、既存の全 worktree を対象にする。
worktree の作成直後は事情が違う。作ったばかりの worktree は 1 つで、その中で作業している agent はいない。`node_modules` も必ず空である。「agent の作業と競合する」は当てはまらない。
「PM の判定が repo ごとに違う」は当てはまる。判定が一意に決まらないときは実行しない、という扱いが要る。

### F4: PM の判定規約と、この repo の install の形

- グローバル CLAUDE.md: 「package manager はプロジェクトの設定（lockfile / `packageManager` フィールド）に従う」。
- `completion-gate.ts:94-104` は lockfile から PM を判定する（bun → pnpm → yarn → npm の順、無ければ pnpm）。コメントに「Mismatched PMs (e.g. running `pnpm` in a bun workspace) trigger destructive deps-status-check behavior」とある。PM を取り違えると実害がある。
- この repo 自身は `bun install --frozen-lockfile` で root の依存を入れる（`run_after_10-install-root-deps.sh.tmpl:54`）。lockfile を書き換えない形である。

### F5: スクリプトは jq に依存していない

`executable_git-worktree-create` が呼ぶ外部コマンドは git、dirname、mkdir と agent-vm 系だけである。`packageManager` フィールドを読むなら、bash と grep / sed で足りる形にする。

## 未確認のこと

- 「など付随事項」のうち、依存のインストール以外に何が要るかは、コードからは決まらない。候補は `mise trust`（新しいパスの `.mise.toml` は未信頼になる。`scripts/lint-shell.sh:115` に trust error への言及がある）と、gitignore されたローカルファイル（`.env` など）の持ち込みである。どちらも、worktree で実際に困った事例をこの調査では観測していない。
- corepack が PM の初回ダウンロードで確認を求めるかどうかは、環境の設定による。実機では確かめていない。
- 依存の多い repo で install に何秒かかるかは repo による。計測していない。
