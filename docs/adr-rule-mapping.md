# ADR-Linter Rule Mapping

ADR と自動リンタールールの対応関係を管理する。

## 対応表

| ADR | ルール | リンターシステム | 概要 |
|-----|--------|-----------------|------|
| [ADR-0002](decisions/0002-hooks-typescript-bun.md) | `no-console-log` | oxlint jsPlugin | hooks内のconsole.log禁止 |
| [ADR-0002](decisions/0002-hooks-typescript-bun.md) | `no-process-exit` | oxlint jsPlugin | hooks内のprocess.exit禁止 |
| (なし) | `no-any-cast` | oxlint jsPlugin | `as any` キャスト禁止 |
| (なし) | `no-hardcoded-home` | custom-rules | ハードコードされたホームディレクトリパス禁止 |

## リンターシステム

- **oxlint jsPlugin** (`custom-lint-plugin.mjs`): AST解析ベース、JS/TS向け
- **custom-rules** (`home/dot_claude/hooks/lib/custom-rules.ts`): 正規表現ベース、shell/template向け

## 新ADR作成チェックリスト

新しいADRを作成する際、以下を確認する:

- [ ] ADRの決定事項をコードで自動検証できるか
- [ ] 検証可能な場合、適切なリンターシステムにルールを追加する
  - JS/TS の AST パターン → oxlint jsPlugin (`custom-lint-plugin.mjs`)
  - テキストパターン（shell/template）→ custom-rules (`hooks/lib/custom-rules.ts`)
- [ ] ルールの `message` に `ADR: docs/decisions/XXXX-*.md` を含める
- [ ] この対応表を更新する
