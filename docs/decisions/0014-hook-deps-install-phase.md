# ADR-0014: hook 依存の install を配置後フェーズに移し、fail-loud と隔離統制を入れる

## Status

accepted (2026-09-05)

[ADR-0017](0017-provisioning-after-deploy.md) (2026-09-29) が同じ種類の問題をツールチェーンと root の依存ツリーにも広げ、`run_after_` に帯の命名を導入した。本 ADR の「`00-` と `zz-` は本機構専用に予約する」規則は帯の定義に置き換わり、installer は `10-install-hook-deps`、verifier は `zz-verify-provisioning` に改名された。KD1-KD4・KD6 は supersede されない。

## Context

2026-09-05、`home/dot_claude/package.json` に `ccstatusline` を追加したところ、`chezmoi apply` を 1 回走らせても `~/.claude/node_modules` に反映されなかった。`~/.claude/package.json` は新しい内容に更新されている一方で、`node_modules` は古いままという状態が観測された。

実測した原因は次のとおりである。chezmoi は source state の全エントリを**target path の ASCII 順**で適用する。スクリプトの target path は `.chezmoiscripts/<プレフィックス除去後の名前>.sh` の形を取り、`.ch` < `.cl` であるため、`.chezmoiscripts/` 配下のスクリプトは `~/.claude/` 配下のどのファイルよりも必ず先に走る。これは設計上の保証ではなくディレクトリ名の ASCII 順が偶然そうなっているだけであり、この順序から明示的に抜けられる機構は `run_before_` / `run_after_` の 2 つだけである。

旧 `run_onchange_install-packages-7c-hook-deps.sh.tmpl` は `.chezmoiscripts/` 側の ASCII 順フェーズに置かれていた。このフェーズは「全 target 配置」より前に走るため、このスクリプトが `bun install` を実行する時点で読める `~/.claude/package.json` は**その apply が更新する前の内容**である。この相の取り違えを恒久化させたのが `run_onchange_` のハッシュ機構である。7c はスクリプト本文に source 側 `home/dot_claude/package.json` のハッシュを埋め込んでいた。依存を追加すると source が変わるのでハッシュも変わり、7c は再実行される。ところがその実行時点で読める配置先の `package.json` は前回 apply の内容であり、install されるのは古い依存集合になる。次の apply では source に変化がないためハッシュも変わらず、7c は再実行されない。つまり**追加した依存は恒久的に入らない**。

7c のハッシュ行は root `bun.lock` のハッシュも追跡していたため、無関係な root 依存の変更で 7c が再発火し、そのとき配置先 `package.json` は既に新しいので結果的に正しく install されることがあった。系が「1 apply 遅れ」で収束しているように見えたのはこの経路によるもので、保証がない。設計が意図した経路では 7c は一度も機能していなかった。

## Decision

### 1. install を配置後フェーズの単一無条件スクリプトへ統合する（KD1-KD3）

hook 依存の install 責務を `run_after_` フェーズの単一スクリプトに統合する。`run_after_` は全 target 配置後に走ることが保証されている相であり、ここに置く限り「その apply が更新した package.json」を必ず読める。`run_after_` の中の順序は名前の先頭の prefix で与える（帯の割り当ては ADR-0017）。chezmoi が target 名の辞書順で実行するためである。名前の末尾の連番（`install-packages-0`、`install-claude-plugins-8` など）は同じ stem の中でしか順序を与えず、stem が違えば `install-c` < `install-p` のように stem の綴りで決まる。先頭の数字は英小文字より必ず前に並ぶ。

### 2. fail-loud は末尾の verifier に分離する（KD4）

`run_after_` フェーズは非ゼロ終了したスクリプトがあると、それ以降の `run_after_` スクリプトを一切実行しない。install の失敗をこのスクリプト自身の非ゼロ終了で報告すると、後続の無関係なスクリプト（`sync-skills` や `gc` 等）を巻き添えで止めてしまう。そこで installer 自身は失敗しても exit 0 を保ち、失敗の事実をマーカーファイルに記録するだけにとどめる。失敗を実際に apply の非ゼロ終了へ変換する役目は、`run_after_` 群の末尾で走る verifier に分離した。verifier はマーカーファイルの有無だけを見て、あれば非ゼロ終了で復旧手順を出力する。

### 3. デプロイ先 `~/.claude/bunfig.toml` を root の `bunfig.toml` から verbatim 生成する（D2/C2）

`~/.claude/bunfig.toml` を、リポジトリルートの `bunfig.toml` を chezmoi テンプレートで verbatim コピーする形で生成し、`private_` プレフィックスによりモード 600 で配置する。

理由: bun は `bunfig.toml` を**呼び出し時の cwd からしか読まず、親ディレクトリを探索しない**ことを実測で確認した。デプロイ時に `~/.claude` で走る `bun install` はこの設定ファイルが無ければ、root 側の install が備えている `minimumReleaseAge` の 1 週間隔離を一切引き継がない。verbatim コピーとすることで SSoT を root 1 箇所に保ち、将来 root 側に private registry の認証情報等が追加された場合もそれが同じ経路でデプロイ側に伝わる（現時点でそのような情報は無いが、伝播した場合に機密として扱う必要が生じるため 600 で配置する）。

## Consequences

- 定常状態の `chezmoi apply` に約 80-90ms が新たに加わる。大半は `run_after_` が走る非対話シェルで bun を得るための mise bootstrap（約 70ms）で、`bun install` 自体は約 12ms である
- オフライン環境では、依存に変更が生じている限り `chezmoi apply` が非ゼロ終了し続ける
- `10-install-hook-deps` と `zz-verify-provisioning` の間にある `run_after_` スクリプトが hard fail すると（`gc` は `set -euo pipefail` を持つため対象になり得る）、verifier に到達せずその apply では hook 依存の診断が出ない。マーカーファイル自体は残るため、次の clean な apply で自動的に回復する
- installer 自身が hard fail するのは、マーカーファイルを書き込めない場合の 1 箇所だけである。installer は `run_after_` 群の先頭に置かれているため、この分岐が発火すると後続の `run_after_` スクリプトが全てその apply で走らなくなる。これは「install 失敗が後続を止めない」という KD4 の狙いが、別の原因（bun install の失敗 **かつ** マーカーファイルへの書き込み不能という二重障害）によって破られる形である。二重障害でしか発火せず、かつサイレントには失敗しない。installer は exit する前に復旧手順（`cd ~/.claude && bun install`）を ERROR ログとして出力する
- `bun` コマンドが見つからない場合、installer はマーカーファイルを書かずに skip する。これは fail-loud という目標とは整合しないが、bun を導入する `install-packages-*` 系のスクリプトは同じ apply のより前の相で走るため、この分岐に到達するのは bootstrap そのものが未完了の場合に限られる。是正しない accepted non-goal として扱う
- C2 が復元するのは recency filter（`minimumReleaseAge`）だけであり、依存の推移的ツリー全体の pin や検証は行わない。bun 1.4.0 で実測したところ、`minimumReleaseAge` は exact pin されたバージョンも拒否し（`blocked by minimum-release-age: 604800 seconds` で解決に失敗する）、一方で `bun.lock` に既に記録されているバージョンは隔離を素通りする。したがって隔離が効くのは各バージョンが**初めて解決される時点**に限られ、C2 導入前から `~/.claude/bun.lock` に入っているエントリは遡って検査されない
- postinstall スクリプトは引き続き無制限である。`--ignore-scripts` も `trustedDependencies` の指定もリポジトリ内のどこにも存在せず、C2 と C3 のどちらもこの面には対処していない

これらの不変条件は `scripts/smoke-provisioning-invariants.sh` で機械的に守られ、CI に配線されている。

## 却下した代替案

- **`~/.claude/node_modules` を source ツリーの `node_modules` への symlink にする（KD6）**: install root を 1 つに統合できるが、(a) hook ランタイムが chezmoi source checkout の固定パスへ恒久的に依存する。hook は tool call のたびに発火し、`chezmoi apply` よりはるかに高頻度で実行されるため、依存の性質が違う。(b) リポジトリルートの `node_modules` は 7.5G で dev tooling 一式を含み、hook の依存解決パスがこの dev サプライチェーン全体と同居する。(c) Windows では symlink 作成に昇格が必要になり得る。受け入れるコストは、install root が `~/.claude` と source ツリーの 2 つのまま残り、デプロイ側の install に独自の隔離統制（D2/C2）が要ることである
- **workspace 離脱によるビット単位の硬化（D2/C3）**: `home/dot_claude` を bun workspace から切り離して独立パッケージ化し、追跡された standalone lockfile を持たせてデプロイ時に `--frozen-lockfile` を課す。CI が検証したツリーとのビット単位の一致が得られるが、lockfile が 2 個になり、CI に 2 回目の install が要り、Renovate の対象面が倍化し、メンバー側にも `bunfig.toml` の重複が要る。現在の脅威モデル（source 側は root `bun.lock` に sha512 込みで追跡済み、apply の実行者は本人）にコストが見合わない。**移行トリガー**: hook 依存が本人以外の環境（CI レーン等）にデプロイされるようになった時点で改めて評価する

## References

- `docs/decisions/0017-provisioning-after-deploy.md` — 同じ種類の問題をツールチェーンと root 依存について解き、本 ADR の予約規則を帯の命名に置き換えた
