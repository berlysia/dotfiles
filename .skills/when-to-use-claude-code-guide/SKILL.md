---
name: when-to-use-claude-code-guide
description: Guide for when to invoke claude-code-guide agent. Use when questions are about Claude Code features ("How do I...", "Does Claude Code support...", "Can Claude..."), configuration (settings, CLAUDE.md, MCP), workflows (Plan Mode, skills, subagents), IDE integration (VS Code, JetBrains), troubleshooting Claude Code issues, or Claude API/Agent SDK usage. NOT for implementing features, debugging user code, or general programming.
---

# When to Use claude-code-guide Agent

## Quick Decision

```
Claude Code itself?     → claude-code-guide ✅
User's code/project?    → Main conversation ❌
General programming?    → Main conversation ❌
```

## 呼び出すべきシナリオ

### ✅ USE claude-code-guide

**Feature Discovery**:
- "Claude Codeで並列タスクを実行できるか？"
- "MCP serverの設定方法は？"
- "利用可能なキーボードショートカットは？"
- "extended thinking modeの使い方は？"

**Configuration & Setup**:
- "permissions.jsonの設定方法は？"
- "CLAUDE.mdにはどんな内容を書くべきか？"
- "カスタムスキルの作成方法は？"
- ".claude/settings.jsonの設定項目は？"

**Workflow & Best Practices**:
- "Plan Modeの推奨ワークフローは？"
- "subagentとskillの使い分けは？"
- "コンテキストウィンドウの効率的な管理方法は？"

**Integration**:
- "VS Codeとの連携設定は？"
- "GitHub Actionsで自動コミットするには？"
- "Slackボットとして使うには？"

**Troubleshooting Claude Code**:
- "skillが呼び出されない理由は？"
- "MCP serverが接続できない原因は？"
- "permission errorの解決方法は？"
- "hookの問題をデバッグするには？"

**Claude API/SDK**:
- "Agent SDKでカスタムエージェントを作るには？"
- "Claude APIのtool useの実装方法は？"
- "computer use toolの使い方は？"

### ❌ DO NOT USE

**User Code Implementation**:
- "このReactコンポーネントが動かない" → メイン会話
- "payment処理機能を実装して" → メイン会話
- "このバグを修正して" → メイン会話

**Project-Specific Issues**:
- "pnpm buildがTypeScriptエラーで失敗する" → メイン会話
- "テストが失敗している" → メイン会話
- "ビルドが遅い" → メイン会話

**General Programming**:
- "TypeScriptでバイナリサーチを実装するには？" → メイン会話
- "ReactのuseEffectの使い方は？" → メイン会話
- "OAuthの仕組みは？" → メイン会話

## Trigger Keywords

**Immediate invocation**:
- Question patterns: "How do I...", "What is...", "Can Claude Code...", "Does Claude Code support..."
- Configuration: "permissions.json", "CLAUDE.md", "MCP server", "settings.json"
- Workflows: "Plan Mode", "subagent", "skill", "context window"
- Integration: "VS Code", "JetBrains", "GitHub Actions", "Slack bot"

**Context-dependent**:
- "Show me an example..." → MCP usage ✅ | React component ❌
- "Help me set up..." → VS Code integration ✅ | Next.js project ❌
- "How does this work..." → Permission system ✅ | OAuth flow ❌

## 使用例

### ✅ Good: Feature Discovery

```
User: "I want to run parallel tasks. Does Claude Code support this?"

Action: Invoke claude-code-guide
Reason: Claude Code capability question

Response will explain:
- Git worktrees
- Subagents
- Background bash
```

### ✅ Good: Configuration Help

```
User: "特定のディレクトリへのアクセスを制限したい"

Action: Invoke claude-code-guide
Reason: Claude Code configuration question

Response will explain:
- permissions.json syntax
- Wildcard patterns
- Examples
```

### ✅ Good: Workflow Question

```
User: "skillとsubagentの違いは？どう使い分ける？"

Action: Invoke claude-code-guide
Reason: Claude Code feature selection

Response will explain:
- Use cases for each
- Trade-offs
- Examples
```

### ❌ Bad: Implementation Help

```
User: "code complexity分析スキルを作りたい"

Action: メイン会話で対応
Reason: Custom development, not Claude Code usage

Should help with:
- Skill implementation
- Code writing
- Testing
```

### ❌ Bad: Project Debugging

```
User: "My pnpm build is failing with TypeScript error"

Action: メイン会話で対応
Reason: Project-specific build issue

Should:
- Read error messages
- Fix TypeScript issues
- Debug build
```


## 呼び出し不要な場合の対処

| 質問カテゴリ | 対処方法 |
|------------|---------|
| ユーザーコード実装 | メイン会話で直接実装支援 |
| プロジェクト固有のバグ | メイン会話でデバッグ |
| 一般プログラミング | メイン会話で説明 |
| カスタム開発 | メイン会話で開発支援 |

