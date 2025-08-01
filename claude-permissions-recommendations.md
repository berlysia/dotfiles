# Claude Permissions Template Update Recommendations

Based on analysis of 6 workspace projects compared with current `settings.json.tmpl`.

## Executive Summary
- Projects analyzed: 6
- Unique commands in projects: 87
- Commands in template: 240
- Template coverage: 72%
- Recommended additions: 8
- Recommended modifications: 3
- Recommended removals: 15

## 🟢 ADDITIONS (High Priority)

These commands are frequently used across projects but missing from the template:

### Package Manager Specifics
1. **`Bash(npm run lint:*)`** - Used in 3 projects
   - Currently only have generic `npm:*` pattern
   - Add after line 6 for explicit lint support

2. **`Bash(pnpm --filter:*)`** - Used in 3 projects
   - Monorepo workspace command support
   - Add after line 8 for pnpm monorepo operations

### Development Tools
3. **`Bash(npx @biomejs/biome:*)`** - Used in 3 projects
   - Alternative biome invocation pattern
   - Add after line 29 with other biome commands

4. **`Bash(git worktree:*)`** - Already in template (line 78) ✓

5. **`Bash(similarity-ts:*)`** - Already in template (line 154) ✓

### File Operations
6. **`Bash(timeout:*)`** - Already in template (line 146) ✓

7. **`Bash(diff:*)`** - Already in template (line 144) ✓

### MCP Tools
8. **`mcp__playwright__browser_file_upload`** - Used in 3 projects
   - Missing Playwright file upload capability
   - Add after line 233

## 🟡 MODIFICATIONS (Medium Priority)

### Overly Broad Patterns
1. **`Bash(npm:*)`** (line 6) 
   - Consider splitting into:
     ```
     "Bash(npm install:*)",
     "Bash(npm run:*)",
     "Bash(npm test:*)",
     "Bash(npm publish)", // without wildcard for safety
     ```

2. **`Bash(git:*)`** (line 59)
   - Already have specific git commands (lines 62-86)
   - Consider removing generic pattern for better control

3. **Missing file upload for Playwright**
   - Add `mcp__playwright__browser_file_upload` for complete browser automation

## 🔴 REMOVALS (Low Priority)

Commands in template but never used in any analyzed project:

### Unused Development Tools
1. **`Bash(perf:*)`** (line 117) - Performance profiling tool
2. **`Bash(7z:*)`** (line 116) - 7-zip compression
3. **`Bash(tap:*)`** (line 40) - TAP test framework
4. **`Bash(turbo:*)`** (line 45) - Turborepo (have specific turborepo)
5. **`Bash(remix:*)`** (line 54) - Remix framework

### Unused System Tools  
6. **`Bash(netstat:*)`** (line 128) - Network statistics
7. **`Bash(nslookup:*)`** (line 130) - DNS lookup
8. **`Bash(dig:*)`** (line 131) - DNS queries
9. **`Bash(scp:*)`** (line 133) - Secure copy
10. **`Bash(rsync:*)`** (line 134) - Remote sync

### Unused Package Managers
11. **`Bash(bun:*)`** (line 9) - Bun runtime
12. **`Bash(deno:*)`** (line 12-17) - All Deno commands
13. **`Bash(mise:*)`** (line 55) - Mise version manager
14. **`Bash(asdf:*)`** (line 57) - asdf version manager
15. **`Bash(rtx:*)`** (line 58) - rtx version manager

## 📋 CONSIDERATIONS (Used in 2 projects)

Monitor these for future inclusion:
- `Bash(E2E_HEADLESS=* pnpm test:e2e)` - E2E test variations
- `Bash(NODE_ENV=development pnpm build)` - Environment-specific builds
- `Bash(npx tsg:*)` - TypeScript generator tool
- `Bash(npx madge:*)` - Already in template (line 156) ✓

## 🛡️ Security Notes

1. **Force flags protection**: The hook already blocks dangerous operations
2. **Git operations**: Keep specific git commands rather than `git:*` wildcard
3. **File operations**: Current deny list properly blocks system directories

## Implementation Priority

### Immediate Actions
1. Add `Bash(npm run lint:*)` - Clear need across projects
2. Add `Bash(pnpm --filter:*)` - Monorepo support
3. Add `mcp__playwright__browser_file_upload` - Complete Playwright API

### Consider for Next Review
1. Split `Bash(npm:*)` into specific commands
2. Remove unused tools after confirming with team
3. Monitor "Considerations" section for promotion

### Template Line References
- Lines 6-9: Package managers
- Lines 24-40: Testing tools  
- Lines 59-93: Git/GitHub commands
- Lines 209-240: MCP tools