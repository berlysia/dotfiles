# S3 デプロイ移行手順（hash normalizer 変更時）

hash の正規化を変えるときに読む。要約は SKILL.md「S3 デプロイ移行手順（hash normalizer 変更時）」にある。

hash 正規化を変更すると、旧 normalizer で承認済の進行中成果物は marker hash が変わり deny される。新規セッションで以下を実装再開前に完了する:

1. `bun run test` で hash parity（`document-hash.test.ts` の legacy↔new 境界 + `document-workflow-guard.test.ts` の統合経路）が両方緑であることを確認する。
2. 進行中成果物の `<!-- auto-review: ... -->` の hash を新 normalizer で再算出して書き換える。
3. `plan-review.cache.json`（plan と同ディレクトリ）を削除して誤 skip を防ぐ。
4. 1→2→3 完了前に実装を再開しない。

現行設計では正規化を変更しない方針なので、この手順は将来 normalizer を変える場合の備えである。
