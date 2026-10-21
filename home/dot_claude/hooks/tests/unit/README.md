# Hook Implementations Unit Tests

Claude Code の hook 実装の単体テスト。Node.js 組み込みの test runner（`node:test`）と `node:assert` を使う。

テスト対象は `home/dot_claude/hooks/implementations/` と `home/dot_claude/hooks/lib/` の実装。

## Running Tests

```bash
# All unit tests
bun run test

# heavy tests (tests that start git, and tests that are slow under load)
bun run test:heavy

# Individual test file
node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/session.test.ts
```

実時間を測る（perf）テストは `home/dot_claude/hooks/tests/perf/` に置き、`bun run test:perf` で実行する。git を起動するテストと負荷に弱いテストは `home/dot_claude/hooks/tests/heavy/` に置き、`bun run test:heavy` で実行する。unit のテストは git を起動しない。詳細は `home/dot_claude/hooks/tests/README_TESTING.md` の「node:test のスイート（unit / perf / heavy）」を参照。

## Test Structure

Each test file follows this pattern:

```typescript
#!/usr/bin/env node --test

import { describe, it, beforeEach, afterEach } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert";

describe("component behavior", () => {
  beforeEach(() => {
    // Setup test environment
  });

  afterEach(() => {
    // Cleanup
  });

  describe("feature group", () => {
    it("should do something", () => {
      // Test implementation
    });
  });
});
```

## Key Testing Patterns

1. **Behavioral Testing** - Tests focus on observable behavior rather than implementation details
2. **Error Resilience** - All hooks are tested to ensure they handle errors gracefully
3. **File System Simulation** - Tests use temporary directories to simulate file operations
4. **Context Mocking** - Hook context objects are simulated to test success/error paths
5. **Parallel Operations** - Tests verify that async operations execute correctly in parallel

## Contributing

When adding new tests:

1. Follow the existing test structure
2. Test happy paths, edge cases, and error scenarios
3. Use descriptive test names
4. Clean up resources in afterEach hooks
5. Run all tests to ensure no regressions
