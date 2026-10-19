# ADR-0034: agent-vm の VM 経由を opt-in にし、入口を vclaude / vcodex に分ける

## Status

accepted (2026-10-19)

## Context

ADR-0018 K10 は、mac で素の `claude` / `codex` を打つと既定で repo ごとの VM で動かし、host で動かすには `AGENT_VM=off` を付ける、と決めた。隔離を打鍵ゼロで得るためで、ADR-0018 の Decision 冒頭にあるエルゴノミクス優先の判断による。

利用者はこれを opt-in に変えると決めた。素の `claude` / `codex` は host で動かし、VM で動かしたいときだけ明示して使う。入口の形は、利用者が専用のラッパー（`vclaude` / `vcodex`）を選んだ。

`AGENT_VM` を読むのはシェル関数（`home/dot_shell_common/agent_vm.sh`）だけで、launcher（`home/dot_local/bin/executable_agent-vm`）は案内文に `AGENT_VM=off` と書いていただけだった。そのため変更はシェルの入口と案内文と文書に閉じ、launcher の判定は変えずに済む。

## Decision

- **K1: 入口を名前で分ける。** `agent-vm` が PATH にあるとき、シェルは `vclaude` / `vcodex` を定義し、引数をそのまま `agent-vm claude|codex` に渡す。`claude()` / `codex()` の上書きはやめる。どちらで動くかがコマンド名で分かり、環境変数の状態に左右されない。
- **K2: 入口の契約を 3 つに固定する。**
  - (a) 素の `claude` / `codex` は常に host の実行ファイルで、launcher を通らない。
  - (b) `vclaude` / `vcodex` と `agent-vm claude|codex` は同じ契約で、launcher の判定に従う。VM で起動し、repo の外と除外 repo なら host で動かし、異常時は fail closed する。
  - (c) `~/.config/agent-vm/config` は「(b) で起動しても host で動かす repo の一覧」で、(b) にだけ効く。書式と意味（除外リスト）は変えない。
- **K3: VM を明示的に選んだ起動の fail closed は保つ**（ADR-0018 K10 の後半）。保証は (b) の経路に限られ、素の `claude` には及ばない。opt-in の定義からの帰結である。
- **K4: launcher はシェルの入口名を知らない。** 案内文は `vclaude` という名前を埋め込まず、「agent-vm を通さずに `claude` / `codex` を直接打つ」（`run claude / codex directly (not through agent-vm)`）と書く。入口名を変えても launcher とテストが連動して壊れないようにするため。`.git` が消えた既知 repo での停止の案内は、「repo を確かめる」を host 実行の案内より前に置く。
- **K5: `AGENT_VM` は即時廃止し、警告も互換も入れない。** `AGENT_VM=off` は無視されても結果は同じ（host）である。旧実装は `off` 以外の値をすべて既定（VM）として扱っていたので、`AGENT_VM=on` は旧仕様でも意味を持たない値だった。

### 却下した代替案

- **`AGENT_VM=on` で opt-in に反転する**: 変更は条件 1 行で済む。しかし、`export` したまま忘れると素の `claude` がどちらで動くか分からなくなる。利用者も専用のラッパーを選んだ。
- **config を「VM で動かす repo の一覧」（allowlist）に反転し、素の `claude` が repo ごとに自動で VM を選ぶ**: 素の `claude` を常に launcher に通すことになり、launcher の起動コストと失敗面を host 実行にも持ち込む。「VM は明示的に選ぶ」から離れる。既存の除外リストが逆の意味で読まれる移行問題も生じる。

## Consequences

- **R1**: 素の `claude` / `codex` は launcher を通らない。そのため、`.git` が消えた既知 repo での停止（ADR-0018 K10 後半の fail closed）は、(b) の経路でだけ効く。
- **R2**: VM で使った repo を host で使うとき、ADR-0018 K13 の git 面検査と R8 の運用ルールの保護は、既定では効かない。VM が書いた `.git/hooks`・`.git/config` と、repo 内の `.claude/` 配下・`.mcp.json`・`CLAUDE.md`・`.envrc` などを、host の claude や git が検査なしで読み・実行しうる。従来は `AGENT_VM=off` という例外操作だったが、これからは既定になる。
  - 緩和は `docs/agent-vm.md` 7 節の手順で、人の確認に頼る。終了コード 3 が守るのは `.git` 面だけで、repo 内の `.claude/` などの変更は自動では検知されない。VM セッションの後、host で開く前に `git status --ignored` と `git diff` で確かめる。
  - fail closed の案内文は host 実行（K13・R8 の外）への出口を示す。opt-in の帰結として受け入れる。
- **R3**: 隔離を打鍵ゼロで得る、という ADR-0018 Decision 冒頭の価値を明示的に手放す。
- **R4**: 契約 (a) は、シェル関数で `claude` を上書きしないことだけで成り立つ。利用者が別の alias や PATH で `claude` を launcher に向けた場合は対象外である。
- ADR-0021 の R1 と 17 項にある回復手順の `AGENT_VM=off` は、「agent-vm を通さずに `claude` / `codex` を直接打つ」と読み替える。
- 移行: `chezmoi apply` の後に新しいシェルを開く。開いたままのシェルには古い `claude()` 関数が残る。

## References

- `docs/decisions/0018-agent-vm-orbstack.md`（K10、K13、R8）
- `docs/decisions/0021-agent-vm-golden-clone.md`（R1、17 項）
- `docs/agent-vm.md`（5 節、6 節、7 節）
- `home/dot_shell_common/agent_vm.sh`, `home/dot_local/bin/executable_agent-vm`
- `tests/agent-vm/run-shell.sh`, `tests/agent-vm/run.sh`
