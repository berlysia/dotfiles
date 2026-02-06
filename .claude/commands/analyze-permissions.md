# Analyze Permissions Command

Analyze and consolidate Claude permission settings across all workspace projects to identify common patterns and recommend global settings updates.

## Core Features

1. **Scan workspace projects**: Find all `.claude/settings.local.json` files
2. **Extract permissions**: Collect allow/deny rules from each project
3. **Analyze patterns**: Identify common commands used across projects
4. **Compare with template**: Analyze against current `settings.json.tmpl`
5. **Generate recommendations**: Suggest specific additions, modifications, and removals
6. **Create summary report**: Output detailed analysis with actionable updates

## Implementation Steps

### 1. Scan for settings files
```bash
find ~/workspace -name "settings.local.json" -path "*/.claude/*"
```

### 2. Parse and analyze each file
- Read JSON content
- Extract `permissions.allow` and `permissions.deny` arrays
- Count usage frequency across projects

### 3. Categorize commands
Group commands by type:
- **Build/Test**: `pnpm build:*`, `npm run test:*`, etc.
- **Code Quality**: `biome check:*`, `eslint:*`, `prettier:*`
- **Package Management**: `pnpm add:*`, `npm install:*`
- **Git Operations**: `git add:*`, `git commit:*`, `gh pr:*`
- **File Operations**: `find:*`, `ls:*`, `grep:*`, `cat:*`
- **MCP Tools**: Playwright, Context7, Readability operations

### 4. Generate recommendations
Based on frequency analysis:
- **Core commands** (used in 50%+ projects): Recommend for global settings
- **Common commands** (used in 30-50% projects): Suggest as project-type specific
- **Rare commands** (used in <30% projects): Keep in local settings

### 5. Compare with current template
Load and analyze `dot_claude/settings.json.tmpl` to:
- Identify commands already in template
- Find frequently used commands not in template
- Detect template commands rarely used in practice

### 6. Generate update recommendations
Categorize findings into:
- **ADD**: New commands to add (used in 3+ projects, not in template)
- **MODIFY**: Commands to adjust (e.g., too broad/narrow patterns)
- **CONSIDER**: Commands used in 2 projects (potential additions)
- **REMOVE**: Template commands never used in any project
- **KEEP**: Well-utilized template commands

### 7. Create comprehensive report
Output includes:
- Executive summary with key statistics
- Project-by-project breakdown
- Frequency analysis table
- Specific update recommendations for `settings.json.tmpl`
- Security considerations and warnings
- Ready-to-apply patch for template updates

## Output Format

The command generates a markdown report with:
1. **Executive Summary**
   - Total projects analyzed
   - Total unique commands found
   - Coverage percentage of template
   
2. **Update Recommendations**
   - **Additions Section**: Commands to add with justification
   - **Modifications Section**: Pattern adjustments needed
   - **Removals Section**: Unused commands to consider removing
   - **Security Notes**: Any concerning patterns found

3. **Detailed Analysis**
   - Project-by-project permission breakdown
   - Command frequency table
   - Category-based grouping

4. **Implementation Guide**
   - Specific line-by-line changes for `settings.json.tmpl`
   - Priority ranking for changes
   - Migration notes for projects

## Usage

```
/analyze-permissions [options]

Options:
  --workspace-dir <path>  Specify workspace directory (default: ~/workspace)
  --output <path>        Output file path (default: ./claude-permissions-summary.md)
  --min-frequency <n>    Minimum frequency for global recommendation (default: 3)
  --include-mcp          Include MCP tool analysis (default: true)
```

## Example Workflow

1. Run the command to analyze current workspace
2. Review the update recommendations section
3. Apply high-priority additions to `settings.json.tmpl`
4. Consider modifications for overly broad patterns
5. Evaluate removal candidates for unused commands
6. Test changes with sample projects
7. Commit template updates

## Example Output Structure

```markdown
# Claude Permissions Analysis Report

## Executive Summary
- Analyzed: 6 projects
- Unique commands: 145
- Template coverage: 78%
- Recommended additions: 12
- Recommended removals: 8

## 🟢 ADDITIONS (High Priority)

### Build Tools
- `Bash(pnpm --filter *)` - Used in 4 projects for monorepo operations
- `Bash(npm run lint *)` - Used in 3 projects for linting

### File Operations
- `Bash(touch *)` - Used in 5 projects (already in template at line 103)
- `Bash(diff *)` - Used in 3 projects for comparisons

## 🟡 MODIFICATIONS (Medium Priority)

### Overly Broad Patterns
- `Bash(npm *)` → Split into specific commands:
  - `Bash(npm install *)`
  - `Bash(npm run *)`
  - `Bash(npm test *)`

## 🔴 REMOVALS (Low Priority)

### Never Used
- `Bash(perf *)` (line 117) - No usage in any project
- `Bash(7z *)` (line 116) - No usage, consider removing

## 📋 CONSIDERATIONS (Future Additions)

### Used in 2 Projects
- `Bash(npx @biomejs/biome *)` - Biome tooling variant
- `Bash(git worktree *)` - Advanced git workflows
```

## Security Considerations

- Never auto-approve destructive commands (`rm -rf`, `sudo`)
- Validate all external communication domains
- Maintain principle of least privilege
- Regular review and cleanup of permissions
- Special attention to force flags and recursive operations