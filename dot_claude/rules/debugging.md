# Debugging Guidelines

**Note**: These principles apply to all programming languages. Examples use TypeScript, but the methodology is universal.

## Read Complete Error Messages

**Focus on the FIRST error, not the last.**

- **TypeScript compile errors**: First error is usually the root cause
- **Cascading failures**: Subsequent errors are often side effects
- **Command**: Use `2>&1 | head -50` or `2>&1 | less`, NOT `| tail`

## Suspect Recent Changes First

When something stops working:

- If it worked in Task N and broke in Task N+1, your Task N+1 code is likely wrong
- Don't modify working configurations without strong evidence
- Use `git stash` / `git stash pop` to isolate the problem

## Root Cause Analysis (5 Whys)

**Avoid symptomatic fixes.**

- ❌ Bad: "tsc not found" → Change package.json scripts
- ✅ Good: "tsc not found" → Check full error → Find type error → Fix types
- Ask "why" 5 times to reach root cause
- Symptomatic fixes create technical debt

## Incremental Debugging

Step-by-step verification process:

1. Capture full error: `command 2>&1 | tee error.log`
2. Focus on first error message
3. Form hypothesis about root cause
4. Verify hypothesis (check files, run tests)
5. Apply minimal fix
6. Rebuild/retest with original configuration
7. Repeat until resolved

## Protect Working Configurations

- Don't change build scripts, configs that previously worked
- If change is necessary, document why original decision was wrong
- Verify behavior before and after change

## Use logic-validator Proactively

Before:
- Changing working configurations
- Applying symptomatic fixes without root cause analysis
- Assuming without evidence

Ask: "Is this reasoning logically sound?"

## Example - TypeScript Build Error

```bash
# ❌ Wrong approach
pnpm build 2>&1 | tail -20
# See: "tsc: not found"
# Conclusion: Need to fix package.json scripts

# ✅ Correct approach
pnpm build 2>&1 | head -50
# See: "error TS2307: Cannot find module '@/types'"
# → Root cause: Missing type definitions
# → Fix: Add proper import paths or type declarations
# → Rebuild with original package.json
```
