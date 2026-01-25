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
  - Functions: verb-object with intent clarity
    - Async/side-effects: `fetchUserData`, `createUser`, `updateProfile`
    - Synchronous/pure: `getUserName`, `calculateTotal`, `formatDate`
  - Types: PascalCase interfaces (`UserProfile` not `IUserProfile`)
- **コメント方針**:
  - **WHYを説明**: コードの理由・背景・制約を記述する
  - **型システム尊重**: TypeScript型定義から自明な情報はコメントで重複しない
  - **ビジネスロジック重視**: ドメイン知識・設計決定・トレードオフの説明に集中
  - **差分ではなく現状を説明する**: 変更適用後のコードが何をしているかに対して説明する
- **Error handling**: Handle all error paths explicitly
  - Use typed errors (Error subclasses or discriminated unions)
  - Log errors with context before propagating
  - Avoid silent failures or generic catch-all handlers
- **Performance**: Parallelize independent operations with Promise.all()

### Developer Experience
- Minimize developer friction
- Thorough planning before implementation
- Root cause analysis for bug fixes
- Create scripts for repetitive tasks
- **Decision transparency**: When changing approach mid-task, explicitly explain the reasoning and new plan before proceeding
- **Structured decision requests**: When asking users to make decisions, follow this framework:
  1. **Context**: Explain the situation and why a decision is needed
  2. **Decision criteria**: Define what factors should guide the choice (performance, maintainability, risk, time, etc.)
  3. **Options**: List all viable alternatives clearly (usually 2-4 options)
  4. **Trade-offs**: For each option, document:
     - Advantages (evaluated against decision criteria)
     - Disadvantages (evaluated against decision criteria)
     - Risks and unknowns
     - Implementation effort/time estimate (if relevant)
  5. **Recommendation** (if applicable): Suggest preferred option with clear rationale based on decision criteria
  6. **Question**: Explicitly ask for the user's decision

  **Example structure:**
  ```
  ## Decision Required: [Topic]

  **Context:** [Why this decision is needed]

  **Decision Criteria:**
  - [Criterion 1]: [Why it matters]
  - [Criterion 2]: [Why it matters]

  **Options:**

  ### Option A: [Name]
  - Advantages: [evaluated against criteria]
  - Disadvantages: [evaluated against criteria]
  - Risk level: [Low/Medium/High with explanation]
  - Effort: [estimate if relevant]

  ### Option B: [Name]
  - [Same structure]

  **Recommendation:** [Option X] because [rationale based on criteria]

  **Your Decision:** Which approach would you like to take?
  ```

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

**Emergency checklist:**
1. Read FIRST error: `command 2>&1 | head -50`
2. Suspect recent changes (git stash to test)
3. Apply 5 Whys (not symptomatic fixes)

See `@~/.claude/rules/debugging.md` for detailed procedures.

## TypeScript Project Standards

**For new projects**, see `@~/.claude/rules/typescript-new-project.md` for recommended tooling, testing, and type safety standards.

**For existing projects**, respect the project's established tool choices.

## Security Requirements
- **Prohibited**: Hardcoded secrets, unvalidated inputs, suppressed errors
- **Required**:
  - Input validation (type checks, sanitization, bounds checking)
  - Environment variables for secrets (never hardcode)
  - Structured logging with severity levels (error/warn/info/debug)
  - All tests and lints passing

## Git Workflow

### Worktree
- **Create**: `git-worktree-create <branch>` → `.git/worktree/`
- **Cleanup**: `git-worktree-cleanup` (保護: uncommitted/unpushed)

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
- **similarity-ts**: `similarity-ts [--threshold N] src/`
- **git-sequential-stage**: `git-sequential-stage -patch=X -hunk=Y` (by `/commit`)

## Temporary Files
- **Prefer** `${projectRoot}/.tmp` for temporary files and work-in-progress documentation
- **Avoid** `/tmp` unless no other suitable location exists - it's outside the project scope and can cause path confusion
- Ensure `.tmp/` is gitignored in the project

## Knowledge Management

### ドキュメント構造
- WIP: `.tmp/docs/` (gitignored)
- Done: `docs/` (git tracked), `docs/decisions/` (ADRs)

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
- **Claude Code guidance**: claude-code-guide agent for Claude Code-specific questions
- **Key scenarios**: Plan mode completion, architecture decisions, debugging blocks

See `@~/.claude/rules/external-review.md` for detailed usage patterns and examples.

### When to Use claude-code-guide Agent

**For Claude Code questions**:
- Features and capabilities ("How do I...", "Can Claude...", "Does Claude support...")
- Configuration (settings.json, CLAUDE.md, MCP servers, permissions)
- Workflows (Plan Mode, skills, subagents, hooks, context management)
- **Skill development** (SKILL.md syntax, triggering conditions, design patterns, best practices)
- IDE integration (VS Code, JetBrains, keyboard shortcuts)
- Troubleshooting Claude Code itself (permission errors, hook issues, skill not triggering)
- Claude API/Agent SDK usage (tool use, computer use, custom agents)

**NOT for user code**:
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