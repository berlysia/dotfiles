# agent-learnings の持ち越した課題

ADR-0032 の作業で範囲の外に回した課題。

## 2 週間後の点検（2026-10-29 以降）

store の `git log` と `agent-learnings status` で次を数え、定数（40 項目・8KB・3 回・200 件・Jaccard 0.2・remove 5・promote 3）を見直す。

- 利用者が消した項目の割合（有害さ）
- 作られた後に `seen` が増えた項目の割合（有用さの近似。再抽出でも増えるので、読まれて役立ったことの証明ではない）
- worker の拒否率（出力の検査が正当な学びを落としていないか）
- Codex の読み込み回数（AGENTS.md の指示が守られているか）
- 昇格の件数と、昇格した文の妥当さ

## runs.log の `llm failed` に理由を残すか

運用の初期に 3 件が 2 秒のうちに続けて失敗し、原因が分からなかった。reason は固定の文言にしてある（LLM や transcript の文字列を入れないため）。SDK の結果の `subtype` のような、固定の集合から選べる値を足せるか検討する。

## Codex の会話からの自動抽出

今は Claude の SessionEnd だけが自動で整理する。Codex は手で `add` する。`~/.codex/sessions/` を読む入力アダプタ（`ReducedTranscript` を返すもの）を足せば、worker 以降は変えずに済む。

## Entire の checkpoint を入力にする

Entire を導入した場合、その checkpoint を worker の入力アダプタにできるか検討する。

## store の remote と push

`~/.local/share/agent-learnings` に remote が無い。private リポジトリを作って `git -C ~/.local/share/agent-learnings remote add origin <url>` を設定し、push する習慣を決める。未 push が 7 日を超えると SessionStart が知らせる。

## 削除済みの lessons-learned への古い参照

`home/dot_claude/rules/autonomous-lane.md` と `docs/plans/workflow-guard-followups.md` が、ADR-0008 で削除した lessons-learned と抽出の仕組みに触れている。
