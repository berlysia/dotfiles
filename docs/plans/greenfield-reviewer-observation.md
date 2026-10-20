# Followup: greenfield-perspective-reviewer 観測ログ蓄積

greenfield-perspective-reviewer が incremental bias を抑えたかを、実運用の plan で観測して判定するための項目と記録方法を決めるタスク。ADR-0004 は達成の判定法をこの文書に委ねている。観測の記録方法・保存場所・振り返りのトリガーはまだ決まっていない。

## 観測項目

デプロイ後の最初の N 個（N ≥ 5）の Document Workflow の plan を対象にする。

- plan の `Alternative Approaches (Greenfield View)` が「白紙案 = 差分最小案」と機械的に書かれていないか。両案が異なる内容で比べられているか
- greenfield reviewer の出力の傾向。全肯定が続けば検出力の不足、全否定が続けばノイズの過多。想定は 1〜3 割が指摘で、残りは肯定
- 指摘が intent-alignment-triage で aligned になる割合。極端に低ければ役割が合っておらず、極端に高ければ scope-justification-reviewer との重複を疑う
- 想定の範囲を外れたら、指示文の修正か運用の見直しをする

## 決めること

- 記録の最小スキーマ（plan へのリンク、reviewer output の verdict、triage 後の adopted/excluded 件数）
- 保存場所（`docs/observations/`、`.tmp/`、既存 ADR への追記のどれか）
- N=5 達成時の振り返り（ADR-0004 の Amendments に足すか、新しい ADR にするか）

## 判断軸

- **軽さ**: 手作業で 5 plan 分を記録できる程度の負担。自動化スクリプトは作らない
- **検索性**: 後で振り返るときに plan ごとの greenfield reviewer 指摘を辿れること
- **永続性**: `.tmp/` ではなく `docs/` 配下が望ましい（GC 対象外）

N=5 達成までは自然に発生した plan を待つ。今すぐ plan を作って観測する必要はない。

## 参照

- ADR: `docs/decisions/0004-greenfield-perspective-reviewer.md`
- 関連エージェント: `home/dot_claude/agents/greenfield-perspective-reviewer.md`
