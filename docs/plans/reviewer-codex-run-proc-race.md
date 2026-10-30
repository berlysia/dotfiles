# reviewer-codex-run のテストが /proc の読み取りで落ちる

全テストを実行すると、`kills process group: grandchild` が ENOENT で落ちることがある。直したら、このファイルを消す。

## 分かっていること

- 2026-10-31 に `bun run test` を 4 回実行し、1 回だけ `open '/proc/417/stat'` の ENOENT で落ちた。委譲先の 1 回を足すと、5 回中 1 回である。単独実行は 5 回とも通った。
- 該当箇所は `home/dot_claude/hooks/tests/unit/reviewer-codex-run.test.ts` の `kills process group` である。`process.kill(pid, 0)` が成功した後に `/proc/<pid>/stat` を読む。
- この 2 つの間にプロセスが回収されると ENOENT になる、と推測している。再現はしていない。
- 落ちるのはテストだけで、本体の動きには関係しない。再実行で通るので、気づけて戻せる。

## 判定

- 深刻度は高くない。データの損失も秘密の漏えいも無く、再実行で作業を続けられる。
- 頻度は判定が割れた。subagent は標本が足りず判断できないとした。5 回中 1 回が続くなら、通常の使い方で頻繁に起きる。

## 再開するときの手順

1. `/proc` の読み取りの ENOENT を「プロセスは消えた」として扱い、テストを通す。
2. 全テストを 5 回実行し、この失敗が出ないことを確かめる。
