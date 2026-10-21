# ADR-0039: ツールのデフォルトを TypeScript 7 / oxlint / oxfmt / tsdown / fallow / jactionlint にそろえ、Actions の lint は jactionlint 1 本にする

## Status

accepted (2026-10-21)

## Context

新規 TS プロジェクトの推奨（`home/dot_claude/rules/typescript-new-project.md`、`.skills/apply-harness-practices/`）は prettier と knip を勧め、bundler と GitHub Actions の lint を書いていなかった。推奨を管理するこのリポジトリ自身も二段構えだった。

- 整形: oxfmt の後に yml/yaml だけ prettier に回していた
- dead code: 週 1 回の gc が `bunx knip` で報告していた
- Actions の lint: CI は actionlint（reviewdog）と zizmor を別の job で走らせ、ローカルの `lint:actions` と pre-push は zizmor だけを走らせていた

二段構えは対象の分け方が 2 か所にでき、ずれる。ローカルと CI で走るツールが違うと、CI で初めて落ちる。

利用者は、推奨と dotfiles 自身の両方を移すこと、similarity-ts を残すこと、jactionlint が zizmor 相当なら default profile で zizmor も置き換えること、jactionlint にしか無い検出は機械的な分を直しセキュリティの分は判断すること、を選んだ。

## Decision

1. 新規 TS プロジェクトの推奨を TypeScript 7 / pnpm / oxlint / oxfmt / tsdown（ライブラリの bundle）/ fallow（dead code）/ jactionlint（default profile）にする。npm のツールは devDependencies に完全な版で、jactionlint は mise の `"github:jdx/jactionlint"` に完全な版で固定し、jactionlint の更新は CI の結果を見て人が取り込む。重複検出は similarity-ts を残す（fallow dupes は関数単位の類似度スコアを出さない）
2. dotfiles の整形は oxfmt だけにし、prettier と `.prettierignore` を消す。oxfmt が構文エラーにするテンプレート（`.skills/claude-action-bootstrap/assets/workflows/auto-fix-dependencies.yml`）だけを `.oxfmtignore` に載せる
3. knip を fallow 3.32.0 に替える（`.fallowrc.json`）。gc は fallow の終了コードで clean / 検出あり / 失敗（終了コード N）を書き分け、失敗でも gc は止めない
4. Actions の lint は jactionlint 1 本にし、CI・`bun run lint:actions`・pre-push が同じ版と同じ設定（`.github/jactionlint.yaml`、`online: true`）を使う。CI の actionlint と zizmor の job、`zizmor.yml`、`cargo:zizmor` の固定、renovate の zizmor グループを消す
5. jactionlint の版は `home/dot_config/mise/config.toml`（ホストと agent-vm で共有）に 1 か所だけ固定する。CI はこの行を読み、`x.y.z` の形に完全に合う値だけを mise-action に渡す
6. jactionlint default の検出 29 件を、24 件直し 5 件を理由つきで無視する（下の表）
7. 自動承認（`permission-auto-approve.ts`）は fallow と jactionlint を読むだけの使い方に限り、許可リストで判定する。`.settings.permissions.json` には足さない

### jactionlint が zizmor を置き換えられる根拠

- この repo で zizmor の通常の検査が出す 13 件のうち、CI が見ていた 3 件（dangerous-triggers 2、github-env 1）は default でも出る。残る self-repository 10 件は jactionlint では pedantic だけのルールで、zizmor 側でも `zizmor.yml` で無効にしていた
- 未来のコードに出る audit を崩した workflow で比べた（`pull_request_target` + PR の head の checkout、`@v4` の未固定、`run:` に PR タイトル、`GITHUB_ENV` に head_ref）。zizmor 1.30.1 の検出（artipacked、dangerous-triggers、excessive-permissions、github-env、template-injection 2、unpinned-uses 2）は、jactionlint 2.2.0 default ですべて出た。excessive-permissions は missing-permissions として出る
- インラインの `# zizmor: ignore[...]` は jactionlint も尊重するが、`--migrate-ignores` で `# jactionlint ignore=...` に移した

### 検出の扱い

| rule                      | file                                         | 扱い                                                                                                                                                                                                                      |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dangerous-triggers        | `status-check.yml`                           | 無視。`workflow_run`、権限は `actions: read` と `statuses: write`、PR を checkout しない                                                                                                                                  |
| dangerous-triggers        | `auto-fix-dependencies.yml`                  | 無視。bot の PR だけ、checkout の前に作者を確かめる                                                                                                                                                                       |
| dangerous-triggers        | `claude.yml`                                 | 無視。実行は `sender.login == 'berlysia'` の場合だけ、environment は `claude-manual`、repo への書き込み権限なし。コメントの本文は Claude への信頼できない入力で、書けるのが持ち主だけであることがこの無視の前提           |
| agentic-actions           | `auto-fix-dependencies.yml`                  | 無視。ADR-0011 の自律レーンが意図した設計。job は書き込み権限を持ち、merge しないことと設計面に触れないことはプロンプトの指示で守っているだけ（autonomous-lane の「Phase 1 の限界」）。自律の型を広げるときは無視を見直す |
| unverified-download       | `.github/actions/install-chezmoi/action.yml` | 無視。`curl \| sh` の危険は実在する。直す作業は `docs/plans/chezmoi-install-verification.md`。無視はファイル全体に効くので、このファイルを編集したら見直す                                                                |
| missing-timeout           | 16 job                                       | 直す（下の値）                                                                                                                                                                                                            |
| concurrency-limits        | 7 workflow                                   | 直す。pull_request の実行だけ cancel、push・schedule・workflow_run・issue 系は止めない                                                                                                                                    |
| pipeline-without-pipefail | `test-shell-compatibility.yml`               | 直す（`shell: bash`）                                                                                                                                                                                                     |

`timeout-minutes` は `max(10, 観測した最大 × 5 を 5 分単位に切り上げ)` で決めた。ci-agent-vm 25、ci-git-worktree-cleanup 20、ci-typescript 15、ほかは 10。ci-git-worktree-cleanup の ubuntu で 15 分で終わった 2 回（2026-10-05、run 37364436579 と 37368038163）は、job に step の記録が無く、runner の割り当てで止まったとみて根拠から外した。claude 60 と auto-fix 30 は実行の記録が無い見積もりで、発火したらログを見て上げる。

`.github/jactionlint.yaml` の `ignores` は PR で足せる。歯止めは review である。

### 版の置き場と配布

jactionlint の固定を repo の `.mise.toml`（shellcheck の場所）でなく共有の `config.toml` に置いたのは、claude-action-bootstrap スキルが他の repo で jactionlint を前提にするからである。前の actionlint の行も同じ理由でここにあり、agent-vm にも配られる（`tests/agent-vm/run-templates.sh` で固定した）。

mise の `github:` backend は、GitHub API の digest で checksum を確かめ、GitHub artifact attestation を検証した（2026-10-21 に `MISE_DEBUG=1` で観察。attestation が無いときに止まるかは確かめていない）。mise の `minimum_release_age` は完全な固定を止めないので、待ちには頼らない。renovate の preset は mise の minor と patch を自動 merge するので（`:automergeMinor`）、jactionlint だけ自動 merge を止めるルールを足した。

### online の検査

`online: true` で、CI は `GITHUB_TOKEN`、ローカルは `gh auth token` を使う。lookup が失敗しても jactionlint（plain mode）は lookup を飛ばし、終了コードは変わらない。確かめたのは無効な token（401。認証なしで続ける）と届かない API（lookup を飛ばす。CI と同じ条件で 86 秒）の 2 通りで、rate limit（403）と 5xx は docs の記述に頼っている。CI は `--online-report` を読み、`complete` でなければ件数つきの `::warning` と step summary を出す（job は落とさない）。report の自由文は出さない。ローカルで token や network が無いときは online の検査が飛び、それを拾うのは CI になる。

### 自動承認

- fallow: `npx`・`pnpx`・`bunx`・`pnpm` の後に読むだけの subcommand（dead-code、dupes、health、audit、list、explain）が続くときだけ。書き込む option（`--save-baseline`、`--save-snapshot`、`--output-file` など）と、語だけでない引数は承認しない。subcommand の後の option は除外リストで見るので、fallow が書き込む option を足すと通ってしまう。subcommand を読むだけのものに絞ることで、その余地を小さくしている
- jactionlint: 引数の許可リスト（`--format`・`--profile`・`--min-severity` は値も列挙）。`--shellcheck=CMD` などの任意のコマンドを走らせる option、`--config-file`、書き換えの option、ファイルの引数は承認しない
- repo の設定ファイルは実行ファイルを指定できない（jactionlint の `shellcheck` は追加の引数と repo 内の rcfile だけ、fallow の `plugins` は宣言、`extends` は設定だけを取る）
- `bunx fallow` は、ほかの repo では最新版を取ってくる。既存の `bunx knip` や `bunx vitest` と同じ扱いとした

## 却下した代替案

- 規約の文面だけを変え、dotfiles の配線（prettier、knip、actionlint、zizmor）は残す: 推奨と、推奨を管理する repo が食い違う
- zizmor をしばらく残して段階的に移す: 利用者は同等なら置き換えると決めており、同等性は負例で確かめた
- fallow dupes で similarity-ts を置き換える: 類似度スコアが出ない
- jactionlint の correctness profile にして zizmor を残す: 利用者が default を選んだ
- 検出を baseline で受け入れて修正を後回しにする: 利用者が直すと決めた
- 固定を repo の `.mise.toml` に置く: bootstrap スキルが他の repo で使えなくなる

## Consequences

- jactionlint はプロジェクト開始から約 2 週間の若いツールで、作者は mise と同じ jdx である（この repo はすでに mise と mise-action を信頼している）。新しい default ルールが誤検出したら、`.github/jactionlint.yaml` の `ignores` に rule と file で足して黙らせられる
- jactionlint の release や attestation の障害で mise install が落ちると、Actions の lint 全体が止まる。これは許容した
- jactionlint ごと戻すときは、commit `ci(lint): replace actionlint and zizmor with jactionlint`、`fix(ci): run jactionlint through mise exec with the pinned version`、`feat(skills): ...`（bootstrap スキル）を revert し、この ADR を superseded にして理由を足す。workflow の修正（`ci(workflows): ...`）は残してよい。actionlint 1.7.12 と zizmor 1.30.1 でも、修正後の workflow は修正前と同じ結果になる
- asset（bootstrap スキル）と repo の workflow の `timeout-minutes` と `concurrency` の値は手で二重に持っており、揃っているかを確かめる仕組みは無い
- claude.yml の concurrency は待ちの実行を 1 つしか持たないので、1 つの issue で作業中に 3 回以上メンションすると間の待ちは消える
- fallow は knip と未使用 export の数え方が違う（2026-10-21: knip は export 42・type 12、fallow は export 46・type 2）。`ignoreExportsUsedInFile` を有効にすると export 7・type 2 で knip から離れたので使わない。knip の「Unlisted binaries」に当たる検査は fallow に無い
- CI の job は、mise-action の `install_args` で jactionlint を入れたうえで、`mise exec "github:jdx/jactionlint@<版>"` で呼ぶ。`install_args` は版を選ばないので、shim から呼ぶと「No version is set」で止まる（`ci-shellcheck.yml` が shim で動くのは、shellcheck が repo の `.mise.toml` に載っているから）
- PR #348 の CI で jactionlint の job が通り、online の検査は `complete` だった（2026-10-21）。崩した workflow で job が落ちることは、CI では確かめていない（ローカルの `lint:actions` と pre-push で確かめた）
