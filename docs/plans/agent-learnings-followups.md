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

## `show --grep` の配備後の確認

merge と `chezmoi apply` の後、`agent-learnings show --grep=zzz-nomatch` が stderr に `一致する学びが無い` を出すことで、新しい CLI が配られたかを確かめる。Codex でも同じコマンドを 1 回実行し、stderr の行がエージェントに見えるかを確かめる。見えなければ AGENTS.md の Learnings 節に「出力が空なら一致なし」と書き足す。

## 開始時の 8KB に収まらない学び

場面のタグを付けた後も、dotfiles（33 件で 16 件省略）と kanbun-annotation（26 件で 10 件省略）の開始時は 8KB に収まらない。残っているのは、方針や進め方の学びで、コマンドやパスに結びつかない（ADR-0042 R12）。次のどちらかを、注入の記録と feedback が溜まってから決める。

- **開始時は索引を流す**: 上位の数件だけ全文、残りは `- [id] 見出し` の 1 行にする。本文は `show --id` で引く
- **rules へ移す**: 毎回効かせたい学びは、学びの側でピン留めせず、人が rules や CLAUDE.md へ移す。学びは確かめる前の候補の置き場にとどめる

## 場面の注入の上限の見直し

1 回 3 件・2KB、1 セッション 12 件・16KB の上限（ADR-0042 K6）は暫定の値。`agent-learnings status` の `injections (14d)` と、セッションごとの場面の state（`~/.claude/state/agent-learnings/<session>.injected`）の行数で、上限に当たった回数を数えて直す。

## reader の無い注入の記録を受理から外す（2026-11-05 以降）

注入の記録に reader を足したのは 2026-10-22 の配備から。それより前の記録は reader を持たず、評価の受理の根拠として、どの reader の評価でも受け付けている（ADR-0042 の受け入れたリスク）。14 日の窓から古い記録が出る 2026-11-05 以降に、評価の reader が `claude` か `codex` のときは reader の無い記録を受理の根拠から外す。

## `appendReadLog` の書き込みの硬さ

`core/store.ts` の既存の `appendReadLog` は `O_NONBLOCK` と通常ファイルの確認を持たない。書き先の `reads.log` が FIFO に差し替えられると、開く時点で止まりうる。新しい `appendLogLines`（注入と評価のログ）は `O_NONBLOCK`・`fstat` の通常ファイル確認・4MB の上限を持つので、`appendReadLog` も同じ書き方に揃えるか、`appendLogLines` へ寄せる。

## SessionStart の所要時間の退行を知らせる

health 通知の性能テスト（`tests/perf/agent-learnings-health.test.ts`）は、CI の runner で測れる量だけを見る。4MB/1MB の比と、p95 250 ms の退行の上限である。利用者の機械での SessionStart の所要時間は、CI では見ていない。行あたりの費用が runner によって約 2.2〜2.9 倍未満に上がる退行も、CI を通る。

その時間は `~/.claude/logs/hook-timing.jsonl` に残り、`hook-timing` で集計できる。ただし、閾値を超えても知らせは出ない。標本も少ない（2026-10-23 時点で `session.ts` は 6 件、p50 63 ms、p95 309 ms）。

やること:

- `session.ts` の SessionStart の所要時間を、週ごとの中央値と p95 の推移として見る。
- 知らせる条件は、固定の予算ではなく、過去の移動基準からの悪化にする（例: 直近 4 週の中央値より何 % 遅いか）。
- CI 側でも推移を追うかを決める。追うなら、共有 runner のぶれ（同じ commit の 3 回で p50 が 52〜92 ms）を打ち消す量にする。4MB/1MB の比や、同じジョブで測った基準の処理で割った値などがある。

## 開始時の記録の確認

場面の注入・注入の記録・feedback は Claude と Codex の両方で配備後に確かめたが、開始時の経路は配備の後のセッションの開始でしか見られない。次のセッションの開始時に、`injections.log` に `kind: session`・`reader: claude` の行（trigger は `session` か `untagged`）が描画した件数だけ増えるか、注入文の末尾に「他に N 件」の行と `--at=session` の案内が付くかを見る。確認のために返した評価（L-17458db07f49 の `mistimed` と、Codex からの `helpful`）が 2026-11-05 まで集計に残る
