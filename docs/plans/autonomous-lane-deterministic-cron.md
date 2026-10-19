# skill-upstreams の持ち越した課題

`skill-upstreams Sync`（派生スキルの上流変更を週次で検知して Issue にする cron）の作業で範囲の外に回した課題。

## 自律レーン憲章に「agent を持たない決定的 cron」の扱いを書くか

`skill-upstreams Sync` は cron で上流を能動的に調べ、Issue を開閉する。
LLM を持たない決定的スクリプトなので、`rules/autonomous-lane.md` の push レーン（agent の自律実行）には当たらないと判断し、憲章は変えなかった。
ただし憲章本文には「agent を持たない cron」を除外する基準が無く、「能動 discovery 心臓（cron triage）は Phase 2 以降」の文言と読み合わせると境界が曖昧になる。

決めること:

- 憲章に「LLM を持たない決定的 cron は push レーンの対象外。ただし C2（可逆）・C3（設計面非接触）・untrusted content の非 prompt gate は準用する」の 1 行を足すか
- 足すなら、準用の条件をどのテストで機械的に守るか（`tests/check-skill-upstreams/run.sh` の workflow 境界チェックが前例）

## マージ後の確認

- `workflow_dispatch` で `skill-upstreams Sync` を 1 回実行し、imozuru と koncise の Issue が 1 件ずつ開き、visual-eli の Issue が開かないことを見る（2026-10-19 の dry-run は `open imozuru` / `open koncise` / `noop visual-eli`）
- 最初の cron 実行（月曜 09:00 JST）のあと、Actions の結果を見る。失敗したときに GitHub の通知が届く設定かも確かめる
- 開いた Issue の本文に `@` が無く、ファイル一覧がコードブロックに収まっていることを見る

## 見送りの判定を見直す条件

人が見送って閉じた Issue は、上流の先頭コミットが動けば、取り込み対象外のコミットでも開き直す。
実運用でこの開き直しがノイズになったら、取り込み対象のファイルの変更集合で比べる案を見直す。
