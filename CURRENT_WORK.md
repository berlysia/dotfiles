# TypeScript Conversion Project - Hook Scripts

## 🎯 Project Overview

Claude Codeのhook scriptsを型安全性向上のためにTypeScriptに変換するプロジェクト。

### Primary Goals
- JSON処理の型安全性確保
- 関数間契約の明確化
- 実行時エラーの防止
- 開発体験の向上

## 📋 Conversion Strategy

### Phase 1: Foundation & Core Types (P0)
**目標**: 基盤となる型定義とJSONインターフェースの確立

#### 1.1 Type Definitions
- [x] **hooks-types.ts** - 共通型定義ファイル作成
  ```typescript
  interface HookInput {
    tool_name: string;
    tool_input: ToolInput;
  }
  
  interface PermissionDecision {
    hookSpecificOutput: {
      hookEventName: "PreToolUse";
      permissionDecision: "allow" | "deny" | "ask";
      permissionDecisionReason: string;
    };
  }
  
  interface SettingsFile {
    permissions: {
      allow?: string[];
      deny?: string[];
    };
  }
  ```

#### 1.2 Core Library Conversion
- [ ] **hook-common.ts** - 基盤ライブラリのTS変換
  - JSON parsing functions with type safety
  - Configuration loading with typed interfaces
  - File system operations with proper typing

- [ ] **decision-maker.ts** - 決定ロジックのTS変換
  - Typed decision output generation
  - Enum-based decision types

### Phase 2: Pattern Matching & Security (P1)
**目標**: 複雑なロジックの型安全化

#### 2.1 Pattern Processing
- [ ] **pattern-matcher.ts** - パターンマッチングのTS変換
  - Command parsing with typed structures
  - GitIgnore-style pattern matching
  - Array operations with bounds checking

#### 2.2 Security Rules
- [ ] **dangerous-commands.ts** - セキュリティルールのTS変換
  - Typed security rule definitions
  - Command analysis with clear return types

### Phase 3: Integration & Main Entry (P2)
**目標**: メインエントリポイントの変換と統合

#### 3.1 Main Scripts
- [ ] **auto-approve-commands.ts** - メインスクリプトのTS変換
  - Integration of all typed modules
  - End-to-end type safety

- [ ] **deny-repository-outside-access.ts** - リポジトリアクセス制御
  - Path operations with Node.js types
  - Repository boundary detection

### Phase 4: Testing & Validation (P3)
**目標**: 型安全性の検証とテスト整備

#### 4.1 Type Safety Tests
- [ ] Unit tests with proper type checking
- [ ] JSON schema validation tests
- [ ] Integration tests with typed interfaces

#### 4.2 Migration Support
- [ ] Shell script wrappers for backward compatibility
- [ ] Gradual migration path documentation

## 🔧 Technical Requirements

### TypeScript Setup
```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "noImplicitReturns": true,
    "noUncheckedIndexedAccess": true
  }
}
```

### Dependencies
- `@types/node` - Node.js type definitions
- `zod` (optional) - Runtime type validation
- `tsx` - TypeScript execution (already available)

### File Structure
```
dot_claude/hooks/scripts/
├── src/
│   ├── types/
│   │   └── hooks-types.ts
│   ├── lib/
│   │   ├── hook-common.ts
│   │   ├── pattern-matcher.ts
│   │   ├── dangerous-commands.ts
│   │   └── decision-maker.ts
│   └── auto-approve-commands.ts
├── dist/ (compiled JS)
├── tests/
└── legacy/ (original .sh files)
```

## 📅 Current Status

**Active Phase**: Phase 1 - Foundation & Core Types
**Next Task**: Convert hook-common.sh to hook-common.ts

### Completed
- ✅ Complexity analysis and prioritization
- ✅ Type safety value assessment
- ✅ Project planning and task breakdown
- ✅ TypeScript infrastructure setup
- ✅ Core type definitions (hooks-types.ts)

### In Progress
- 🔄 hook-common.ts conversion

### Upcoming
- ⏳ decision-maker.ts conversion
- ⏳ pattern-matcher.ts conversion

## 🎯 Success Metrics

### Type Safety Goals
- Zero `any` types in production code
- Full JSON structure typing
- Complete function parameter typing
- Runtime type validation for external inputs

### Quality Goals
- All existing tests passing with TS versions
- New type-specific tests added
- Backward compatibility maintained
- Performance equivalent or better

## 📝 Notes

### Key Insights from Analysis
1. **Highest Value**: JSON processing and inter-module contracts
2. **Keep jq**: External tool performance is acceptable
3. **Phase Approach**: Gradual conversion starting with types and foundations
4. **Test Coverage**: Extensive existing test suite (1,070 lines) to validate conversions

### Design Decisions
- Maintain existing functionality exactly
- Prioritize type safety over performance optimization
- Use strict TypeScript configuration
- Keep shell script interfaces for compatibility