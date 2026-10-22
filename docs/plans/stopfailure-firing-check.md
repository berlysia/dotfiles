# "The response stopped arriving" で StopFailure が発火するかの確認

## 今の形（2026-10-22 に観察）

- `CLAUDE_STREAM_IDLE_TIMEOUT_MS=600000` を settings の env に入れた。watchdog が無通信の stream を切るまでの時間を延ばすため
- StopFailure hook（`speak-notification.ts StopFailure`）が、デスクトップ通知「エラー: <repo>」を出す。あわせて `~/.claude/logs/events.jsonl` に `event:"StopFailure"`, `message:"error=<error> details=<error_details>"` を 1 行書く
- Claude Code 2.1.307 で、`API Error: The response stopped arriving. The response above may be incomplete.`（`streamCutCause: "watchdog"`, `truncatedAfterOutput: true`）の終わり方が StopFailure を発火させるかは確かめていない。stall を意図して起こす手段が無い。binary はバイトコードで、発火条件を読み取れなかった

## やること

次にこのエラーが出たら、そのセッションで次を実行する。

```
grep '"StopFailure"' ~/.claude/logs/events.jsonl | tail
```

- その session_id の行がある: 発火している。`message` の `error` の値をこのファイルに書き、ファイルを消す。それでも 600s で切られていたなら、`CLAUDE_STREAM_IDLE_TIMEOUT_MS` の値を見直す
- 行が無い: StopFailure は発火していない。代わりの合図を検討する（transcript の `isApiErrorMessage` を見張る、など）
