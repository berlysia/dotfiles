# 全体実行でだけ落ちる hook のテスト

`bun run test` を全体で流したときだけ、次の 2 件がたまに落ちていた。単独で流すと毎回通る。どちらも、並列実行の負荷で本番の時間の上限を超えたという見立てで対策を入れた（#333、#334）。見立ても、落ちなくなったことも確かめていない。

## 対策を入れたもの

- `tests/perf/auto-mode-replay.test.ts`（もとは unit の `auto-mode-experiment-report.test.ts` にあった）: `replayOne` の子プロセスは preload なしで、本番の解析予算（100 ms）で動く。判定の確認は、直列で流れる perf へ移した。落ちたときは判定をまるごと表示する。`denySource` が `parser-give-up` なら見立てどおり
- `tests/unit/agent-learnings-worker.test.ts` の「completes with opsApplied 0 when the only op was dropped」: `initStore` が `ok: false` を返していた。`runGit` は git の呼び出しを 1 回ごとに 5 秒で kill する。このテストだけ 60 秒版（`tests/support/patient-git.ts`）に替えた。落ちたときは `initStore` の reason を表示する

## このファイルを消す条件

次のどちらかを満たしたら消す。

- 再発したときに表示された理由が見立てどおりで、直し方を見直した
- 2026-11-02 まで、2 件とも落ちなかった

## 同じ理由で落ちうるもの

次の unit テストは、5 秒版の `runGit` をプロセス内で使っている。落ちた記録はない。上の worker のテストと同じ形で落ちたら、`patientRunGit` に替える。

- `agent-learnings-cli.test.ts`
- `agent-learnings-health.test.ts`
- `agent-learnings-inbox.test.ts`
- `agent-learnings-queue.test.ts`
- `agent-learnings-repo-key.test.ts`
- `agent-learnings-session-context.test.ts`
- `agent-learnings-store.test.ts`
