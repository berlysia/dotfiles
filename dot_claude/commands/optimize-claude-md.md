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
