# Hook Implementations Unit Tests

This directory contains unit tests for the Claude Code hook implementations using Node.js built-in test runner (`node:test`) and assertion library (`node:assert`).

## Test Coverage

The following implementations have unit tests:

### ✅ Tested Components

1. **session.test.ts** - Tests for SessionStart event logging
   - Log entry structure validation
   - Directory creation handling
   - Error scenarios
   - Hook context simulation

2. **command-logger.test.ts** - Tests for PostToolUse event logging
   - Bash command logging to history and structured logs
   - Edit/Write tool logging
   - Log file format validation
   - Error handling

3. **notification.test.ts** - Tests for Stop/Notification/Error events
   - Event type handling
   - Parallel execution behavior
   - Audio notification messages
   - Cleanup behavior

4. **user-prompt-logger.test.ts** - Tests for UserPromptSubmit event logging
   - Log entry structure
   - Directory creation
   - Error scenarios
   - Concurrent write handling

### 🔄 Components Needing Tests

The following implementations still need unit tests:
- `auto-approve.ts` - Complex pattern matching logic
- `auto-format.ts` - File formatting automation
- `block-package-json-tsx.ts` - File modification blocking
- `block-tsx.ts` - TSX file blocking
- `deny-node-modules.ts` - Node modules access control
- `deny-repository-outside.ts` - Repository boundary enforcement
- `speak-notification.ts` - VoiceVox audio notifications
- `web-fetch-guardian.ts` - Web fetch security

## Running Tests

### Run All Unit Tests
```bash
# Using npm script
npm run test:unit

# Direct execution
./dot_claude/hooks/tests/unit/run-tests.sh

# Individual test file
node --test dot_claude/hooks/tests/unit/session.test.ts
```

### Test Output
Tests provide:
- ✅ Pass/fail status for each test file
- Total test count and results
- Detailed failure information when tests fail
- Colorized output for better readability

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

## Coverage Goals

- **Current Coverage**: ~33% of implementations have tests (4/12 files)
- **Target Coverage**: 80%+ for all critical hook implementations
- **Focus Areas**: Error handling, edge cases, concurrent operations

## Contributing

When adding new tests:
1. Follow the existing test structure
2. Test happy paths, edge cases, and error scenarios
3. Use descriptive test names
4. Clean up resources in afterEach hooks
5. Run all tests to ensure no regressions