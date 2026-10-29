# ADR-0055: insight-digest を廃止し、学びの取り出しを agent-learnings に一本化する

## Status

accepted (2026-10-29)

## Context

セッションの記録から学びを取り出す仕組みが 2 つあった。

insight-digest は、セッションの ★ Insight の段落を毎日 04:00 に蒸留し、規約へ昇格させる候補の一覧を作っていた。
agent-learnings（ADR-0032）は、セッションの終わりに学びを取り出し、次のセッションの開始時と場面ごとに注入している。

2 つは同じ学びを別々に取り出していた。
insight-digest の蒸留は LLM の入力を 670 件で打ち切っていたので、未処理の insight が 1,230 件たまっていた。
どの insight が打ち切られるかは記録の古さと関係なく決まり、処理済みかどうかを確かめる手段も無かった。

利用者は、insight-digest を agent-learnings へ合流させると決めた。
そのうえで、撤去する前に、未処理の insight をすべてさばくと決めた。

## Decision

insight-digest を廃止する。
学びの取り出しは agent-learnings だけが行う。
規約への昇格の検討は、learnings スキルの「昇格の検討（review）」の手順で行う。

撤去の前に、insights.jsonl の全件を棚卸しした。

- 対象は 2026-10-28 に固定した 1,230 件と、その後に増えた 41 件である。
- 振り分けは Codex が行い、どの insight もちょうど 1 つの行に属することを機械的に確かめた。
- 1,230 件は 97 行にまとまった。利用者が採否を決め、採用 69 行、一部採用 12 行、破棄 16 行になった。
- 後から増えた 41 件は 22 行に属し、採用 18 行、一部採用 2 行、破棄 2 行になった。
- 採用した行は、規則・CLAUDE.md・スキル・学びに反映した。

撤去に合わせて、次のことを決めた。

- redact のパターンを読む関数を `redact-secrets.ts` に移した。パターンのファイル名 `~/.claude/insight-distill-redact.txt` は変えない。端末ごとに足したパターンを引き継ぐためである。
- 定期実行の登録は、chezmoi が一度だけ実行するスクリプトで解除する。登録が無いと確かめられたときだけ成功で終わるので、失敗すれば次の apply でやり直す。
- 配置先に残るファイルは `.chezmoiremove` に書いた。
- ADR-0025 が配置される文書の例外として挙げていた insight-digest は、スキルごと無くなった。ADR-0025 の本文は書き換えない。

## 却下した代替案

- **insight-digest を残し、蒸留の打ち切りだけを直す**: 学びを取り出す仕組みが 2 つのまま残る。同じ学びが両方から出て、LLM の呼び出しと排他の仕組みも 2 つ残る。残す理由は昇格の出口だけで、その出口は agent-learnings の store の上に作れる。
- **agent-learnings の CLI に review のサブコマンドを足す**: store は人も読める Markdown である。メタ行には `seen`・`repos`・`updated` がある。昇格の検討は、スキルの手順で store を読むことから始められる。採用した後は既存の `remove` を呼ぶ。
- **蒸留をもう一度回して未処理分をさばく**: 蒸留の出力は入力の一部を根拠に引用するだけで、どの insight がどのまとまりに属するかを返さない。全件をさばいたことを確かめられない。

## Consequences

- 学びを取り出す仕組みが 1 つになり、撤去した TypeScript は 2 本（約 1,370 行）、テストは 4 本になった。
- 昇格の検討は自動では起きない。人が learnings スキルの review を呼んだときに行う。
- 棚卸しの途中で、agent-learnings の store の性質が分かった。1 ファイル 40 件の上限を超えると、警告を出さずに古い学びが押し出される。これはセッションの終わりの自動の追加でも起きる。見直しは `docs/plans/learnings-cap-eviction.md` と `docs/plans/agent-learnings-auto-extract-cap.md` に残した。
- 過去のセッションの説明は、insights.jsonl を消した後は recall と transcript の grep で探す。注意点は `~/.claude/rules/developer-experience.md` に書いた。

## References

- ADR-0032（agent-learnings の store）
- ADR-0025（配置される文書の自己完結）
- `.skills/learnings/SKILL.md`（昇格の検討の手順）
