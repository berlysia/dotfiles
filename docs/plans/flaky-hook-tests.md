# 全体実行でだけ落ちる hook のテスト

`bun run test` を全体で流したときだけ、次のテストが落ちた。単独で流すと毎回通る。hook のコードに変更が無い状態で起きている。原因を調べて直したら、このファイルを消す。

- `home/dot_claude/hooks/tests/unit/agent-learnings-worker.test.ts` の「completes with opsApplied 0 when the only op was dropped」: `initStore(store, runGit).ok` が false。この 1 件だけ 8.7 秒かかっていた（単独なら全体で 1.5 秒）

並列実行の負荷を疑う。
