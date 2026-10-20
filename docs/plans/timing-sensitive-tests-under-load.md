# 高負荷時だけ時間切れになるテスト

2026-10-20、`npm test`（4,219 件）を load average 10〜13 のマシンで全件実行すると、次の 7 件が落ちた。同じファイルを単体で実行すると全件通った。

- `hook-timer.test.ts`: 記録が 3,000 ms 以内に出ない（4 件）
- `agent-learnings-queue.test.ts`: `initStore` が失敗する（`completeJob removes the job everywhere`）
- worktree の `C12: creating the same name twice reuses the worktree`
- `complexity-delta` の `stays silent on a second stop with the same findings and logs once`
- worktree の `C26: four different names in parallel all succeed, 20 times`（load average 15 前後で、worktree のテストファイルだけを実行しても 72 秒かかって落ちた）
- 2026-10-21 に追加で見つかった 2 件（どちらも単体では通った）:
  - `agent-learnings-cli.test.ts` の `add and remove refuse a read-only file with exit 1`（全件では 5.6 秒かかって落ち、単体では 0.2 秒で通った）
  - `tests/tailnet-ssh.test.mjs` の `applySettings` から呼ぶ `ssh-keygen -y` が `spawnSync ... ETIMEDOUT`

completion-gate はこの失敗で停止を止める。出力の抜粋は成功した行だけを示すことがあり、どのテストが落ちたかは `npm test` を全件実行して `✖` を探さないと分からなかった。

やること:

- 固定の待ち時間（3,000 ms など）を、負荷に耐える形（期限の延長、条件の待ち方）に直すか、並列度を下げる。
- completion-gate の抜粋に、落ちたテストの名前を必ず含める。
