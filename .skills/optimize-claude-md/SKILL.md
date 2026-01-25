---
name: optimize-claude-md
description: Analyze and optimize CLAUDE.md files for quality improvements and token reduction. Supports analysis-only, simplification-only, or full optimization modes. Use when asked to "review", "optimize", "simplify", "improve", "check", or "reduce tokens" in CLAUDE.md.
context: fork
---

# Optimize CLAUDE.md

This Skill analyzes CLAUDE.md files for quality, suggests improvements based on Claude Code best practices, and simplifies content to reduce token usage.

## Usage

```
/optimize-claude-md [mode] [level] [target]
```

**Modes:**
- `analyze`: Quality analysis and improvement recommendations only
- `simplify`: Token reduction through simplification
- `full`: Both analysis and simplification (default)

**Levels** (for simplify/full mode):
- `conservative`: Careful simplification (50-70% reduction)
- `aggressive`: Bold simplification (70-85% reduction, recommended)
- `extreme`: Maximum reduction (85-95% reduction)

**Targets:**
- (none): Both project and global CLAUDE.md
- `project`: Project CLAUDE.md only
- `global`: Global CLAUDE.md only

**Examples:**
```
/optimize-claude-md                           # Full optimization, aggressive, both
/optimize-claude-md analyze                   # Analysis only
/optimize-claude-md simplify conservative     # Conservative simplification
/optimize-claude-md full aggressive project   # Full optimization, project only
```

## When to Use This Skill

Trigger this Skill when the user asks to:
- "Review my CLAUDE.md"
- "Optimize project instructions"
- "Simplify CLAUDE.md to reduce tokens"
- "Improve my CLAUDE.md"
- "Check if my CLAUDE.md follows best practices"
- "Update CLAUDE.md structure"
- "Reduce CLAUDE.md token usage"

## Workflow Selection

Based on the mode parameter, follow the appropriate workflow:

### Mode: analyze
1. Locate CLAUDE.md files
2. Analyze structure (organization, specificity, modularity)
3. Generate improvement report
4. Provide specific examples
5. Consider modularity suggestions

### Mode: simplify
1. Locate CLAUDE.md files
2. Identify simplification opportunities
3. Apply simplification rules (Rule 1 & 2)
4. Present proposals with rationale
5. Request user approval
6. Apply approved simplifications

### Mode: full (default)
Execute both `analyze` and `simplify` workflows in sequence.

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

## Simplification Targets (for simplify/full mode)

### Remove Redundant Descriptions
- Duplicate explanations
- Overly detailed explanations
- Obvious content descriptions
- Excessive example lists

### Structure Optimization
- Merge unnecessary sections
- Flatten hierarchy
- Simplify lists
- Streamline bullet points

### Expression Compression
- Long sentences → short sentences
- Multiple sentences → single sentence
- Descriptive expressions → keywords
- Minimize examples

### Technical Information Consolidation
- Merge command examples
- Simplify configuration items
- Summarize development rules
- Compress checklists

### Step 4.5: Apply Simplification Rules

When proposing simplifications, follow these critical rules:

#### Rule 1: Explain Every Simplification

For each proposed change, provide:
- **Why simplifiable**: Specific reason (inferable, redundant, duplicate)
- **Preserved**: Critical decision-making information retained
- **Removed**: Only verbose explanations or implementation details
- **Evidence**: Quote showing removed content is non-critical

**Example format**:
```
**Section**: Worktree Management
**Why**: Implementation details inferable from command name
**Preserved**: Protection behavior (uncommitted/unpushed)
**Removed**: Auto-creates, uses existing (automatic behavior)
**Evidence**: "Auto-creates branch from current" ← user doesn't decide this
```

#### Rule 2: Identify Behavioral Constraints

**NEVER simplify** content that serves as:

1. **Explicit lists**: Commit types, allowed values, prohibited patterns
   - Example: Conventional commit type list prevents custom type invention

2. **Constraint definitions**: "Only use X", "Never do Y"
   - Example: "Only link to git-tracked files" defines allowed behavior

3. **Annotated examples**: Annotations like "← why" clarify intent
   - Example: "スキルを作りたい ← Skill development requires Claude Code knowledge"

4. **Decision matrices**: Tables showing when to use what
   - Example: Tool comparison tables, workflow selection guides

**Preservation examples**:
- ✅ Keep: Commit type list (9 items) → prevents `feat2`, `bugfix`, etc.
- ✅ Keep: "NOT for user code" with examples → defines boundary
- ✅ Keep: Multiple examples showing pattern diversity → improves judgment
- ❌ Simplify: "Auto-creates branch if needed" → implementation detail

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

### User Approval Required

Before proposing simplifications:
1. **Present proposals with rationale**: Show before/after with explanation
2. **Group by category**: Related simplifications together
3. **User approval required**: Each category must be explicitly approved
4. **Rejected items**: Keep original if user rejects simplification

**Approval format**:
```
Proposal X: [Category name] (N lines reduced)
- Why: [Reason]
- Preserved: [Critical info]
- Removed: [Non-critical content]

Apply? (User must approve)
```
