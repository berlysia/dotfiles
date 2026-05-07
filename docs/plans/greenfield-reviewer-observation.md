# Followup: greenfield-perspective-reviewer 観測ログ蓄積

ADR-0004 で「Open observation items」として残した観測項目を、実運用で蓄積・振り返るための準備タスク。

## 起動プロンプト（次セッション用、コピペ可）

```
ADR-0004 で導入した greenfield-perspective-reviewer の運用観測タスクを進めたい。
現状は「N≥5 plan で behavior を観察する」と書いてあるだけで、観測の記録方法・
保存場所・振り返りのトリガーが決まっていない。

このセッションのゴール:
- 観測対象（plan ごとの記録項目）の最小スキーマを決める
- 保存場所（docs/observations/ or .tmp/ or 既存 ADR への追記）を決める
- 観測の振り返り条件（N=5 達成時に何をするか）を決める
- 上記を簡潔な docs/observations/README.md（または同等の場所）として残す

参照:
- @docs/decisions/0004-greenfield-perspective-reviewer.md
- @docs/plans/greenfield-reviewer-observation.md
- @home/dot_claude/agents/greenfield-perspective-reviewer.md

注意:
- 観測ログ自体を高機能なデータベースにしないこと。手作業で plan 5 個分を
  記録する程度の軽量な仕組みで十分
- N=5 達成までは「自然に発生した plan」を待つ。今すぐ plan を作って観測する
  必要はない
```

## 背景

ADR-0004 で導入した greenfield-perspective-reviewer は、以下の観測項目を
持つが、記録方法が未定義:

- plan.md `Alternative Approaches (Greenfield View)` セクションが「白紙案 = 差分最小案」と機械的に記述されているか
- greenfield reviewer の output 傾向（全肯定／全否定／指摘 1〜3 割の想定レンジ）
- intent-alignment-triage で aligned 分類された割合
- behavior tuning が必要な兆候（極端な挙動）

## 期待される成果物

- `docs/observations/` ディレクトリの設計（または別の保存場所の決定）
- plan ごとの記録最小スキーマ（YAML/JSON/markdown のどれか、フィールド定義）
- 振り返りトリガーの定義（N=5 達成時に何をするか、ADR 追記 or 新 ADR）
- 軽量な実装（手書き運用前提、自動化は後回し）

## 判断軸

- **軽さ**: 手作業で 5 plan 分を記録できる程度の負担。自動化スクリプトは作らない
- **検索性**: 後で振り返るときに plan ごとの greenfield reviewer 指摘を辿れること
- **永続性**: `.tmp/` ではなく `docs/` 配下が望ましい（GC 対象外）

## 想定される approach

- `docs/observations/greenfield-reviewer/` ディレクトリ
- 各 plan に対し `<session-id>.md` の最小レコード（plan へのリンク、reviewer
  output の verdict、triage 後の adopted/excluded 件数）
- N=5 で `docs/observations/greenfield-reviewer/retrospective.md` に集計
- 結果次第で ADR-0004 の追記または新 ADR

別案として「観測専用 doc を作らず、各 plan.md にコメント追記」「ADR-0004
に直接観測ログを蓄積」なども検討。どれが軽いかはセッション内で判断する。

## 参照

- ADR: `docs/decisions/0004-greenfield-perspective-reviewer.md`
- Implementation: commit `44eb918`
- 関連エージェント: `home/dot_claude/agents/greenfield-perspective-reviewer.md`
