# `.env` の Read を ask にした変更の残件

`.env` 系のファイルの Read は、設定の ask 規則で人間に確認する。
自動承認の hook は、`lib/auto-approval-hold.ts` の hold でこの Read を通さない。
決定と却下した案は、commit `fix(claude): ask before reading .env files instead of denying` の本文にある。
計測は [ADR-0027](../decisions/0027-permission-path-pattern-semantics.md) の「確認した事実」にある。

## 測り直す時

次のどちらかの後に、下の手順をやり直す。

- Claude Code を更新した後。hook の allow と ask 規則の関係は公式ドキュメントに無く、2.1.296 での計測に依存している。
- `home/.chezmoidata/claude_hooks.yaml` の `claude_hooks.auto_approval` を `true` に戻した後。

### 手順

scratchpad に、ダミーの 1 行（`PROBE_KEY=dummy-not-a-secret`）を書いた `.env` と `.env.example` を置く。本物の `.env` は使わない。

1. `claude -p --model haiku` で `.env` と `.env.example` をそれぞれ Read させる。`.env` は「haven't granted it yet」を含む拒否になり、`.env.example` は中身が返る。
2. 自動承認の hook が登録された状態で、同じ 2 回を行う。`auto_approval` が `false` の間は、`--settings` で `auto-approve.ts`（PreToolUse）と、`permission-auto-approve.ts`・`permission-llm-evaluator.ts`（PermissionRequest）をその実行だけ登録する。`.env` は拒否になり、`~/.claude/logs/decisions.jsonl` に `held: Read of a file an ask rule names` が残って Read の allow は残らない。`.env.example` は中身が返り、Read の allow が残る。
3. 同じ hook の状態で対話のセッションを起動し、`.env` を Read させる。確認が出て、拒否を選ぶと読まれない。

1〜3 のどれかが違ったら、`.settings.permissions.json` の `Read(//**/.env*)` の 10 行を `ask` から `deny` へ戻して `chezmoi apply` を実行し、hold を見直す。

## 測っていないこと

- Read の規則が Grep と Glob に効くか。公式ドキュメントは、可能な範囲で適用すると書く。2.1.296 のセッションには Grep のツールが無く、測れなかった。ツールがある版で、deny 規則と ask 規則のそれぞれを測る。今の deny が Grep を止めていたなら、ask への移動で、hook が登録されているときに Grep だけ緩む。hold は Grep と Glob を見ていない。
- agent-vm の中での挙動。VM は同じ設定と hook を持ち込む。

## ask 規則を足すとき

ask 規則を hold へ手で写した一覧が、Edit の 4 件（`lib/write-protection.ts`）と Read の 10 件（`lib/auto-approval-hold.ts`）の 2 種類ある。
設定に Read の ask 規則を足すときは、hold も直す。直し忘れと、名前で判定できない形の規則は、`hold-invariants.test.ts` が落として知らせる。
3 種類目が要るときに、hook が `permissions.ask` を読む一般の仕組みを検討する。本体と同じ読み方で ask 規則を照合する本番用の実装は、今は無い（`tests/support/core-match.ts` はテスト用である）。
