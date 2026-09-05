# ADR-0014: hook 依存の install を配置後フェーズに移し、fail-loud と隔離統制を入れる

## Status

accepted (2026-09-05)

## Context

2026-09-05、`home/dot_claude/package.json` に `ccstatusline` を追加したところ、`chezmoi apply` を 1 回走らせても `~/.claude/node_modules` に反映されなかった。`~/.claude/package.json` は新しい内容に更新されている一方で、`node_modules` は古いままという状態が観測された。

実測した原因は次のとおりである。chezmoi は source state の全エントリを**target path の ASCII 順**で適用する。スクリプトの target path は `.chezmoiscripts/<プレフィックス除去後の名前>.sh` の形を取り、`.ch` < `.cl` であるため、`.chezmoiscripts/` 配下のスクリプトは `~/.claude/` 配下のどのファイルよりも必ず先に走る。これは設計上の保証ではなくディレクトリ名の ASCII 順が偶然そうなっているだけであり、この順序から明示的に抜けられる機構は `run_before_` / `run_after_` の 2 つだけである。

旧 `run_onchange_install-packages-7c-hook-deps.sh.tmpl` は `.chezmoiscripts/` 側の ASCII 順フェーズに置かれていた。このフェーズは「全 target 配置」より前に走るため、このスクリプトが `bun install` を実行する時点で読める `~/.claude/package.json` は**その apply が更新する前の内容**である。この相の取り違えを恒久化させたのが `run_onchange_` のハッシュ機構である。7c はスクリプト本文に source 側 `home/dot_claude/package.json` のハッシュを埋め込んでいた。依存を追加すると source が変わるのでハッシュも変わり、7c は再実行される。ところがその実行時点で読める配置先の `package.json` は前回 apply の内容であり、install されるのは古い依存集合になる。次の apply では source に変化がないためハッシュも変わらず、7c は再実行されない。つまり**追加した依存は恒久的に入らない**。

7c のハッシュ行は root `bun.lock` のハッシュも追跡していたため、無関係な root 依存の変更が起きると 7c が再発火し、そのとき配置先 `package.json` は既に新しくなっているため結果的に正しく install されることがあった。系が「1 apply 遅れ」で収束しているように見えたのはこの経路によるもので、無関係な後続変更に依存しており保証がない。設計が意図した経路では 7c は一度も機能していなかった。

## Decision

### 1. install を配置後フェーズの単一無条件スクリプトへ統合する（KD1-KD3）

hook 依存の install 責務を `run_after_` フェーズの単一スクリプトに統合する。`run_after_` は全 target 配置後に走ることが保証されている相であり、ここに置く限り「その apply が更新した package.json」を必ず読める。`00-` と `zz-` の 2 つのプレフィックスは本機構専用に予約し、他のスクリプトに使わせない。

### 2. fail-loud は末尾の verifier に分離する（KD4）

`run_after_` フェーズは非ゼロ終了したスクリプトがあると、それ以降の `run_after_` スクリプトを一切実行しない。install の失敗をこのスクリプト自身の非ゼロ終了で報告すると、後続の無関係なスクリプト（`sync-skills` や `gc` 等）を巻き添えで止めてしまう。そこで installer 自身は失敗しても exit 0 を保ち、失敗の事実をマーカーファイルに記録するだけにとどめる。失敗を実際に apply の非ゼロ終了へ変換する役目は、`run_after_` 群の末尾で走る verifier に分離した。verifier はマーカーファイルの有無だけを見て、あれば非ゼロ終了で復旧手順を出力する。

### 3. `~/.claude/node_modules` を source ツリーへの symlink にする案は却下する（KD6）

install root を 1 つに統合する代替案として、`~/.claude/node_modules` を chezmoi source ツリー側の `node_modules` への symlink にする案を検討したが、却下した。理由は次の 3 点である。

- (a) hook ランタイムが chezmoi source checkout が固定パスに存在し続けることに恒久的に依存することになる。hook は tool call のたびに発火し、`chezmoi apply` よりはるかに高頻度で実行されるため、依存の性質が違う
- (b) リポジトリルートの `node_modules` は 7.5G あり、dev tooling 一式を含む。symlink にすると hook の依存解決パスがこの dev サプライチェーン全体と同居することになる
- (c) Windows では symlink 作成に昇格が必要になり得るため、分岐がもう 1 つ増える

この却下によって受け入れるコストは、install root が `~/.claude` と source ツリーの 2 つのまま残ることである。デプロイ側の install には独自の隔離統制が必要になり、それが下記の C2 である。

### 4. デプロイ先 `~/.claude/bunfig.toml` を root の `bunfig.toml` から verbatim 生成する（D2/C2）

`~/.claude/bunfig.toml` を、リポジトリルートの `bunfig.toml` を chezmoi テンプレートで verbatim コピーする形で生成し、`private_` プレフィックスによりモード 600 で配置する。

理由: bun は `bunfig.toml` を**呼び出し時の cwd からしか読まず、親ディレクトリを探索しない**ことを実測で確認した。デプロイ時に `~/.claude` で走る `bun install` はこの設定ファイルが無ければ、root 側の install が備えている `minimumReleaseAge` の 1 週間隔離を一切引き継がない。verbatim コピーとすることで SSoT を root 1 箇所に保ち、将来 root 側に private registry の認証情報等が追加された場合もそれが同じ経路でデプロイ側に伝わる（現時点でそのような情報は無いが、伝播した場合に機密として扱う必要が生じるため 600 で配置する）。

### 5. workspace 離脱によるビット単位の硬化は見送る（D2/C3）

source 側の `home/dot_claude` を bun workspace（root `package.json` の `workspaces`）から切り離して独立パッケージ化し、追跡された standalone lockfile を持たせた上でデプロイ時に `--frozen-lockfile` を課す硬化案は、今回は実施しない。これを採れば CI が検証したツリーとのビット単位の一致が得られるが、lockfile が 2 個になり、CI に 2 回目の install が必要になり、Renovate の対象面が倍化し、メンバー側にも `bunfig.toml` の重複が要る。現在の脅威モデル（source 側は root `bun.lock` に sha512 込みで追跡済み、apply の実行者は本人）に対してこのコストは見合わない。

**移行トリガー**: hook 依存が本人以外の環境（CI レーン等）にデプロイされるようになった時点で改めて評価する。

## Consequences

- 定常状態の `chezmoi apply` に約 80-90ms（mise bootstrap 約 70ms + `bun install` 約 12ms）が新たに加わる。設計検討の初期段階で見積もった 12ms は対話シェルで `bun install` サブプロセス単体を測った値であり、実際に `run_after_` が走る非対話シェルの実行コンテキスト（bun が PATH に無く、mise で環境を起こす必要がある）を反映していなかった
- オフライン環境では、依存に変更が生じている限り `chezmoi apply` が非ゼロ終了し続ける
- `00-install-hook-deps` と `zz-verify-hook-deps` の間にある `run_after_` スクリプトが hard fail すると（`gc` は `set -euo pipefail` を持つため対象になり得る）、verifier に到達せずその apply では hook 依存の診断が出ない。マーカーファイル自体は残るため、次の clean な apply で自動的に回復する
- installer 自身が hard fail するのは、マーカーファイルを書き込めない場合の 1 箇所だけである。installer は `run_after_` 群の先頭に置かれているため、この分岐が発火すると後続の `run_after_` スクリプトが全てその apply で走らなくなる。これは「install 失敗が後続を止めない」という KD4 の狙いが、別の原因（bun install の失敗 **かつ** マーカーファイルへの書き込み不能という二重障害）によって破られる形である。二重障害でしか発火せず、かつサイレントには失敗しない。installer は exit する前に復旧手順（`cd ~/.claude && bun install`）を ERROR ログとして出力する
- `bun` コマンドが見つからない場合、installer はマーカーファイルを書かずに skip する。これは fail-loud という目標とは整合しないが、bun を導入する `install-packages-*` 系のスクリプトは同じ apply のより前の相で走るため、この分岐に到達するのは bootstrap そのものが未完了の場合に限られる。是正しない accepted non-goal として扱う
- C2 が復元するのは recency filter（`minimumReleaseAge`）だけであり、依存の推移的ツリー全体の pin や検証は行わない。bun 1.4.0 で実測したところ、`minimumReleaseAge` は exact pin されたバージョンも拒否し（`blocked by minimum-release-age: 604800 seconds` で解決に失敗する）、一方で `bun.lock` に既に記録されているバージョンは隔離を素通りする。したがって隔離が効くのは各バージョンが**初めて解決される時点**に限られ、C2 導入前から `~/.claude/bun.lock` に入っているエントリは遡って検査されない
- postinstall スクリプトは引き続き無制限である。`--ignore-scripts` も `trustedDependencies` の指定もリポジトリ内のどこにも存在せず、C2 と C3 のどちらもこの面には対処していない

これらの不変条件は `scripts/smoke-hook-deps-invariants.sh`（13 assertion）で機械的に守られており、`.github/workflows/ci-smoke-chezmoi.yml` に配線されている。

## References

- `home/.chezmoiscripts/run_after_00-install-hook-deps.sh.tmpl` — 本 ADR の installer 実装（旧 `run_after_ensure-hook-deps.sh.tmpl` の改名・改修）
- `home/.chezmoiscripts/run_after_zz-verify-hook-deps.sh.tmpl` — fail-loud を担う verifier 実装
- `home/dot_claude/private_bunfig.toml.tmpl` — デプロイ先 `~/.claude/bunfig.toml` を root から verbatim 生成するテンプレート
- `bunfig.toml`（リポジトリルート）— `minimumReleaseAge` / `minimumReleaseAgeExcludes` の SSoT
- `scripts/smoke-hook-deps-invariants.sh` — 本 ADR の不変条件を守る 13 assertion のテスト
- `.github/workflows/ci-smoke-chezmoi.yml` — 上記テストと assertion G が検証する入力（`bunfig.toml` 等）の CI 配線
- `docs/plans/unmanaged-file-drift-detection.md` — 旧 `run_after_ensure-hook-deps.sh.tmpl` を参照していた箇所を改名後の名前・責務分離の説明に更新
