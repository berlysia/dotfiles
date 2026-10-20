# agent-learnings の持ち越した課題

ADR-0032 の作業で範囲の外に回した課題。

## 2 週間後の点検（2026-10-29 以降）

store の `git log` と `agent-learnings status` で次を数え、定数（40 項目・8KB・3 回・200 件・Jaccard 0.2・remove 5・promote 3）を見直す。

- 利用者が消した項目の割合（有害さ）
- 作られた後に `seen` が増えた項目の割合（有用さの近似。再抽出でも増えるので、読まれて役立ったことの証明ではない）
- worker の拒否率（出力の検査が正当な学びを落としていないか）
- Codex の読み込み回数（AGENTS.md の指示が守られているか）
- 昇格の件数と、昇格した文の妥当さ

## PreCompact で worker が動くかの実機確認

PreCompact の後に worker が動いたかは、まだ見ていない。長いセッションで compact が起きたら、セッションが続いているうちに、そのセッションの行が `runs.log` に増えているかを見る。ほかのセッションの hook が worker を起こしても行は増えるので、これは状況証拠にとどまる。確定させたいなら、worker を起こした契機を `runs.log` に記録することを検討する。

## runs.log の `llm failed` に理由を残すか

`llm failed` の reason は固定の文言にしてある（LLM や transcript の文字列を入れないため）。SDK の結果の `subtype` のような、固定の集合から選べる値を足せるか検討する。

## Codex の会話からの自動抽出

今は Claude の SessionEnd だけが自動で整理する。Codex は手で `add` する。`~/.codex/sessions/` を読む入力アダプタ（`ReducedTranscript` を返すもの）を足せば、worker 以降は変えずに済む。

## Entire の checkpoint を入力にする

Entire を導入した場合、その checkpoint を worker の入力アダプタにできるか検討する。

## store の remote と push

`~/.local/share/agent-learnings` に remote が無い。private リポジトリを作って `git -C ~/.local/share/agent-learnings remote add origin <url>` を設定し、push する習慣を決める。未 push が 7 日を超えると SessionStart が知らせる。

## 削除済みの lessons-learned への古い参照

`home/dot_claude/rules/autonomous-lane.md` の Phase 2 hardening が、ADR-0008 で削除した `lessons-learned.md` を永続状態ファイルの例として挙げている。例として意図して残しているのか、古い参照なのかを確かめ、後者なら現存するファイルに直す。
