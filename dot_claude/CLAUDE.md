# Development Guidelines

## Language
- Japanese for discussion, English for code

## Workflow
1. **Explore** - Understand codebase and requirements
2. **Plan** - Design solution with clear steps
3. **Code** - Implement following best practices
4. **Commit** - Clean, meaningful commits

## Task Completion Protocol

作業停止前の必須チェック：
- 元のタスクが完全に達成されたか
- テスト・ビルドが成功しているか
- 明示的に依頼されたコミットが完了しているか

**継続すべきケース**:
- Tests/build failing → Fix and retry
- Clear next steps → Execute them
- Explicit commit request → Complete it
- Ambiguous requirements → Ask clarification

**Critical**: Never unilaterally lower user expectations or disable steering.

## Development Principles

### Code Quality
- **Formatting**: Use project formatter (prettier/oxlint as configured)
- **Naming**:
  - Variables: descriptive nouns (`userData` not `data`)
  - Functions: verb-object (`fetchUserData` not `getUserData`)
  - Types: PascalCase interfaces (`UserProfile` not `IUserProfile`)
- **コメント方針**:
  - **WHYを説明**: コードの理由・背景・制約を記述する
  - **型システム尊重**: TypeScript型定義から自明な情報はコメントで重複しない
  - **ビジネスロジック重視**: ドメイン知識・設計決定・トレードオフの説明に集中
  - **差分ではなく現状を説明する**: 変更適用後のコードが何をしているかに対して説明する
- **Error handling**: Comprehensive error handling and parallelization

### Developer Experience
- Minimize developer friction
- Thorough planning before implementation
- Root cause analysis for bug fixes
- Create scripts for repetitive tasks
- **Decision transparency**: When changing approach mid-task, explicitly explain the reasoning and new plan before proceeding

### Architecture
- **Libraries**: Minimal dependencies, prefer built-ins
- **Design**: Respect existing architecture, maintain unidirectional dependency graph
- **Documentation**: Record significant decisions in ADRs (Architecture Decision Records)
- **Patterns**: Abstract repeated patterns, use tools like `similarity-ts` for detection, `knip` for cleaning

### Testing
- Follow t-wada's TDD style
- Strict Red-Green-Refactor cycle
- Tests must pass before commits

### Debugging

See `@~/.claude/rules/debugging.md` for comprehensive debugging procedures.

**Quick reference:**
- Focus on FIRST error (`2>&1 | head -50`)
- Suspect recent changes when Task N works but Task N+1 fails
- Use 5 Whys for root cause analysis

## TypeScript Project Standards

**For new projects**, see `@~/.claude/rules/typescript-new-project.md` for recommended tooling, testing, and type safety standards.

**For existing projects**, respect the project's established tool choices.

## Security Requirements
- **Prohibited**: Hardcoded secrets, unvalidated inputs, suppressed errors
- **Required**: Input validation, environment variables, comprehensive logging, passing lint/test

## Git Workflow

### Worktree Management
- **Create**: `git-worktree-create <branch-name>`
  - Location: `.git/worktree/` directory
  - Auto-creates branch from current if needed
  - Uses existing local/remote branches when available
  
- **Cleanup**: `git-worktree-cleanup`
  - Safely removes completed worktrees
  - Preserves worktrees with uncommitted changes or unpushed commits
  - Auto-prunes after deletion

### Commit Standards

#### 基本原則
- All tests and lints must pass
- Clear, descriptive commit messages
- Break large changes into logical, atomic commits

#### コミットメッセージ生成（自動適用）
コミット作成時は、以下の原則を**自動的に**適用する：

**Conventional Commit形式**:
```
<type>(<scope>): <description>

[optional body - explain WHY, not WHAT]

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
```

**タイプ選択**:
- `feat`: 新機能追加
- `fix`: バグ修正
- `refactor`: 動作変更なしのコード改善
- `test`: テスト追加・修正
- `docs`: ドキュメント更新
- `chore`: メンテナンス（依存関係更新等）
- `perf`: パフォーマンス改善
- `style`: コードフォーマット（動作変更なし）
- `build`: ビルドシステム変更
- `ci`: CI/CD設定変更

**スコープ決定**: 影響を受けるモジュール・コンポーネント名（auth, api, hooks等）

**説明文の書き方**:
- 現在形・命令形（add, fix, update - not added, fixed, updated）
- 小文字開始、末尾ピリオドなし
- 具体的かつ簡潔に（72文字以内目安）

**本文が必要な場合**:
- 複数ファイル/コンポーネントに影響
- 非自明な実装判断
- Breaking changes
- マイグレーション手順

#### ワークフロー使い分け
- **単純な変更**: 上記原則を適用してコミット作成
- **複雑な変更**（複数種類の変更が混在）: `/commit` コマンドで自動分割・分析

## Useful Commands

### Code Analysis
- **similarity-ts**: Detect code duplication
  - `similarity-ts src/`
  - `similarity-ts --threshold 0.8 src/`

### Git Tools
- **git-sequential-stage**: Stage specific hunks for semantic commits
  - `git-sequential-stage -patch="changes.patch" -hunk="file.go:1,3,5"`
  - Used by `/commit` command for precise staging

## Temporary Files
- When in a project, use `${projectRoot}/.tmp` for temporary files and work-in-progress documentation
- Ensure `.tmp/` is gitignored in the project 

## Knowledge Management

### 推奨ドキュメント構造
プロジェクトの `.claude/CLAUDE.md` で定義することを推奨。標準的な構造：
- `.tmp/docs/` - 作業中の一時ファイル（gitignore）
- `docs/decisions/` - Architecture Decision Records (ADR)
- `docs/` - その他の完成したドキュメント

### 記録の原則
- **作業中**: `.tmp/` 配下に配置（gitignore推奨）
- **完成品**: `docs/` 配下に配置（git管理）
- **重要な意思決定**: ADRとして記録

### ドキュメント内リンクの原則

**Rule:** Committed documentation (README, docs/) must only link to git-tracked files.

**Prohibited links:**
- Gitignored paths (`.tmp/`, `node_modules/`, build outputs)
- Temporary plan files
- Absolute or environment-specific paths

**Solution:** Move essential information to `docs/` before linking.

```
# ❌ Bad
See [design notes](.tmp/docs/design-notes.md)

# ✅ Good
See [design notes](docs/design-notes.md)
```

**Critical Rule:**
Always gather evidence (read files, run tests, check actual state) before making decisions. Use **logic-validator** proactively to catch assumption-based reasoning.

## External Review & Validation

Use validation tools for logic verification and external perspective:
- **Logic validation**: logic-validator agent, `/logic-validation` skill
- **External review**: `/codex-review`, `/self-review` skills, Codex MCP
- **Key scenarios**: Plan mode completion, architecture decisions, debugging blocks

See `@~/.claude/rules/external-review.md` for detailed usage patterns and examples.

## claude-code-guide Agent Usage

**When to use claude-code-guide agent**:
- Claude Code features and capabilities ("How do I...", "Can Claude...", "Does Claude support...")
- Configuration (settings.json, CLAUDE.md, MCP servers, permissions)
- Workflows (Plan Mode, skills, subagents, hooks, context management)
- **Skill development** (SKILL.md syntax, triggering conditions, design patterns, best practices)
- IDE integration (VS Code, JetBrains, keyboard shortcuts)
- Troubleshooting Claude Code itself (permission errors, hook issues, skill not triggering)
- Claude API/Agent SDK usage (tool use, computer use, custom agents)

**DO NOT use for**:
- User application code implementation or debugging
- Project-specific build/test/runtime issues
- General programming questions

**Examples**:
- ✅ "skillとsubagentの使い分けは？"
- ✅ "MCP serverの設定方法は？"
- ✅ "code complexity分析スキルを作りたい" ← Skill development requires Claude Code-specific knowledge
- ✅ "SKILL.mdの書き方とベストプラクティスは？"
- ❌ "このTypeScriptエラーを修正して"
- ❌ "Reactコンポーネントを実装して"
- ❌ "payment APIのバグを直して"