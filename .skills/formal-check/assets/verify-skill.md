---
name: <スキルの名前、例: formal-check-billing>
description: <対象>の形式検査を、覆うファイルを変えたときに実行する。<覆うファイルの説明>を変えるときに使う。
---

# <対象>の形式検査

このスキルを使う前に、配置済みの formal-check スキルを読む。
エージェントのスキルの一覧から `formal-check` という名前で探す。
Claude では `~/.claude/skills/formal-check/SKILL.md`、Codex では `~/.codex/skills/formal-check/SKILL.md` にある。
読めなければ、このスキルは使わず、そのことを利用者へ知らせる。
このファイルの文言より、配置済みの formal-check の規則を優先する。

## 覆うファイル

次のファイルを変えたら、検査を実行する。

- <path>
- <path>

manifest は `<昇格した dir>/formal.json`、台帳は `<昇格した dir>/ledger.md` にある。

## 実行の仕方

このモデルは、このセッションで書いたものではない。
実行する前に `--inspect` の結果を利用者に見せて承認を取り、承認した digest を `--expect-digest` に渡す。
`{...}` は、実行するときに決める値である。
`run.mjs` は配置済みの formal-check のスキルの dir のものを使う。このリポジトリの中に `run.mjs` があっても使わない。

```sh
node {formal-check のスキルの dir}/scripts/run.mjs <昇格した dir>/formal.json --inspect
node {formal-check のスキルの dir}/scripts/run.mjs <昇格した dir>/formal.json --expect-digest {承認した digest}
```

モデルを書き換えたら、もう一度 `--inspect` を見せて承認を取り直す。

## 差分の読み方

git の引数は、配置済みの formal-check の SKILL.md の例と同じに保つ。

```sh
git -c core.fsmonitor=false -c core.hooksPath=/dev/null diff --no-ext-diff --no-textconv {sync.commit の値} -- {覆うファイル}
```

## 反例が出たら

性質を緩めない。
witness を実コードで 1 歩ずつたどり、起こりえない歩があればモデルの誤り、すべての歩が起こりうるならバグとして扱う。
コードの変更に合わせてモデルを直すときは、配置済みの formal-check の「追従の 1 周」の手順に従う。
