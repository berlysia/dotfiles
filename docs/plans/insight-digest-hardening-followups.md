# insight-digest hardening follow-ups

2026-06-10 の incident (insight-digest-notice.test.ts の backup/restore が並行テスト実行 + 定期蒸留とレースし、実物の `~/.claude/logs/insights/insight-digest.md` を削除、SessionStart 通知が 2 日間サイレント停止) の修正 (commit 4b4d889) から派生した未着手の改善候補。

各項目は独立に Document Workflow へ載せられる粒度。着手時は本ファイルから該当項目を削除する。

## 1. 実パス定数 import の恒常ゲート

- **内容**: `home/dot_claude/hooks/lib/insight-digest.ts` が export する実パス定数 (`DIGEST_PATH` / `ACK_PATH` / `LOGS_DIR` 等) をテストコードが import することを CI で恒常的に防ぐ
- **背景**: 4b4d889 は既存の唯一の違反を除去し grep で一回限り検証したが、将来の新規テストが再 import する経路は機構的に塞がれていない (greenfield-perspective-reviewer 指摘の accepted limitation)
- **論点**: このリポジトリには TS lint ルールを置く設定基盤が現状なく、oxlint カスタムルール / ast-grep / CI grep step のいずれで実現するかのツーリング判断を伴う

## 2. `appendInsightRecord` の ensureDir 責務不整合

- **内容**: `appendInsightRecord(record, path = INSIGHTS_JSONL)` が `ensureDir(LOGS_DIR)` を呼ぶため、tmpdir パス注入時も実 `~/.claude/logs/insights` を mkdir しうる。`ensureDir(dirname(path))` に揃える
- **背景**: 4b4d889 で `writeAckMs` に適用した修正と同種 (architecture-strategist 指摘)。`writeStampAt` は既に `ensureDir(dirname(path))` 形

## 3. 通知経路の fail-silent 改善

- **内容**: digest 不在 + `state.json` の `since_last_ack > 0` のとき、SessionStart で「digest が見当たらない。`/insight-digest force` で再生成を」と案内する
- **背景**: `getUnreadDigestPreview` は digest 不在・読取失敗を silent null に変換するため、incident 時に通知停止へ誰も気づけなかった。観測性の設計判断を伴う

## 4. ヒューリスティッククラスタリングの見直し

- **内容**: insight の重複判定が正規化全文ハッシュの完全一致のみで、累積 518 件全てが count=1。digest の "Top Recurring Topics" が再発トピック検出として機能していない
- **論点**: 類似度ベースのクラスタリング (例: 字句 n-gram / embedding) はコスト・複雑性のトレードオフ評価が必要

## 5. 蓄積 insight の棚卸し

- **内容**: 復旧した digest を `/insight-digest` でレビューし、518 件の skill 化 / rules 追記 / CLAUDE.md 追記 / 廃棄を判断する (運用タスク、コード変更なし)
