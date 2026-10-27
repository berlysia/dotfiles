# delegation-budget Mod の残件

`mods/delegation-budget` を足したときに残した課題。片付いた項目は消し、空になったらこのファイルを消す。

## 実際のセッションで確かめる

テストは偽の `$.session.usage()` と偽の時計で動いている。`chezmoi apply` の後の新しいセッションで、次を確かめる。

- 週次枠が 80% 以上のとき、モデルが Agent を 1 回呼ぶと、結果の後に `[delegation-budget]` で始まる段落がモデルの transcript に残る
- Workflow を 1 回呼んだときも同じ段落が残る
- 利用者の画面にはその段落が出ない
- `subagent_type: "codex:codex-rescue"` の Agent では段落が足されない
