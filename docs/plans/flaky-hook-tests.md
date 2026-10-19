# 全体実行でだけ落ちる hook のテスト

`bun run test` を全体で流したときだけ、次のテストが 1 回ずつ落ちた。単独で流すと毎回通り、落ちるテストは実行ごとに変わった。hook のコードに変更が無い状態で起きている。原因を調べて直したら、このファイルを消す。

- `home/dot_claude/hooks/tests/unit/agent-learnings-worker.test.ts` の「completes with opsApplied 0 when the only op was dropped」: `initStore(store, runGit).ok` が false。この 1 件だけ 8.7 秒かかっていた（単独なら全体で 1.5 秒）
- `home/dot_claude/hooks/tests/unit/auto-mode-experiment-report.test.ts:483` の「runs auto-approve.ts in isolation and leaves the real decisions log alone」: 期待と違って `deny` が返った

どちらも並列実行の負荷を疑う。

`auto-mode-experiment-report.test.ts` は、コードを読んだ限りでは次の筋が有力。再現実験では確かめていない（CPU に負荷をかけて単独で流す実験は、負荷が強すぎて結論が出なかった）。

- `hooks/lib/bash-parser.ts` の構文解析には実時間で 100 ms の予算（`DEFAULT_PARSE_BUDGET_MS`）がある。超えると `time` の give-up になり、guard は deny する。コメントにも「負荷で超えうる、結果は deny だけ」とある
- `hooks/tests/preload-test-env.mjs` は `setParseBudgetMs(10_000)` で予算を上げるが、効くのはテストのプロセスの中だけ
- `replayOne`（`scripts/auto-mode-experiment-report.ts`）は auto-approve.ts を `process.execPath` で別プロセスとして起動し、`--import` を付けない。そのため子プロセスの予算は 100 ms のまま。単独で呼ぶと `ls` は Layer 1 の静的パターンで allow になる

直す案: 失敗時の deny の理由を assert のメッセージに出し、理由が parser の give-up（`PARSER_GIVE_UP_REASON_TEXTS`）なら負荷によるものとして許容する。または、予算を子プロセスへ渡す経路をテスト専用に設ける。後者は「本番のコードは setter を呼ばない」という現在の規約に触れる。
