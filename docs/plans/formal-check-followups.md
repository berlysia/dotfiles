# formal-check の残件

決定は ADR-0050 にある。
ここには今後やることだけを書く。
片付いた項目は消す。
すべて片付いたら、このファイルを消す。

## 対象リポジトリの CI で検査を実行する

昇格した検査は、formal-check を配置したマシンでしか実行できない。
対象リポジトリの CI で回帰の検査をしたい場面が出たら、CI の workflow の生成と、ハーネスとランタイムを CI に用意する方法を決める。
そのときは、fork からの PR で検査を実行しない条件も決める。
ハーネスは scripts/ だけで動き、ランタイムの場所を環境変数で差し替えられるので、この追加を妨げる作りにはなっていない。

## 台帳の「機械検査の結果」の節を `--json` から生成する

今は手で書く。
台帳の行は check id のアンカーを持ち、`--json` の結果も check id を持つ。
手で書いた結果と実際の結果の食い違いが起きたら、生成する機能を追加する。

## モデルを隔離する

今の守りは承認の手順で、モデルは利用者の権限で動く。
第三者のリポジトリの検査を、承認なしで実行したい場面が出たら、node の permission model か OS の隔離を検討する。
node の permission model はネットワークを塞がず、TLC の JVM にも適用されないことを確かめてある。

## 2 つの installer を共通にする

formal-check の installer は textlint の installer のコピーである。
3 つ目の同じ形の installer ができたら、1 つの script にまとめるかを決める。

## Codex から実行できるか確かめる

スキルは `~/.codex/skills/formal-check/` にも置かれるが、Codex から実行したことはない。
Codex の sandbox が、node と java の起動と `~/.config/formal-check` の読み出しを許すかは確かめていない。
Codex で formal-check を使う場面が出たら、examples の 3 つを Codex から実行して確かめる。
動かなければ、SKILL.md の前提の節に、何が足りないかを書く。

## jar と z3-solver のバージョンを上げる

z3-solver の更新は、Renovate の専用の group の PR として出る。
jar は Renovate の更新の対象に入っていない。
Renovate の PR が出たとき、または TLC の新しいリリースを使いたくなったときに、次を行う。

- `bun run test:heavy` を手元で実行する（CI では実際の solver を使うテストが skip になる）。
- jar を上げるなら、`.chezmoiexternal.toml.tmpl` のバージョンと sha256 を書き換える。verdict の写像（`lib/verdict.mjs`）と TLC のバージョンの行（`lib/version.mjs`）を、上流の終了コードの定義と照らして直す。
