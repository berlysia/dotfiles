# 委譲の台帳の残件

ADR-0055 の委譲の台帳で、次の課題に回したもの。

## Agent の model を正確な ID で記録する

Agent の結果には `resolvedModel`（正確なモデル ID）と `totalDurationMs` がある（2026-10-29 の probe で確かめた）。今の台帳は、Agent の model を `sonnet` のような呼び名で記録し、所要時間は Mod が時計の差で測っている。

- `resolvedModel` を使えば、同じ sonnet でもモデルのバージョンごとに組を分けて集計できる
- ADR-0055 の K2 は、`claude-code-agent` の model を呼び名の enum と決めている。変えるには K2 の改訂と、Mod と CLI の v1 の契約の見直しが要る
- 呼び名で記録した既存の行と、ID で記録した新しい行を、集計でどう扱うかを決める

## codex-rescue 経由の model と effort を取る

`codex:codex-rescue` の Agent は、Codex に渡す model と effort を Mod から読めず、台帳では unknown の組に入る。Codex への委譲の多くは codex-rescue を通すので、Codex の評価がモデルと effort で分かれない。

- codex-rescue のプラグインが Codex をどの引数で起動するかを確かめる
- `~/.codex/config.toml` の `model` と `model_reasoning_effort` が実際に使われるなら、CLI がそこから埋める案を検討する

## route を週枠の消費に合わせて改める

次の session で、Document Workflow の spec から始める（2026-10-29 に利用者が決めた）。扱う案は 3 つある。

- **予想で判定する**: 今の route は、使用率がペースの線を超えたかだけを見る。2026-10-29 は Claude の週枠を 3 時間で 9% 使ったが、線を超えるのは約 6 時間後の見込みで、それまで route は何も示さなかった。usage-line が複数の session の標本から計算する「リセット時の予想」を読み、予想が 100% を超えたら ahead とする案を比べる。
- **レビュアーを route の対象に入れる**: Document Workflow のレビュアーは agent の定義で `model: sonnet` を指定していて、K3 で対象外にした。2026-10-29 の集計では、レビュアーが週枠の 13〜20% を使っていた。Claude の週枠が ahead のとき、定型のレビュアーを Codex か OpenCode に回す選択肢を検討する。外部でのレビューの質は分かっていないので、記録で確かめる。
- **余っている外部の枠を使う**: usage-budget skill は「リセットする枠は使わなければ失われる」ので、リセットが近いほど多く使ってよいと判定する。route にはこの判定が無い。2026-10-29 の OpenCode は週枠を 4% しか使わず、約 3 日後にリセットされる状態だった。リセットまでが短く線との差が大きい外部を、品質のリスクが低い種類（mechanical、triage、draft）で、規模を問わず試す候補に出す案を検討する。

## 週枠が何をどの比で数えるかを定期的に測る

2026-10-29 に、使用量を次の 2 つの方法で集計した。

- usage-line の `$.store`（`~/.claude/plugins/store/usage-line_*.json` の `samples:v1:*`）にある週枠の使用率の増え方を、同じ時間の全 session のトークン数で回帰した。トークン数は `~/.claude/projects/**/*.jsonl` の usage から、キャッシュの読み込み・書き込み・出力に分けて数えた。
  - キャッシュの読み込みの重みは、出力を 5 としたとき 0.04〜0.06 で、API の価格の比（0.1）の約半分だった。
  - 量が多いので、週枠の 4〜5 割をキャッシュの読み込みが占めていた。
  - 週枠は整数の % でしか記録されず、変数どうしが一緒に増えるので、係数は区切り方で揺れる。キャッシュの書き込みの重みは 0.9〜2.2 で、はっきりしない。
- 同じ日の 9 session を区分ごとに集計した。メインループが 7〜8 割、レビュアーが 13〜20%、その他の subagent が 7〜10% だった。

この集計を `delegation review` に組み込み、定期的に見られるようにするかを決める。2026-10-29 に `autoCompactWindow` を 300000 にしたので、数日後に同じ集計で効果を確かめる。問題が無ければ 200000 を検討する。

## 検討して見送ったこと

- **`CLAUDE_CODE_FORK_SUBAGENT=0` で subagent の完了を待つ**: 並列に呼んだレビュアーの結果が 1 回で返り、完了の通知でメインループが起きる回数が減る。2026-10-29 の 1 session では、通知で起きたリクエストの読み込みは全体の約 13% だった。読み込みの 8 割は、メインループ自身のツール呼び出しの続きだった。効果が小さく、待つ間に利用者が会話できなくなるので、入れなかった。

## 参照

- `docs/decisions/0055-delegation-ledger.md`
- ADR-0041（usage-line の予想と取得）
