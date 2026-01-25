---
name: optimizing-claude-md
description: Analyze CLAUDE.md files for quality and suggest improvements based on Claude Code best practices. Use when asked to "review", "optimize", "improve", "check", or "update" CLAUDE.md or project instructions.
context: fork
---

# Optimizing CLAUDE.md

This Skill analyzes CLAUDE.md files and project instructions for quality, then provides actionable improvements based on Claude Code official best practices.

## When to Use This Skill

Trigger this Skill when the user asks to:
- "Review my CLAUDE.md"
- "Optimize project instructions"
- "Improve my CLAUDE.md"
- "Check if my CLAUDE.md follows best practices"
- "Update CLAUDE.md structure"

## Analysis Workflow

Follow these steps to analyze and improve CLAUDE.md files:

### Step 1: Locate CLAUDE.md Files

Check all memory locations in this order:
1. Project memory: `./CLAUDE.md` or `./.claude/CLAUDE.md`
2. User memory: `~/.claude/CLAUDE.md`
3. Project rules: `./.claude/rules/*.md`
4. Local memory: `./CLAUDE.local.md`

Read each file found and note its location in the hierarchy.

### Step 2: Analyze Structure

Evaluate each file against these criteria:

**Organization:**
- Is information structured with markdown headings?
- Are related items grouped logically?
- Is there unnecessary verbosity?

**Specificity:**
- Are instructions specific and actionable?
- Are there vague phrases like "properly" or "good quality"?
- Do examples show concrete patterns?

**Modularity:**
- Should large files be split into `.claude/rules/`?
- Would path-specific rules improve relevance?
- Are there repeated patterns across files?

**See [BEST-PRACTICES.md](BEST-PRACTICES.md) for detailed evaluation criteria.**

### Step 3: Generate Improvement Report

Create a structured report with these sections:

1. **Executive Summary**: 2-3 sentences on overall quality
2. **Strengths**: What's working well
3. **Issues Found**: Specific problems with examples
4. **Recommendations**: Prioritized improvements
5. **Next Steps**: Concrete actions to take

**Report Template:**
```markdown
# CLAUDE.md Analysis Report

## Executive Summary
[Overall assessment in 2-3 sentences]

## Strengths
- [What's working well]

## Issues Found

### Issue: [Name]
**Severity:** High/Medium/Low
**Location:** [File path and section]
**Problem:** [Specific issue]
**Example:**
```
[Quote from file]
```
**Why it matters:** [Impact on Claude's behavior]

## Recommendations

### Priority 1: [High-impact improvements]
[Specific action with code example]

### Priority 2: [Medium-impact improvements]
[Specific action with code example]

### Priority 3: [Low-impact improvements]
[Specific action with code example]

## Next Steps
1. [Immediate action]
2. [Short-term action]
3. [Long-term action]
```

### Step 4: Provide Specific Examples

For each recommendation, show:
- **Before**: Current problematic text
- **After**: Improved version
- **Explanation**: Why the change helps

### Step 5: Consider Modularity

If CLAUDE.md or rules files are large or cover multiple concerns, suggest:

**Splitting into `.claude/rules/`:**
```
.claude/rules/
├── code-style.md      # Style guidelines
├── testing.md         # Test conventions
├── git-workflow.md    # Commit and PR standards
└── debugging.md       # Debugging procedures
```

**Adding path-specific rules:**
```markdown
---
paths:
  - "src/**/*.ts"
---
# TypeScript-specific guidelines
```

**Using imports for modularity:**
```markdown
See @docs/architecture.md for system design
See @~/.claude/my-preferences.md for personal settings
```

## Common Issues to Check

### 1. Vague Instructions
❌ Bad: "Write good code"
✅ Good: "Use 2-space indentation for JavaScript"

### 2. Excessive Context
❌ Bad: "Git is a version control system that..."
✅ Good: "Use conventional commits: feat/fix/refactor"

### 3. Poor Organization
❌ Bad: All instructions in one long list
✅ Good: Grouped by topic with clear headings

### 4. No Specific Examples
❌ Bad: "Follow project conventions"
✅ Good: "Match existing pattern: async function fetchData()"

### 5. Time-Sensitive Information
❌ Bad: "Use React 18 features" (will become outdated)
✅ Good: "Prefer hooks over class components"

### 6. Missing Modularity Opportunities
❌ Bad: 2000-line CLAUDE.md with everything
✅ Good: Core in CLAUDE.md, specifics in .claude/rules/

### 7. Adding Information Not in Original
❌ Bad: Inferring missing details and adding them as recommendations
✅ Good: Only reorganize, clarify, or simplify existing information

**Critical Rule:** Optimization means improving how existing information is presented, NOT adding new rules or information that wasn't there before. If something is unclear or seems incomplete, ask the user rather than assuming their intent.

**Example of violation:**
- Original: "Use `${projectRoot}/.tmp` for temporary files"
- ❌ Bad recommendation: Add "Use `~/.tmp` for system-wide temporary files"
- ✅ Good recommendation: Clarify "When in a project, use `${projectRoot}/.tmp`"

## Best Practices Reference

For comprehensive best practices, see [BEST-PRACTICES.md](BEST-PRACTICES.md).

Key principles:
- **Be Specific**: Replace vague terms with concrete examples
- **Use Structure**: Organize with headings and bullet points
- **Review Periodically**: Update as project evolves
- **Modularize**: Split large files into focused rule files
- **Progressive Disclosure**: Link to detailed docs when needed

## Output Format

Always provide:
1. **Analysis Report**: Structured assessment with examples
2. **Priority Matrix**: What to fix first and why
3. **Action Plan**: Step-by-step implementation guide

Make all recommendations actionable with specific text to add, remove, or modify.
