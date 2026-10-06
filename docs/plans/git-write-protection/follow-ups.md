# Follow-ups: git write protection

この作業（spec.md、plan-1.md、plan-2.md、2026-10-06〜07）で、範囲の外として次に回したもの。どれも別の作業として、Document Workflow で始める想定。

## 1. Bash の境界としてのサンドボックス（dotfiles 以外の repo）

### 背景

- フックの Bash の字句の判定は best-effort で、境界ではない。plan-1 の後の自動レビューは、判定の穴を見つけ続けた。
  - 例: グロブ、くっついた短いオプション、`sh -c`、ラッパーの後ろのコマンド。
  - 直すたびに hold が増えるだけで、閉じきれない。
- 許可する側の一覧（head の allowlist）に反転する案は却下した。開発のコマンド（`pnpm install`、`make`、`bun run test`）の多くは任意のコードを実行するので、一覧が成り立たない。
- Claude Code の sandbox（`sandbox.enabled`）は、コマンドの形によらず、OS のレベルで書き込みを止める。子プロセスにも効く（sandboxing.md「Protected paths」）。
  - 作業ディレクトリの `.git/hooks`、`.git/config`、`.gitconfig`、bare repo 化、`~/.claude` のほとんどを、既に拒否する。
  - linked worktree の中から本体の repo の `.git` に書くのは許すが、その中の `hooks/` と `config` は拒否のまま。
  - 既定では、作業ディレクトリと temp 以外に書けない。

### 決まっていること（2026-10-07、ユーザー）

- サンドボックスを境界にする方向は正しい。ただし、使い物にするには agent-vm のような周辺の道具が要る。
  - 許可するドメインの調整、書き込み先の調整、通らなかったコマンドの扱い、プロジェクトごとの有効化など。
- dotfiles の repo では使わない。作業そのもの（`chezmoi apply` で home に配る）が、サンドボックスとぶつかる。dotfiles では残余を一定許容する。
- `excludedCommands` に `chezmoi apply` を入れる逃がし方は採らない。Claude が chezmoi のソースの `run_*` を編集してから、サンドボックスの外で実行できてしまう。

### 未決

- 有効にする範囲。`~/workspace` の repo ごとか、user settings で全体にして dotfiles だけ外すか。
- 抜け道の扱い。`allowUnsandboxedCommands: false` で閉じるか。`excludedCommands` に何を入れるか。
- ネットワーク。許可するドメインの初期値（npm、GitHub など）。
- agent-vm との役割の分担。
- ドッグフーディング。道具は dotfiles の repo で作るのに、この repo はサンドボックスの外で作業するというねじれをどう扱うか。
  - 候補: 試すときだけ `claude --settings '{"sandbox": {...}}'` でセッションに限って有効にする。または agent-vm の中で検証する。

### 最初の 1 手

- `https://code.claude.com/docs/en/sandboxing.md` と settings reference の `sandbox.*` を読み、research.md を書く。
- `~/workspace` の代表的な repo で `/sandbox` を有効にし、日常の作業（install、test、git、worktree）で何が止まるかを記録する。

## 2. `chezmoi apply` の自動承認

- 現状: `Bash(chezmoi apply *)` と `Bash(chezmoi apply)` が allow にある（`home/dot_claude/.settings.permissions.json`）。Claude は chezmoi のソースを編集して、確認なしで home に配備できる。
- 案: allow から外し、配備の瞬間を必ず人間の確認に通す。サンドボックスの「配備は人間が打つ」を、規則で近似する形。
- 決まっていること: 今回は見送った（ユーザーの判断、2026-10-07）。1 のサンドボックスの spec か、別の小さな作業で扱う。
- 未決: 毎回の確認の手間を許容できるか。

## 3. chezmoi のソースの一般の配布路

- `home/dot_zshrc`、`home/.chezmoiscripts/run_*`、`home/dot_claude/**` などのソースは、配布されると本体の protected なファイル（`~/.zshrc` など）や、`chezmoi apply` で実行されるスクリプトになる。
- ところが、ソースの名前は本体の protected の一覧に当たらない。git 関連のソース（`*dot_gitconfig*`、`*dot_config/*git/**`）だけを、今回 ask にした。
- spec.md「Phase 1 で意図的に提供しない体験」を参照。2 と組み合わせて考える。

## 4. 既存の Bash の allow の過大さ

本体がコマンドの形で承認する範囲の問題なので、フックの hold では閉じない（spec.md「Phase 1 で意図的に提供しない体験」）。

- `Bash(xargs *)`: フラグ付きの `xargs` を介した任意のコマンドを承認する（permissions.md「Wrappers」）。
- `Bash(gh config *)`: `gh config set editor` などで、gh がコマンドを実行する経路になる。
- `Bash(git rebase *)`、`Bash(git fetch *)`、`Bash(git worktree *)` など: サブコマンドのオプションによっては、config を使わずに外部のコマンドを起動できる。
- 1 のサンドボックスで閉じるか、ask 規則で絞るかを決める。

## 5. 検証していない自動レビューの指摘

コミット `4b5b2c6`（Bash の hold の追加）に対する自動レビューの指摘のうち、3 件は要約しか届いていない。

- 拒否リストが不完全で、ラッパーで迂回できる（`bash-write-hold.ts`）。単純コマンドの名前だけを見る判定は、`command sh -c …` のようなラッパーの後ろを見落としうる。
- 検証が不完全（`bash-write-hold.ts`）
- パーサーとの食い違い（`bash-write-hold.ts`）

扱いの方針（README「自動承認の hold」）: 追加するのは、「フック固有の承認の根拠から、protected なパスへの書き込みが自動承認される」と確かめられた形だけにする。それ以外は残余として README に書く。1 のサンドボックスが入れば、多くは意味を失う。

## 参照

- 設計と判断: `spec.md`（K1〜K8、Risks、Phase 1 で意図的に提供しない体験）
- 実験の事実: `research.md`（U1、H11: フックの allow が本体の protected paths を消していた）
- 受け入れ: `acceptance.md`
- 残余のリスク: `home/dot_claude/hooks/README.md`「自動承認の hold」
