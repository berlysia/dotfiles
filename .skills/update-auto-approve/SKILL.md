---
name: update-auto-approve
description: Analyze PermissionRequest decision logs and improve auto-approve configuration across all layers. Covers settings.json patterns, static rule engine, LLM evaluator prompt, and tests. Use when asked to "update auto-approve", "improve permissions", "reduce unnecessary asks", or "optimize permission rules".
---

# Update Auto-Approve Workflow

PermissionRequest の決定ログを分析し、不要な ask 判定を削減するための全レイヤー改善を行う。

## 対象ファイルと役割

| Layer | ファイル (chezmoi管理) | 役割 |
|-------|----------------------|------|
| 0/1 | `dot_claude/.settings.permissions.json` | Claude Code組み込みのallowリスト（MCP, Skill, ファイルパス） |
| 2a | `dot_claude/hooks/implementations/permission-auto-approve.ts` | 静的ルール（正規表現パターンマッチ） |
| 2b | `dot_claude/hooks/implementations/permission-llm-evaluator.ts` | LLM評価（SYSTEM_PROMPT） |
| Test | `dot_claude/hooks/tests/unit/permission-auto-approve.test.ts` | Layer 2aのユニットテスト |

## ワークフロー

### Phase 1: ログ分析

決定ログを分析して不要な ask 判定を特定する。

```bash
# スクリプトで自動分析（dry-run）
bun run dot_claude/scripts/update-auto-approve.ts --dry-run --verbose

# 直近N日間のみ分析する場合
bun run dot_claude/scripts/update-auto-approve.ts --dry-run --verbose --since 7d
```

スクリプト出力に加え、以下の手動分析も行う：

1. `~/.claude/logs/decisions.jsonl` と ローテーション分（`.jsonl.YYYY-MM-DDTHH-MM-SS`）を読む
2. `decision: "ask"` のエントリを抽出
3. ツール種別ごとに分類:
   - **正常な ask**: `AskUserQuestion`, `ExitPlanMode` → 改善不要
   - **MCP ツール**: `mcp__*` → Layer 0/1 の allow 追加候補
   - **Skill**: `Skill(*)` → Layer 0/1 の allow 追加候補
   - **Bash コマンド**: 安全なコマンドが ask されている → Layer 2a 改善候補
   - **LLM 誤判定**: Layer 2b のプロンプト改善候補

### Phase 2: Layer 0/1 改善 (`.settings.permissions.json`)

**対象**: MCP ツール、Skill、ファイルパスパターン

1. 未登録の MCP ツールを特定し、`allow` に追加
   - 既存パターンとの一貫性を確認（例: `mcp__playwright__*` が個別登録なら同様に）
   - `mcp__chrome-devtools__*` のようなワイルドカードパターンも検討

2. 未登録の Skill を特定し、`Skill(name)` 形式で追加
   - インストール済みスキルの確認: `ls ~/.claude/skills/`

3. 重複・タイポの修正

### Phase 3: Layer 2a 改善 (`permission-auto-approve.ts`)

**対象**: `SAFE_BASH_PATTERNS`, `READ_ONLY_TOOLS`, `DANGEROUS_PATTERNS`

#### 判断原則（重要）

- **SAFE_BASH_PATTERNS に追加してよいもの**: 正規表現の静的マッチだけで安全性を保証できるコマンド
- **Layer 2b に委ねるべきもの**: 引数の意味解析が必要なコマンド

| コマンド | 判断 | 理由 |
|---------|------|------|
| `mkdir`, `touch` | Layer 2a で allow | ディレクトリ/ファイル作成は安全 |
| `env`, `printenv` | Layer 2a で allow | 環境変数の読み取りのみ |
| `lsof` | Layer 2a で allow | ポート/プロセス情報の読み取りのみ |
| `git add/commit/stash/...` | Layer 2a で allow | 通常の開発ワークフロー |
| `npx/pnpx/bunx` | Layer 2a で allow | settings.json でも許可済み |
| `cp`/`mv` | **Layer 2b** | コピー先/移動先パスの検証が正規表現では不可能 |
| `git apply` | **Layer 2b** | パッチ内容の検証が不可能 |
| `eslint --fix` / `prettier --write` | **Layer 2b** | ファイル書き換えあり、対象パスの検証が必要 |
| `node -e` | **Layer 2b** | 任意コード実行、内容の判断が必要 |
| `kill` | **Layer 2b** | PID 1 等の危険なケースを静的に区別できない |

#### 注意事項

- `DANGEROUS_PATTERNS` は `SAFE_BASH_PATTERNS` より先に評価される
- 危険パターンに該当するコマンドは safe パターンに追加しても deny される
- テストで「uncertain であるべきケース」が正しく uncertain のままか必ず検証する

### Phase 4: Layer 2b 改善 (`permission-llm-evaluator.ts`)

**対象**: `SYSTEM_PROMPT` 定数

改善すべきセクション:

1. **CONTEXT**: Claude Code の自己管理ディレクトリ（`~/.claude/`, `~/.config/claude-companion/`）の説明
2. **ALLOW**: LLM に許可させるべき操作の追加
3. **CONDITIONAL ALLOW**: Layer 2a で扱えない操作の判断基準
   - `cp`/`mv`: コピー先がプロジェクト内 or `~/.claude/` なら allow
   - `git apply`: `--cached` でプロジェクト内ステージングなら allow
   - `eslint`/`prettier` `--fix`/`--write`: プロジェクト内ファイルなら allow
   - `node -e`: ファイル操作がプロジェクト内なら allow
   - `kill`: ポートクリーンアップパターン (`lsof -ti:PORT | xargs kill`) なら allow
4. **IMPORTANT DISTINCTIONS**: LLM の典型的な誤分類パターンの訂正
   - `~/.claude/tasks/` は「sensitive」ではない
   - MCP ツール名はプロンプトインジェクションではない
   - `git diff | git apply` は標準的な git ワークフロー

### Phase 5: テスト更新

`permission-auto-approve.test.ts` に以下を追加:

1. **新しい safe コマンド**: Layer 2a に追加したパターンごとにテスト
2. **セキュリティ境界テスト**: uncertain であるべきコマンドが uncertain のままであることを検証
   - Layer 2b に委ねたコマンド（cp, mv, git apply 等）
   - DANGEROUS_PATTERNS との境界ケース
3. **新しい READ_ONLY_TOOLS**: 追加したツールごとにテスト

```bash
# テスト実行
node --test dot_claude/hooks/tests/unit/permission-auto-approve.test.ts
```

### Phase 6: 適用

```bash
# chezmoi で反映
chezmoi apply

# 確認: settings.json が更新されたか
cat ~/.claude/settings.json | jq '.permissions.allow | length'
```

## チェックリスト

- [ ] ログ分析で不要 ask を特定した
- [ ] Layer 0/1: 未登録の MCP/Skill を追加した
- [ ] Layer 2a: 安全なパターンのみ SAFE_BASH_PATTERNS に追加した
- [ ] Layer 2a: 危険な操作は Layer 2b に委ねる判断をした
- [ ] Layer 2b: SYSTEM_PROMPT の CONDITIONAL ALLOW を更新した
- [ ] Layer 2b: IMPORTANT DISTINCTIONS を更新した
- [ ] テスト: 新パターンのテストを追加した
- [ ] テスト: セキュリティ境界テストを追加した
- [ ] テスト: 全テスト通過を確認した
- [ ] chezmoi apply で反映した

## 注意事項

- **deny/dangerous パターンは変更しない**: 追加はすべて明示的 allow のみ
- **保守的アプローチ**: 迷ったら Layer 2b に委ねる（誤承認より誤 ask が安全）
- **テスト駆動**: パターン追加前にテストで動作確認する
- **1-2 日後の再検証**: 変更後 `decisions.jsonl` を再分析して効果を確認する
