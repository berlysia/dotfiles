# 委譲の台帳の残件

ADR-0055 の委譲の台帳で、次の課題に回したもの。

## Agent の model を正確な ID で記録する

Agent の結果には `resolvedModel`（正確なモデル ID）と `totalDurationMs` がある（2026-10-29 の probe で確かめた）。今の台帳は、Agent の model を `sonnet` のような呼び名で記録し、所要時間は Mod が時計の差で測っている。

- `resolvedModel` を使えば、同じ sonnet でもモデルのバージョンごとに組を分けて集計できる
- ADR-0055 の K2 は、`claude-code-agent` の model を呼び名の enum と決めている。変えるには K2 の改訂と、Mod と CLI の v1 の契約の見直しが要る
- 呼び名で記録した既存の行と、ID で記録した新しい行を、集計でどう扱うかを決める

## codex-rescue 経由の記録

ADR-0056 で、route に従う Codex への委譲は `codex exec` を直接起動することにし、rescue を route の比較から外した。
rescue 経由の行は今も model と effort が `unknown` になるが、行き詰まったときに別の視点を求める使い方だけが残るので、記録を直す予定は無い。
route の委譲で rescue をまた使うと決めたら、そのときに model と effort の取り方を決める。

## Codex の委譲先の順序と Terra の effort を見直す

ADR-0056 では、委譲先の順序と、Terra を effort `high` で起動することを、記録が無い時点の推測で決めた。
Terra の集計には `high` 以外の effort の記録も入る。

- Terra と Luna max の記録がそれぞれ 5 件を超えたら、`delegation review` で effort 別の採用率を確かめる
- 採用率に差があれば、順序と Terra の effort を変えるかを決める
- Terra の条件を effort つきに絞ると、過去の記録の数え方が変わる。絞るかどうかも同時に決める

## OpenCode でレビュアーを動かす

Document Workflow のレビュアーを OpenCode で動かす仕組みが無い。route が review で opencode を勧めても、規約は sonnet で起動させている。
作るには、レビュアーを Codex で動かすときと同じような runner と、各 agent 定義の分岐が要る。外部でのレビューの質がまだ記録に無いので、ADR-0057 では作らなかった。
Codex 経路のレビュアーの記録がたまり、route が review で opencode を勧める場面が出たら検討する。

## 週枠が何をどの比で数えるかを定期的に測る

2026-10-29 に、使用量を次の 2 つの方法で集計した。

- usage-line の `$.store`（`~/.claude/plugins/store/usage-line_*.json` の `samples:v1:*`）にある週枠の使用率の増え方を、同じ時間の全 session のトークン数で回帰した。トークン数は `~/.claude/projects/**/*.jsonl` の usage から、キャッシュの読み込み・書き込み・出力に分けて数えた。
  - キャッシュの読み込みの重みは、出力を 5 としたとき 0.04〜0.06 で、API の価格の比（0.1）の約半分だった。
  - 量が多いので、週枠の 4〜5 割をキャッシュの読み込みが占めていた。
  - 週枠は整数の % でしか記録されず、変数どうしが一緒に増えるので、係数は区切り方で揺れる。キャッシュの書き込みの重みは 0.9〜2.2 で、はっきりしない。
- 同じ日の 9 session を区分ごとに集計した。メインループが 7〜8 割、レビュアーが 13〜20%、その他の subagent が 7〜10% だった。

この集計を `delegation review` に組み込み、定期的に見られるようにするかを決める。2026-10-29 に `autoCompactWindow` を 300000 にしたので、数日後に同じ集計で効果を確かめる。問題が無ければ 200000 を検討する。

## cli テストの時間を測り直す

ADR-0057 の変更で、delegation の cli テストは load 7〜8 のときに 2.8〜3.0s かかった（変更前は 1.8〜2.1s）。
1 ファイルの上限 3s に収まるかは、負荷の低いときに 3 回測って確かめる。超えるならファイルを分ける。

`tests/delegation-pace-route.test.mjs` は、自動書き換えの再検討の判定より前から 3s を超えていた。
2026-10-29 に load 約 21 で測ると 3.0〜5.9s だった。
判定のテストは 2 つの describe で合わせて約 1.1s 増えた。
判定を加えた後、load 約 6 のときに 3 回測ると 2.78〜2.85s で、上限の手前だった。
いちばん遅いのは既存の「review (process)」（約 2.7s）で、分けるならここからにする。

## 検討して見送ったこと

- **`CLAUDE_CODE_FORK_SUBAGENT=0` で subagent の完了を待つ**: 並列に呼んだレビュアーの結果が 1 回で返り、完了の通知でメインループが起きる回数が減る。2026-10-29 の 1 session では、通知で起きたリクエストの読み込みは全体の約 13% だった。読み込みの 8 割は、メインループ自身のツール呼び出しの続きだった。効果が小さく、待つ間に利用者が会話できなくなるので、入れなかった。

## 参照

- `docs/decisions/0055-delegation-ledger.md`
- `docs/decisions/0057-route-lookahead-and-surplus.md`
- ADR-0041（usage-line の予想と取得）

## レビュアーの起動と承認の後に route を呼ぶ仕組みが無い

提案・未決。出どころ: dotfiles-feedback 20261029T080322Z-9db55e1a4446。

- **観察**: 2026-10-29 の 1 session（5b0ab66e）で、Document Workflow のレビュアーを model を指定せずに Agent で起動した。メインループが Opus 5.5 なので、レビュアーも Opus で実行した。plan-3 から plan-5 の Round 1 まで、合計で 30 回を超える。
- `delegation route --kind review` を一度も実行しなかった。後から実行すると、推奨は sonnet だった。
- 実装の委譲（`--kind impl`）は、plan の承認の後に route を呼んで sonnet に渡せていた。
- 気づいたきっかけは、利用者の「これオフロードされてる?」という問いだった。
- model-offloading の rule は読み込まれていた。レビュアーを起動する時点に、思い出させる仕組みが無かった。「実装着手ゲート」の失敗事例と同じ形が、レビューの側で起きた。
- **送った人の提案**（利用者の発言は「approveされたらdelegation routeを呼ぶことを促したり強制的に呼んだりする仕組みが必要そう」）:
  - approval-answer-recorder が plan の承認を記録したとき、`delegation route --kind impl` の推奨を出力に添える
  - plan-review-automation が推奨レビュアーを出すとき、`delegation route --kind review` の推奨の model を同じ出力に添える
  - Agent の PreToolUse で、レビュアーの subagent_type（logic-validator など）が model なしで起動されたら、route の推奨を示して止めるか警告する
- 対象: `rules/model-offloading.md`、plan-review-automation、approval-answer-recorder。
- **未決**: 3 つの提案のうち、どこまで入れるか。PreToolUse で止める案は、route の推奨が codex のときに model なしの起動を止めるべきかも決める。

## delegation record を忘れやすく、後から記録する手がかりも無い

提案・未決。出どころ: dotfiles-feedback 20261029T091133Z-1a330c8ce949。

- **観察**（2026-10-29、dotfiles の 1 session）: plan-5 のレビューで、sonnet のレビュアーを Agent で計 16 回起動した。起動先は `delegation route --kind review` に従った。
- どの完了の後にも、`[delegation]` で始まる記録を促す行を見なかった。そのため `delegation record` を 1 回も実行していない。
- 別のセッションから利用者が周知を送ってきて、初めて記録の抜けに気づいた。
- 記録しようとして `delegation review --since 1` を実行したが、pending の id の一覧は出なかった。`delegation --help` にも、pending の id を並べるコマンドが無い。
- 記録の契機が、Mod が出す 1 行だけに頼っている。その行が出ない、または読み落とすと、記録は気づかれないまま抜ける。
- 抜けた記録は lapse になり、route の採用率の比較が偏る。route の出力にも「記録漏れが多い」と出ていた。
- **送った人の提案**:
  - pending の委譲を、id・起動時刻・agent の説明つきで並べるコマンド（例: `delegation pending`）を足す
  - 承認・stamp・triage の記録の時点で、その session の pending の件数を出す。あるいは workflow-cli の stamp や triage が、record を促す行を出す
  - `[delegation]` の行が出る条件を確かめる
- 対象: delegation CLI、delegation-budget Mod。
- **未決**: 今回、sonnet の Agent の完了の後に行が 1 回も出なかった原因は分かっていない。Mod の条件を読むところから始める。
