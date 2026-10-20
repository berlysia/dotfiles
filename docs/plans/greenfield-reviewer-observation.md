# Followup: greenfield-perspective-reviewer 観測ログ蓄積

ADR-0004 で「Open observation items」として残した観測項目を、実運用で蓄積・振り返るための準備タスク。現状は「N≥5 plan で behavior を観察する」と書いてあるだけで、観測の記録方法・保存場所・振り返りのトリガーが決まっていない。

## 観測項目

- plan.md `Alternative Approaches (Greenfield View)` セクションが「白紙案 = 差分最小案」と機械的に記述されているか
- greenfield reviewer の output 傾向（全肯定／全否定／指摘 1〜3 割の想定レンジ）
- intent-alignment-triage で aligned 分類された割合
- behavior tuning が必要な兆候（極端な挙動）

## 決めること

- 記録の最小スキーマ（plan へのリンク、reviewer output の verdict、triage 後の adopted/excluded 件数）
- 保存場所（`docs/observations/`、`.tmp/`、既存 ADR への追記のどれか）
- N=5 達成時の振り返り（ADR-0004 の追記か新 ADR か）

## 判断軸

- **軽さ**: 手作業で 5 plan 分を記録できる程度の負担。自動化スクリプトは作らない
- **検索性**: 後で振り返るときに plan ごとの greenfield reviewer 指摘を辿れること
- **永続性**: `.tmp/` ではなく `docs/` 配下が望ましい（GC 対象外）

N=5 達成までは自然に発生した plan を待つ。今すぐ plan を作って観測する必要はない。

## 参照

- ADR: `docs/decisions/0004-greenfield-perspective-reviewer.md`
- 関連エージェント: `home/dot_claude/agents/greenfield-perspective-reviewer.md`
