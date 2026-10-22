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

## 学びを流す場面と形

開始時の注入は 8KB で切られ、このリポジトリでは 39 件（全文 19.9KB）の半分以上が流れない。並び順は `seen` の多い順だが、`seen` はほとんどの項目で 1 のため、実際には新しい順になっている。次の 3 つを、点検の数字を見てから判断する。

- **場面ごとに流す**: 学びに `on` のメタ（例: `claude:SessionStart`、`bash:git-commit`、`bash:gh-pr`）を足し、`show --on=…` で絞れるようにする。Claude 側は PreToolUse でコマンドの先頭を見て、該当する学びを `additionalContext` で渡す。失敗の直後（PostToolUse）に渡す形も検討する。`on` は決まった語彙から worker が選び、自由な文字列や正規表現にはしない（注入の経路と照合の壊れやすさを増やさないため）。Codex にコマンドの直前を捉える仕組みがあるかは未確認で、無ければ AGENTS.md の指示で `show --on=…` を呼ぶ形になる。規模は spec と plan に分ける大きさ
- **開始時は索引を流す**: 上位の数件だけ全文、残りは `- [id] 見出し` の 1 行にする。見出しだけなら 39 件で 4.3KB で、全件の存在を知らせられる。本文は `show --id` で引く
- **rules へ移す**: 毎回効かせたい学びは、学びの側でピン留めせず、人が rules や CLAUDE.md へ移す。学びは確かめる前の候補の置き場にとどめる

点検では、コマンドや場面に結びつく学びの割合と、rules へ移す候補（利用者の方針として記録された項目など）を数える。

## 場面の注入の暫定値と開始時の行

コマンド直前の注入は、配備後に `cmd:git status` を一時的に付けた学びで確かめた。1 回目の `git status` で文脈に入り、2 回目は重複の抑止で入らなかった。hook の所要は 9 回で p50 34ms、p95 81ms だった。次の 2 つは配備直後には確かめられなかった。

- **1 回 3 件・2KB、1 セッション 12 件・16KB の上限と、重複の抑止**: 注入が 1 件しか起きておらず、上限に届くかを判断できない。注入の記録（`injections.log`）が入った後、場面ごとの注入数とセッションの合計を数えて、上限に当たった回数を見る。直すなら spec を改訂する
- **開始時の「他に N 件」の行**: 次のセッションの開始時に出る。場面だけの学びが 0 件の今は、`0 件` の行が出るかを見る

## `appendReadLog` の書き込みの硬さ

`core/store.ts` の既存の `appendReadLog` は `O_NONBLOCK` と通常ファイルの確認を持たない。書き先の `reads.log` が FIFO に差し替えられると、開く時点で止まりうる。新しい `appendLogLines`（注入と評価のログ）は `O_NONBLOCK`・`fstat` の通常ファイル確認・4MB の上限を持つので、`appendReadLog` も同じ書き方に揃えるか、`appendLogLines` へ寄せる。

## 注入の記録と feedback の配備後の確認

配備後に、`cmd:git status` を一時的に付けた学びで確かめた。`injections.log` に `kind: pre`・`trigger: cmd:git status` の行が入り、`feedback <id> mistimed --at=pre` は受理され（`reader: claude`）、記録の無い `--at=fail` は exit 1 になった。`status` に injections・feedback・retag の行が出た。確認のために返した `mistimed` 1 件（L-17458db07f49）が 14 日の集計に残る。次は配備直後には確かめられなかった。

- **開始時の記録**: 次のセッションの開始時に、`injections.log` に `kind: session` の行（trigger は `session` か `untagged`）が描画した件数だけ増えるか。注入文の末尾に `--at=session` の案内が付くか
