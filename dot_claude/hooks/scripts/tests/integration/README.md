# TypeScript Hook Integration Tests

## Overview

This directory contains comprehensive integration tests for all TypeScript-converted Claude Code hook scripts.

## Test Structure

```
tests/integration/
├── test-data/           # Structured JSON test inputs
│   ├── auto-approve-allow.json
│   ├── block-tsx-package-json-deny.json
│   ├── block-tsx-package-json-allow.json
│   ├── block-tsx-tsnode-deny.json
│   ├── block-tsx-tsnode-allow.json
│   ├── deny-node-modules-deny.json
│   └── deny-node-modules-allow.json
├── run-ts-hook-tests.sh # Main test runner script
└── README.md           # This file
```

## Running Tests

```bash
cd dot_claude/hooks/scripts
./tests/integration/run-ts-hook-tests.sh
```

## Test Coverage

### ✅ Tested TypeScript Scripts
- `auto-approve-commands.ts` - Permission decision making
- `block-tsx-package-json.ts` - Package.json tsx/ts-node blocking
- `block-tsx-tsnode.ts` - Command-line tsx/ts-node blocking
- `deny-node-modules-write.ts` - Node modules write protection

### Test Scenarios
- **Allow scenarios**: Commands/operations that should succeed (exit code 0)
- **Deny scenarios**: Commands/operations that should be blocked (exit code 1-2)
- **Edge cases**: Complex JSON structures and pattern matching

## Test Data Format

All test data follows the Claude Code hook input format:

```json
{
  "tool_name": "ToolName",
  "tool_input": {
    "parameter": "value"
  },
  "session_id": "optional_session_identifier"
}
```

## Maintenance

When adding new TypeScript hooks:
1. Add corresponding test data files in `test-data/`
2. Update `run-ts-hook-tests.sh` with new test cases
3. Ensure both allow and deny scenarios are tested
4. Document expected exit codes and behavior

## Integration with CI/CD

This test suite can be integrated into continuous integration pipelines to ensure TypeScript hook compatibility and functionality preservation during updates.