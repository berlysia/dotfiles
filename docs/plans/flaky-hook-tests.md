# 全体実行でだけ落ちる hook のテスト

`bun run test` を全体で流したときだけ、次の 2 件がたまに落ちていた。単独で流すと毎回通る。どちらも、並列実行の負荷で本番の時間の上限を超えたという見立てで対策を入れてある。見立ても、落ちなくなったことも確かめていない。

## 対策を入れたもの

- `tests/perf/auto-mode-replay.test.ts`: `replayOne` の子プロセスは preload なしで、本番の解析予算（100 ms）で動く。判定の確認は、直列で流れる perf へ移した。落ちたときは判定をまるごと表示する。`denySource` が `parser-give-up` なら見立てどおり
- `tests/unit/agent-learnings-worker.test.ts` の「completes with opsApplied 0 when the only op was dropped」: `initStore` が `ok: false` を返していた。`runGit` は git の呼び出しを 1 回ごとに 5 秒で kill する。このテストだけ 60 秒版（`tests/support/patient-git.ts`）に替えた。落ちたときは `initStore` の reason を表示する

## このファイルを消す条件

次のどちらかを満たしたら消す。

- 再発したときに表示された理由が見立てどおりで、直し方を見直した
- 2026-11-02 まで、2 件とも落ちなかった

## 同じ理由で落ちうるもの

次の 7 ファイルは、5 秒版の `runGit` をプロセス内で使っていて、上の worker のテストと同じ理由で落ちうる。git を起動するので、heavy（`tests/heavy/`、直列で実行する）へ移した。落ちた記録はない。

- `agent-learnings-cli.test.ts`
- `agent-learnings-health.test.ts`
- `agent-learnings-inbox.test.ts`
- `agent-learnings-queue.test.ts`
- `agent-learnings-repo-key.test.ts`
- `agent-learnings-session-context.test.ts`
- `agent-learnings-store.test.ts`

見張る条件: heavy で、上の worker のテストと同じ形（`initStore` が `ok: false` を返す）で落ちたら、`patientRunGit` に替える。`bun run test` から外れたので、落ちるのは CI と `bun run test:heavy` になる。

`complexity-delta.test.ts` も git を起動するので heavy へ移した。「未対策で落ちたもの」の項目を参照。

## 未対策で落ちたもの

- `tests/unit/complexity-delta.test.ts` の「uses the injected git timeout to find the repository root」: Stop hook の全体実行で 1 回落ちた（10.3 秒、`t.state()` の state ファイルが無く ENOENT）。state ファイルは baseline を記録したときに書かれるので、`resolveRoot` が成功する前に prompt が終わったと読める。このテストは git の上限を `PATIENT_TIMEOUT_MS` にしてあり、rev-parse は 3 秒遅らせてある。どの上限に当たったかは確かめていない。単独で 3 回流すと 3 回とも通った
- `tests/unit/agent-learnings-cli.test.ts`: 全体実行で 2 回、別のテストで落ちた。1 回目は 443 行目で `exitCode` が 3（期待 0）。2 回目は Stop hook の実行で、「applies a pending inbox request on the next add without waiting on its own lock」の 216 行目で同じく 3（6.5 秒）。exit 3 が何の失敗かは確かめていない。どちらも同じセッションで `chezmoi apply` と `agent-learnings add` を実行した後だった。単独で 3 回流すと 3 回とも 25 件通った。上の一覧のとおり、`patientRunGit` に替えるかを決める候補
- `tests/unit/system-notification-launch.test.ts` の「a notify-send that hangs is abandoned after the cap」: 2 回落ちた。どちらも Stop hook の全体実行のときである。子プロセスが 5288 ms と 5585 ms かかり、`elapsedMs < 5000` の assert に当たった。打ち切りの上限（`SYSTEM_NOTIFICATION_LAUNCH_TIMEOUT_MS`）は 2000 ms で、偽の notify-send は 6 秒眠る。上限で打ち切る前に 5 秒を超えたのか、打ち切った後の終了が遅れたのかは確かめていない。子プロセスの起動だけなら約 80 ms だったので、起動の遅れだけでは説明できない。単独で 3 回流すと 3 回とも 6 件通った。全体の実行と並行して単独で 4 回流しても、4 回とも通った。次に調べるなら、fixture（`send-system-notification-child.ts`）に、呼び出しにかかった時間をファイルへ書かせる。落ちたときに、呼び出しの中と外のどちらで時間がかかったかを分けられる
