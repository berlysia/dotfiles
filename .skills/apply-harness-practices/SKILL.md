---
name: apply-harness-practices
description: "Analyze a project's harness maturity and guide staged adoption of Harness Engineering best practices (quality loops, safety gates, linters, CLAUDE.md optimization)."
context: inherit
---

# Apply Harness Practices

プロジェクトのハーネス成熟度を分析し、Harness Engineeringベストプラクティスを段階的に適用するガイド。

## MVH Checklist

判断基準。Phase 2 で現状と照合する。優先度: Stage 1 = HIGH, Stage 2 = MEDIUM, Stage 3 = LOW。

### Stage 1: 即座に適用

- [ ] **CLAUDE.md/AGENTS.md**: 存在し、50行以下、ポインタ型（コマンド・禁止事項・パス参照のみ、説明文なし）
- [ ] **PostToolUse品質ループ**: ファイル編集のたびリンター/フォーマッター自動実行する hooks 設定
- [ ] **リンター設定**: 言語に適したリンターが設定済み
- [ ] **フォーマッター設定**: 自動フォーマッターが設定済み

### Stage 2: 短期改善

- [ ] **Pre-commitフック**: リンター・フォーマッター・型チェックをコミット前に実行
- [ ] **Stop Hook品質ゲート**: テスト通過を完了条件化（Stop イベントで検証）
- [ ] **計画→承認→実行ワークフロー**: Plan Mode または Document Workflow を利用
- [ ] **最初のADR**: `docs/decisions/` に不変の設計判断を記録

### Stage 3: 中期高度化

- [ ] **カスタムリンター**: エラーメッセージに WHY / FIX / EXAMPLE を含む修正指示
- [ ] **PreToolUse Safety Gates**: 機密ファイル編集ブロック、リンター設定保護
- [ ] **ADRとリンタールール紐づけ**: 各ルールが ADR を参照し、理由を機械的に追跡可能
- [ ] **ガベージコレクション**: 定期的なコードベース逸脱検知エージェント

## Workflow

### Phase 1: 現状分析

以下の2レイヤーを調査する。Glob/Grep/Read を使い、存在確認と内容を把握する。

**ユーザーレベル** (~/.claude/):

1. **Hooks設定**: `~/.claude/settings.json` の hooks 設定を確認。イベント名（PostToolUse, PreToolUse, Stop 等）と hook 名を把握する。コマンド引数の詳細は不要
2. **CLAUDE.md**: `~/.claude/CLAUDE.md` の有無、行数、形式（ポインタ型 or 説明型）
3. **ルールファイル**: `~/.claude/rules/` ディレクトリの存在とファイル一覧

`~/.claude/settings.json` が存在しない場合は「ユーザーレベル設定なし」と記録する。

**プロジェクトレベル** (対象プロジェクト):

1. **言語検出**: package.json / go.mod / Cargo.toml / pyproject.toml / requirements.txt
2. **CLAUDE.md / AGENTS.md**: 有無、行数、内容（ポインタ型 or 説明型）
3. **Hooks設定**: `.claude/settings.json` と `.claude/settings.local.json` の両方を確認。settings.local.json は gitignore された個人設定の場合がある — チーム共有か個人レベルかを判断に含める
4. **リンター**: biome.json, oxlint の設定, .eslintrc\*, ruff.toml, .golangci.yml, clippy.toml 等
5. **フォーマッター**: prettier, biome, black/ruff format, gofmt, rustfmt 等
6. **Pre-commit**: .husky/, lefthook.yml, .pre-commit-config.yaml
7. **テスト**: テストランナー設定、テストファイルの存在
8. **ADR**: docs/decisions/, docs/adr/

分析結果を以下のフォーマットで出力する:

```
## 現状分析

**言語**: TypeScript (pnpm)

### ユーザーレベル (~/.claude/)
**CLAUDE.md**: あり (35行、ポインタ型)
**Hooks**: PostToolUse quality-loop, Stop completion-gate 等 15個
**ルール**: ~/.claude/rules/ に 5ファイル

### プロジェクトレベル (.claude/)
**CLAUDE.md**: あり (68行、説明型)
**Hooks**: PostToolUse 2個 (Task, TodoWrite)
**リンター**: biome.json あり (基本設定)
**フォーマッター**: biome (format)
**Pre-commit**: husky あり (lint-staged)
**テスト**: vitest
**ADR**: なし
```

### Phase 2: ギャップ分析

MVH Checklist の各項目について、Phase 1 の結果（ユーザーレベル・プロジェクトレベル両方）と照合する。

分類基準:
- **ユーザーレベルで実装済み** = `~/.claude/settings.json` に該当 hook/設定が存在する
- **プロジェクトレベルで実装済み** = `.claude/settings.json` に該当設定が存在する
- **未実装** = どちらにも存在しない
- 同一項目が両レイヤーに存在する場合は両方に記載し、二重実行の警告を付記する

出力フォーマット:

```
## ギャップ分析結果

### ユーザーレベルで実装済み
- [x] PostToolUse品質ループ — ~/.claude/settings.json で全プロジェクトに適用中
- [x] Stop Hook品質ゲート — completion-gate で実装済み
- [x] PreToolUse Safety Gates — file-access-guard, linter-config-guard で実装済み

> **Note**: ユーザーレベル設定は全プロジェクトに自動適用されます。
> チーム開発でプロジェクトにも追加する場合、同じ hook が二重実行されるため、
> ユーザーレベルの設定を無効化するか、プロジェクト側で差分のみを設定してください。

### プロジェクトレベルで実装済み
- [x] リンター設定 (biome.json)
- [x] フォーマッター (biome format)
- [x] Pre-commitフック (husky + lint-staged)

### 未実装（優先度順）
1. **CLAUDE.mdスリム化** [HIGH] — プロジェクト CLAUDE.md 68行 → 50行以下に
2. **最初のADR** [MEDIUM] — docs/decisions/ 未作成
3. ...
```

ユーザーに結果を提示し、どの Stage から着手するか選択を求める。プロジェクトへの追加判断はスキルが行わず、ユーザーに委ねる。

### Phase 3: 適用ガイド

選択された Stage の未実装項目について、言語別テンプレートを提示する。

各項目で以下を含める:

- 設定ファイルの具体例（プロジェクトの言語・ツールに合わせて調整）
- 実装手順（1-3ステップ）
- 期待される効果
- **レイヤー状況**: ユーザーレベルで実装済みの場合はその旨と二重実行リスクを明記

ユーザーレベルで実装済みの項目をプロジェクトに追加する場合の注意テンプレート:

```
⚠️ **二重実行リスク**: この項目はユーザーレベル (~/.claude/settings.json) で実装済みです。
hooks は全レイヤーで独立実行されるため、プロジェクトにも設定すると二重実行されます。
対処法:
- (A) ユーザーレベルの該当 hook を無効化し、プロジェクトに移行する
- (B) プロジェクトにはユーザーレベルにない差分のみ設定する
- (C) ソロ開発ならプロジェクト追加不要（ユーザーレベルで十分）
```

**実装はユーザー承認の上でメインエージェントが実行する。** スキルはガイドの提示まで。

## Language-Specific Recommendations

### TypeScript / JavaScript

| 項目           | 推奨ツール                          |
| -------------- | ----------------------------------- |
| リンター       | Oxlint（高速）+ Biome               |
| フォーマッター | Biome format または Prettier        |
| 型チェック     | tsc --noEmit / tsgo                 |
| Pre-commit     | lefthook または husky + lint-staged |

PostToolUse hooks 例:

```json
{
  "type": "command",
  "event": "PostToolUse",
  "command": "biome check --write $CLAUDE_FILE_PATH 2>&1 | head -20",
  "matcher": { "tool_name": "Edit|Write|MultiEdit" }
}
```

### Python

| 項目                      | 推奨ツール                |
| ------------------------- | ------------------------- |
| リンター + フォーマッター | Ruff（一択、900+ ルール） |
| 型チェック                | mypy / pyright            |
| Pre-commit                | pre-commit フレームワーク |

PostToolUse hooks 例:

```json
{
  "type": "command",
  "event": "PostToolUse",
  "command": "ruff check --fix $CLAUDE_FILE_PATH && ruff format $CLAUDE_FILE_PATH 2>&1 | head -20",
  "matcher": { "tool_name": "Edit|Write|MultiEdit" }
}
```

### Go

| 項目           | 推奨ツール                            |
| -------------- | ------------------------------------- |
| リンター       | golangci-lint（50+ リンター並列実行） |
| フォーマッター | gofmt / goimports                     |
| Pre-commit     | lefthook                              |

### Rust

| 項目           | 推奨ツール                    |
| -------------- | ----------------------------- |
| リンター       | Clippy（pedantic レベル推奨） |
| フォーマッター | rustfmt                       |
| Pre-commit     | lefthook                      |

### Other

言語固有のツールが不明な場合の一般原則:

- **リンター**: 言語エコシステムで最も高速なものを選択（Rust 製ツール優先）
- **フォーマッター**: エディタ統合があるものを選択
- **Pre-commit**: lefthook（言語非依存、高速）

## Stage Templates

### Stage 1: CLAUDE.md テンプレート

50行以下のポインタ型 CLAUDE.md:

```markdown
# Project Name

## Commands

- **Test**: `<test command>`
- **Lint**: `<lint command>`
- **Typecheck**: `<typecheck command>`
- **Build**: `<build command>`

## Architecture

- [See ADR directory](docs/decisions/)
- [See project structure](src/)

## Rules

- No `any` types
- Run lint before commit
- Tests must pass before completion

## Prohibitions

- Never hardcode secrets
- Never suppress lint errors
- Never modify lint/format config without ADR
```

### Stage 2: Stop Hook テンプレート

```json
{
  "type": "command",
  "event": "Stop",
  "command": "<test command> 2>&1 | tail -5; echo \"exit:$?\"",
  "blocking": true
}
```

### Stage 3: カスタムリンター エラーメッセージ形式

```
ERROR: [何が間違っているか]
  [ファイル:行番号]
  WHY: [なぜこのルール。ADR-XXXX 参照]
  FIX: [具体的修正手順]
  EXAMPLE:
    // Bad: ...
    // Good: ...
```
