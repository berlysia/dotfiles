# 高負荷時だけ時間切れになるテスト

load average が 10 を超えるマシンで `npm test` を全件実行すると、次のテストが時間切れで落ちる。同じファイルを単体で実行すると通る。

- `hook-timer.test.ts`: 記録が 3,000 ms 以内に出ない
- `agent-learnings-queue.test.ts`: `initStore` が失敗する（`completeJob removes the job everywhere`）。同じ症状は `flaky-hook-tests.md` の `agent-learnings-worker.test.ts` にもある
- `agent-learnings-cli.test.ts`: `add and remove refuse a read-only file with exit 1`
- worktree の `C12: creating the same name twice reuses the worktree`
- worktree の `C26: four different names in parallel all succeed, 20 times`（高負荷では worktree のテストファイルだけを実行しても長くかかって落ちる）
- `complexity-delta` の `stays silent on a second stop with the same findings and logs once`
- `tests/tailnet-ssh.test.mjs`: `applySettings` から呼ぶ `ssh-keygen -y` が `spawnSync ... ETIMEDOUT`

completion-gate はこの失敗で停止を止める。

やること:

- 固定の待ち時間（3,000 ms など）を、負荷に耐える形（期限の延長、条件の待ち方）に直すか、並列度を下げる。
