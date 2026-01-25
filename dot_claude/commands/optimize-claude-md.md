---
title: "Optimize CLAUDE.md"
description: "Drastically simplify CLAUDE.md to reduce token usage"
---

# Optimize CLAUDE.md Command

Drastically simplifies CLAUDE.md to significantly reduce token count.

## Usage

```
/optimize-claude-md [level] [target]
```

## Examples

```
/optimize-claude-md
/optimize-claude-md aggressive
/optimize-claude-md minimal project
/optimize-claude-md conservative global
```

## Optimization Levels

- **minimal**: Keep only essential information
- **aggressive**: Bold simplification (recommended)
- **conservative**: Careful simplification
- **extreme**: Reduce to the limit

## Target Options

- **none (default)**: Both project and global
- `project`: Project CLAUDE.md only
- `global`: Global CLAUDE.md only

## Simplification Targets

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

## Simplification Strategy

### Before (冗長)

```markdown
## Development Principles

### Coding Style

- Delegate style-level settings to formatters
- Keep naming clear and minimal
- Actively use language idioms
- Comments explain "why", not "what"
- Document technical core aspects (algorithms, design decisions, trade-offs) in detail
```

### After (簡約)

```markdown
## Dev Rules

- Use formatters, clear naming, language idioms
- Comments: why not what
- Document: algorithms, decisions, trade-offs
```

## Reduction Targets

- **50-70% reduction**: conservative
- **70-85% reduction**: aggressive (recommended)
- **85-95% reduction**: extreme

Analyzes current CLAUDE.md and executes maximum simplification while preserving information value.

## Simplification Rules

### Rule 1: Explain Every Simplification

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

### Rule 2: Identify Behavioral Constraints

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

### Rule 3: Approval Before Execution

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
