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

対象プロジェクトの以下を調査する。Glob/Grep/Read を使い、存在確認と内容を把握する。

**調査項目**:

1. **言語検出**: package.json / go.mod / Cargo.toml / pyproject.toml / requirements.txt
2. **CLAUDE.md / AGENTS.md**: 有無、行数、内容（ポインタ型 or 説明型）
3. **Hooks設定**: `.claude/settings.json` と `.claude/settings.local.json` の両方を確認。settings.local.json は gitignore された個人設定の場合がある — チーム共有か個人レベルかを判断に含める
4. **リンター**: biome.json, oxlint の設定, .eslintrc*, ruff.toml, .golangci.yml, clippy.toml 等
5. **フォーマッター**: prettier, biome, black/ruff format, gofmt, rustfmt 等
6. **Pre-commit**: .husky/, lefthook.yml, .pre-commit-config.yaml
7. **テスト**: テストランナー設定、テストファイルの存在
8. **ADR**: docs/decisions/, docs/adr/

分析結果を以下のフォーマットで出力する:

```
## 現状分析

**言語**: TypeScript (pnpm)
**CLAUDE.md**: あり (187行、説明型)
**Hooks**: settings.json に PostToolUse なし
**リンター**: biome.json あり (基本設定)
**フォーマッター**: biome (format)
**Pre-commit**: husky あり (lint-staged)
**テスト**: vitest
**ADR**: なし
```

### Phase 2: ギャップ分析

MVH Checklist の各項目について、Phase 1 の結果と照合する。

出力フォーマット:

```
## ギャップ分析結果

### 実装済み
- [x] リンター設定 (biome.json)
- [x] フォーマッター (biome format)
- [x] Pre-commitフック (husky + lint-staged)

### 未実装（優先度順）
1. **PostToolUse品質ループ** [HIGH] — hooks 設定なし。ファイル編集のたびリンター自動実行が必要
2. **CLAUDE.mdスリム化** [HIGH] — 現在187行、説明型。50行以下のポインタ型に圧縮が必要
3. **Stop Hook品質ゲート** [MEDIUM] — テスト通過を完了条件にする Stop hook が未設定
4. ...
```

ユーザーに結果を提示し、どの Stage から着手するか選択を求める。

### Phase 3: 適用ガイド

選択された Stage の未実装項目について、言語別テンプレートを提示する。

各項目で以下を含める:
- 設定ファイルの具体例（プロジェクトの言語・ツールに合わせて調整）
- 実装手順（1-3ステップ）
- 期待される効果

**実装はユーザー承認の上でメインエージェントが実行する。** スキルはガイドの提示まで。

## Language-Specific Recommendations

### TypeScript / JavaScript

| 項目 | 推奨ツール |
|------|-----------|
| リンター | Oxlint（高速）+ Biome |
| フォーマッター | Biome format または Prettier |
| 型チェック | tsc --noEmit / tsgo |
| Pre-commit | lefthook または husky + lint-staged |

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

| 項目 | 推奨ツール |
|------|-----------|
| リンター + フォーマッター | Ruff（一択、900+ ルール） |
| 型チェック | mypy / pyright |
| Pre-commit | pre-commit フレームワーク |

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

| 項目 | 推奨ツール |
|------|-----------|
| リンター | golangci-lint（50+ リンター並列実行） |
| フォーマッター | gofmt / goimports |
| Pre-commit | lefthook |

### Rust

| 項目 | 推奨ツール |
|------|-----------|
| リンター | Clippy（pedantic レベル推奨） |
| フォーマッター | rustfmt |
| Pre-commit | lefthook |

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
