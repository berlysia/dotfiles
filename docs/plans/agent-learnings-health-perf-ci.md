# agent-learnings の health 通知の性能テストが CI で予算を超える

## 今の形（2026-10-23 に観察）

- `home/dot_claude/hooks/tests/perf/agent-learnings-health.test.ts` は、`getLearningsHealthNotice` を 20 回呼んだ p95 が 100 ms 以下であることを確かめる
- CI（ubuntu-latest、Node 22）の `bun run test:perf` で、2 回続けて予算を超えた。1MB の状態で 108.7 ms と 112.4 ms、4MB の状態で 100.2 ms と 105.2 ms。1MB の行 1 つの状態は通った
- 手元（WSL、Node 24.22.1）では 1MB の状態で 58.6 ms、4MB の状態で 71.6 ms で通る
- この失敗は、unit の `read-stdin-limited.test.ts` が Node 22 で落ちていた間は、`test:perf` まで進まず見えていなかった
- TypeScript CI が通らないので、status-check が必須の PR は管理者の権限でしか merge できない

## やりたいこと

CI の TypeScript CI を、性能テストを含めて通るようにする。

## 決めること

- 原因の切り分け: `getLearningsHealthNotice` が遅くなったのか、CI の runner に対して 100 ms の予算がきついのか。手元との差（約 1.5 倍）が runner の速さの差だけで説明できるかを確かめる
- 直し方: 処理を速くする、予算を変える、CI では予算を runner に合わせる、のどれにするか。予算は SessionStart で待たせてよい時間から決まっているはずなので、その根拠を確かめてから変える
