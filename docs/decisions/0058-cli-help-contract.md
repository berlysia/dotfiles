# ADR-0058: 独自コマンドの --help の契約を決め、全コマンドを列挙するテストで守る

## Status

accepted (2026-10-29)

## Context

2026-10-29、利用者は「独自コマンドたちにはすべて --help があるようにしてください」と求めた。範囲は、利用者の回答で次の 2 つに決まった。

- すべての独自コマンドで、`cmd --help` と `cmd -h` が usage を出して終わる
- `<sub> --help` が今は本体を動かすコマンド（delegation、agent-vm、workflow-cli）では、サブコマンドの位置でも help を出して止まる

対象は `home/dot_local/bin/executable_*` の 24 本と `home/dot_shell_common/executable_doctor` である。調べると、次のことが分かった。

- 8 本は最上位の `--help` を持たず、usage を stderr に出して 0 以外で終わるか、`--help` を引数の値として扱っていた
- 次のコマンドでは、`--help` で副作用が出た
  - `claude-rc-sync --help` は全体の同期に進み、systemd の unit を有効化・停止する
  - `agent-vm prewarm --help` は VM を用意し、`agent-vm sync --help` は outbox を取り込む
  - `delegation review --help` は台帳に行を足す
  - `workflow-cli round plan.md --help` は文書に骨格を挿入する
- 値を取るフラグがある。例は `agent-vm fetch-browsers --from-apply <working tree>` と `workflow-cli stamp --verdict <v>` である。値の位置の `--help` を help と見なすと、渡したはずの値が使われない
- コマンドは bash、POSIX sh、node、bun に分かれ、引数の解析の形もコマンドごとに違う

## Decision

### 契約

対象のすべてのコマンドは、次を守る。

- `--help` と `-h` で、usage を stdout に出し、exit 0 で終わる。stderr には何も出さない
- help の分岐は、lock、ファイルの書き込み、ネットワーク、systemctl、VM の起動、stdin の読み取り、設定ファイルの存在確認より前で行う。workflow-cli は `resolveCliDeps` より前で分岐するので、Claude Code のセッションの外でも help が出る
- usage には、用途 1 行、使い方（サブコマンドと主なオプション）、意味のある終了コードを書く。サブコマンドの位置の help も、コマンド全体の usage を出す
- 未知の引数や引数不足のときの stderr と終了コードは変えない

### help と見なす位置

値の位置にある `--help` と `-h` は help と見なさない。位置の決め方は 2 通りある。

- 自前の引数解析が値の位置を知っている CLI（workflow-cli と delegation）は、その解析が値として消費しない位置なら、どこにあっても help と見なす。`workflow-cli round plan.md --help` も help になる
- それ以外の CLI は、最初の引数だけを調べる。サブコマンドを持つ agent-vm は、サブコマンド名の直後も調べる。`env` と `golden` は 2 語目のサブコマンドの直後も調べる

次の形は help と見なさない。

- agent-vm で、サブコマンドの 2 語目（`env` と `golden` は 3 語目）より後ろにある `--help`
- `agent-vm claude --help` と `agent-vm codex --help`。VM の中の claude と codex に `--help` を渡す今の動きを保つ

次の 5 本は、すでに任意の位置の `--help` を help と見なしているので変えない。

- ask-grokbot
- git-worktree-create、git-worktree-cleanup
- dotfiles-feedback
- workflow-band-preview

### textlint-global

`textlint-global --help` は、wrapper 自身の usage（`--text`、`-`、`--stdin-filename` など）を先に出す。runtime があれば、続けて textlint 自身の help を出す。runtime が無くても exit 0 で終わり、runtime の警告は出さない。

### 全コマンドを列挙するテスト

`tests/heavy/cli-help.test.mjs` が、契約を全コマンドについて確かめる。CI は `test:heavy` を実行するので、このテストも CI に入る。

- テストは `home/dot_local/bin/executable_*` の glob と、名前ごとの表を突き合わせる。表は、起動方法と stdout に含むべき語か、除外とその理由を持つ。glob にあって表に無い名前と、表にあって glob に無い名前は、名前を出して失敗する。新しいコマンドを足して表に書き忘れると、テストが落ちる
- 各コマンドを偽の HOME から起動する。`.local/bin` には各 `executable_<name>` を配置名でコピーし、bun の wrapper が起動する `.claude/hooks` などは source への symlink にする。テストは配置先の構造に意図して依存する。配置先を変えたときにテストが落ちるのは、正しい動きである
- 副作用は 2 つの方法で検出する。1 つは stub（systemctl、orb、claude、codex、gh、op、tailscale、ssh、editor）が呼ばれたときに書く印のファイルである。もう 1 つは、偽の HOME のファイル一覧と、cwd の一時リポジトリの `git status --porcelain` を、起動の前と後で比べることである
- 値の位置の `--help` が help にならないことも確かめる。例は `workflow-cli stamp plan.md --verdict --help` と `agent-vm fetch-browsers --from-apply --help` である

除外は次の 3 つである。

- `claude-zai.tmpl`: only_private の機械でだけ描画される chezmoi のテンプレートである。テストで描画するには `chezmoi execute-template` がテストの環境に必要で、描画の結果も機械の設定で変わるため、検査しない
- delivery-policy の wrapper: HOME を passwd から取り、配置済みのコードを起動するので、source を検査できない
- delivery-policy の CLI: 保護パスなので別の PR で help を足す。それまでは理由つきの除外として表に名前を残す

### delivery-policy は別の PR にする

`home/dot_claude/hooks/cli/delivery-policy.ts` は保護パスである。これを含む PR では `delivery-policy merge` が終了コード 30 で止まり、利用者が merge する。ほかのコマンドの変更を先に取り込むため、delivery-policy の help は別の PR にする。その PR が、テストの表の delivery-policy の CLI の行を有効にする。

## 却下した代替案

- 共通の引数解析ライブラリ（bash 用と TS 用）を作り、help を宣言から生成する。ゼロから作るならこの形が自然だが、25 本の解析を置き換えると全コマンドの挙動が変わる。POSIX sh 固定の dotfiles-sync-doctor と保護パスの delivery-policy にも手が入る。必要な契約はテストで機械的に確かめられるので、ライブラリは作らない
- 全 CLI で、任意の位置の `--help` を help と見なす。値の位置の `--help` を誤認する
- 全 CLI で、最初の引数とサブコマンドの直後だけを調べる。`workflow-cli round plan.md --help` が骨格を挿入したまま残る。値の位置を知っている 2 本では、値の位置を除けば、どこの `--help` を help と見なしても誤認は起きない
- CI のスクリプトで `--help` の文字列の有無を調べる。文字列があっても、help として動くことは保証されない
- textlint-global を、textlint への素通しのままにする。runtime が無いと exit 2 で終わり、wrapper 自身のオプションが help に載らない
- textlint-global で、wrapper の usage だけを出す。素通しする textlint のオプション（`--format` など）が help から消える

## Consequences

- `textlint-global --help` の出力が変わる。wrapper の usage が先に出て、runtime が無いときの終了コードが 2 から 0 になる
- 次の 4 つは、副作用を起こさずに usage を出して終わる
  - `claude-rc-sync --help`
  - `agent-vm <sub> --help`
  - `delegation <sub> --help`
  - `workflow-cli <sub> --help`
- 新しい独自コマンドを `home/dot_local/bin/` に足すときは、`--help` を実装し、`tests/heavy/cli-help.test.mjs` の表に行を足す必要がある
- テストは配置先の構造（`~/.local/bin`、`~/.claude/hooks` など）に依存するので、配置先を変えるときはテストの表も直す
