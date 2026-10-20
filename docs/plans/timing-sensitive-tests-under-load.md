# 高負荷時だけ時間切れになるテスト

2026-10-20、`npm test`（4,219 件）を load average 10〜13 のマシンで全件実行すると、次の 7 件が落ちた。同じファイルを単体で実行すると全件通った。

- `hook-timer.test.ts`: 記録が 3,000 ms 以内に出ない（4 件）
- `agent-learnings-queue.test.ts`: `initStore` が失敗する（`completeJob removes the job everywhere`）
- worktree の `C12: creating the same name twice reuses the worktree`
- `complexity-delta` の `stays silent on a second stop with the same findings and logs once`

completion-gate はこの失敗で停止を止める。出力の抜粋は成功した行だけを示すことがあり、どのテストが落ちたかは `npm test` を全件実行して `✖` を探さないと分からなかった。

やること:

- 固定の待ち時間（3,000 ms など）を、負荷に耐える形（期限の延長、条件の待ち方）に直すか、並列度を下げる。
- completion-gate の抜粋に、落ちたテストの名前を必ず含める。
