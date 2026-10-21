# message-times Mod の持ち越し

片付いた項目は消し、空になったらこのファイルを消す。

## 再開したセッションの過去の行

`message-times` は `session.append` で行が保存された時刻を覚えるので、Mod が読み込まれる前に保存された行（`--resume` / `--continue` で戻った会話の履歴）には時刻を出さない。transcript ファイル（jsonl）の各行には `uuid` と `timestamp` があり、メッセージ行の描画の `requestId` は `uuid` と同じ値なので、`session.start` でファイルを読めば過去の行にも時刻を出せる。見送ったのは、ファイルの場所と形式が Mod の API の外にあり、Claude Code の版で変わりうるため。見直すのは、再開したセッションで過去の行の時刻が要る場面が実際に出たとき。
