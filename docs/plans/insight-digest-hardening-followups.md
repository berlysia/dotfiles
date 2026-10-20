# insight-digest hardening follow-ups

insight-digest の堅牢化で未着手の改善候補。テストが実物の `~/.claude/logs/insights/insight-digest.md` に触れて SessionStart 通知が止まる事故を、二度と起こさないための項目である。

各項目は独立に Document Workflow へ載せられる粒度。着手時は本ファイルから該当項目を削除する。

## 1. 実パス定数 import の恒常ゲート

- **内容**: `home/dot_claude/hooks/lib/insight-digest.ts` が export する実パス定数 (`DIGEST_PATH` / `ACK_PATH` / `LOGS_DIR` 等) をテストコードが import することを CI で恒常的に防ぐ
- **背景**: 既存の違反は除去して grep で一回限り検証しただけで、将来の新規テストが再 import する経路は機構的に塞がれていない (accepted limitation)
- **論点**: このリポジトリには TS lint ルールを置く設定基盤が現状なく、oxlint カスタムルール / ast-grep / CI grep step のいずれで実現するかのツーリング判断を伴う

## 2. 通知経路の fail-silent 改善

- **内容**: digest 不在 + `state.json` の `since_last_ack > 0` のとき、SessionStart で「digest が見当たらない。`/insight-digest force` で再生成を」と案内する
- **背景**: `getUnreadDigestPreview` は digest 不在・読取失敗を silent null に変換するため、通知が止まっても誰も気づけない。観測性の設計判断を伴う

## 3. ヒューリスティッククラスタリングの見直し

- **内容**: insight の重複判定が正規化全文ハッシュの完全一致のみで、digest の "Top Recurring Topics" が再発トピックを拾えているかが疑わしい。件数は書かず、再計測してから判断する
- **論点**: 類似度ベースのクラスタリング (例: 字句 n-gram / embedding) はコスト・複雑性のトレードオフ評価が必要

## 4. 蓄積 insight の棚卸し

- **内容**: 蓄積した insight を `/insight-digest` でレビューし、skill 化 / rules 追記 / CLAUDE.md 追記 / 廃棄を判断する (運用タスク、コード変更なし)
