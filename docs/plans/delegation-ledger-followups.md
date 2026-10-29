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

## 参照

- `docs/decisions/0055-delegation-ledger.md`
