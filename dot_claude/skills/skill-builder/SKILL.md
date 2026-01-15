---
name: skill-builder
description: Guides creation of Claude Code Skills following official best practices. Use when building new Skills, improving existing Skills, or when user asks about Skill creation, structure, or best practices.
---

# Skill Builder

This Skill guides you through creating effective Claude Code Skills that follow official best practices.

## Quick Reference

- **Patterns**: See [PATTERNS.md](PATTERNS.md) for common Skill patterns
- **Checklist**: See [CHECKLIST.md](CHECKLIST.md) for quality verification
- **Examples**: See [EXAMPLES.md](EXAMPLES.md) for complete Skill examples

## Skill Creation Workflow

Copy this checklist and track your progress:

```
Skill Creation Progress:
- [ ] Step 1: Understand the use case
- [ ] Step 2: Design the Skill structure
- [ ] Step 3: Write SKILL.md with metadata and instructions
- [ ] Step 4: Add supporting files (if needed)
- [ ] Step 5: Review against quality checklist
- [ ] Step 6: Test with real scenarios
```

### Step 1: Understand the use case

**Ask these questions before writing any code:**
- What specific problem does this Skill solve?
- What context does Claude need that it doesn't already have?
- When should Claude use this Skill vs. not use it?
- What models will use this Skill? (Haiku, Sonnet, Opus)

**Document real scenarios** where this Skill would be valuable. Avoid creating Skills for hypothetical needs.

### Step 2: Design the Skill structure

Choose the appropriate structure based on complexity:

**Simple Skill (single file)**:
```
my-skill/
└── SKILL.md
```
Use when: Instructions fit under 500 lines and no utility scripts needed.

**Multi-file Skill (progressive disclosure)**:
```
my-skill/
├── SKILL.md              # Overview and quick start (<500 lines)
├── REFERENCE.md          # Detailed API docs (loaded when needed)
├── EXAMPLES.md           # Usage examples (loaded when needed)
└── scripts/
    └── helper.py         # Utility script (executed, not loaded)
```
Use when: Detailed documentation exceeds 500 lines or you have utility scripts.

**Design principles:**
- Keep SKILL.md under 500 lines for optimal performance
- Use progressive disclosure for complex Skills
- Bundle utility scripts for zero-context execution
- Keep file references one level deep (no nested references)

### Step 3: Write SKILL.md with metadata and instructions

#### Required YAML frontmatter

```yaml
---
name: skill-name
description: What this Skill does and when to use it. Include trigger keywords users would naturally say.
---
```

**Name requirements:**
- Lowercase letters, numbers, hyphens only
- Maximum 64 characters
- Match directory name
- Use gerund form (verb + -ing): `processing-pdfs`, `analyzing-data`

**Description requirements:**
- Maximum 1024 characters
- Answer "what does it do?" and "when to use it?"
- Include specific trigger keywords
- Write in third person: "Processes Excel files" not "I can help process Excel files"

**Good description example:**
```yaml
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
```

**Bad description example:**
```yaml
description: Helps with documents  # Too vague, no trigger keywords
```

#### Optional metadata fields

```yaml
---
name: skill-name
description: ...
allowed-tools: Read, Grep, Glob  # Restrict tools (Claude Code only)
model: claude-sonnet-4-20250514  # Override model
context: fork                    # Run in isolated subagent
agent: Explore                   # Subagent type (with context: fork)
user-invocable: false           # Hide from slash menu
---
```

**When to use `context: fork`:**
- Complex multi-step operations that would clutter the main conversation
- Deep analysis tasks (code quality, architecture review)
- Operations requiring isolated context (separate conversation history)
- Long-running workflows that generate verbose output

**Choosing the `agent` type (requires `context: fork`):**
- `Explore`: Codebase exploration, file discovery, pattern searching
- `Plan`: Implementation planning, architecture design
- `general-purpose`: Default for general tasks (if omitted)
- Custom agent name: Use agents defined in `.claude/agents/` (can access Skills via `skills` field)

**Important:** Built-in agents (Explore, Plan, general-purpose) do NOT have access to Skills. Only custom agents with explicit `skills` field can use Skills.

#### Write clear instructions

**Follow the "Concise is Key" principle:**
- Only add context Claude doesn't already have
- Challenge each piece of information: "Does Claude really need this?"
- Assume Claude is already very smart

**Good example (concise):**
````markdown
## Extract PDF text

Use pdfplumber for text extraction:

```python
import pdfplumber

with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```
````

**Bad example (too verbose):**
```markdown
## Extract PDF text

PDF (Portable Document Format) files are a common file format...
First, you'll need to install pdfplumber using pip...
Then you can use the code below...
```

**Set appropriate degrees of freedom:**

- **High freedom** (text instructions): Multiple approaches valid, heuristics guide
- **Medium freedom** (pseudocode/templates): Preferred pattern exists, some variation OK
- **Low freedom** (exact scripts): Operations fragile, consistency critical

**Analogy**: Think of Claude exploring a path:
- **Narrow bridge with cliffs**: Provide exact instructions (low freedom)
- **Open field, no hazards**: Give general direction (high freedom)

### Step 4: Add supporting files (if needed)

Use progressive disclosure to keep SKILL.md focused.

**Reference files** (loaded when needed):
```markdown
## Advanced features

**Form filling**: See [FORMS.md](FORMS.md) for complete guide
**API reference**: See [REFERENCE.md](REFERENCE.md) for all methods
**Examples**: See [EXAMPLES.md](EXAMPLES.md) for common patterns
```

**Utility scripts** (executed without loading):
````markdown
## Validation

Run the validation script:
```bash
python scripts/validate.py input.pdf
```

Output shows any errors found.
````

**Important:**
- Keep references one level deep from SKILL.md
- For files >100 lines, include table of contents at top
- Use forward slashes in paths: `scripts/helper.py` not `scripts\helper.py`

### Step 5: Review against quality checklist

Before finalizing, verify your Skill meets quality standards:

```markdown
Core Quality:
- [ ] Description is specific with trigger keywords
- [ ] Description includes what it does AND when to use it
- [ ] SKILL.md body under 500 lines
- [ ] No time-sensitive information
- [ ] Consistent terminology throughout
- [ ] Examples are concrete, not abstract
- [ ] File references one level deep
- [ ] All paths use forward slashes

Instructions:
- [ ] Only includes context Claude doesn't already have
- [ ] Appropriate degree of freedom (high/medium/low)
- [ ] No unnecessary explanations
- [ ] Clear workflows for complex tasks
- [ ] Feedback loops for quality-critical operations
```

See [CHECKLIST.md](CHECKLIST.md) for the complete checklist.

### Step 6: Test with real scenarios

**Don't skip testing.** A Skill that looks good but doesn't work is worse than no Skill.

**Testing strategy:**
1. Test with representative requests that should trigger the Skill
2. Test with all target models (Haiku, Sonnet, Opus)
3. Observe whether Claude finds the right information
4. Check if Claude follows the workflow correctly
5. Verify feedback loops work as intended

**Iterate based on observations:**
- If Claude doesn't trigger the Skill, improve the description
- If Claude skips steps, make the workflow more explicit
- If Claude reads wrong files, reorganize structure
- If Claude ignores content, make links more prominent

## Core Principles

### 1. Concise is Key

The context window is shared. Only add what Claude doesn't already know.

**Default assumption:** Claude is already very smart.

### 2. Progressive Disclosure

Essential info in SKILL.md, details in referenced files loaded on-demand.

### 3. Test with Target Models

Skills behave differently on Haiku vs. Opus. Test with all models you'll use.

### 4. Evaluation-Driven Development

**Create evaluations BEFORE extensive documentation:**
1. Run Claude on tasks without the Skill, document failures
2. Create 3+ test scenarios
3. Establish baseline
4. Write minimal instructions to pass evaluations
5. Iterate based on results

### 5. Iterative Development with Claude

Most effective process involves Claude itself:
1. Complete a task without a Skill (with Claude A)
2. Identify reusable pattern
3. Ask Claude A to create a Skill
4. Review for conciseness
5. Test with Claude B (fresh instance with Skill loaded)
6. Iterate based on observations

## Common Patterns

For detailed pattern examples, see [PATTERNS.md](PATTERNS.md).

**Template Pattern**: Provide output format templates
**Examples Pattern**: Show input/output pairs
**Workflow Pattern**: Guide through multi-step processes with checklists
**Conditional Pattern**: Guide through decision points

## Anti-Patterns to Avoid

- **Windows-style paths**: Always use forward slashes
- **Too many options**: Provide default with escape hatch
- **Vague descriptions**: Include specific trigger keywords
- **Deep nesting**: Keep references one level from SKILL.md
- **Time-sensitive info**: Use "old patterns" section for deprecated content
- **Inconsistent terminology**: Choose one term and stick with it
- **Punting to Claude**: Scripts should handle errors, not fail

## Troubleshooting

**Skill doesn't trigger:**
- Check description includes specific trigger keywords
- Verify description explains both what it does and when to use it
- Test with phrases users would naturally say

**Skill has errors:**
- Check YAML frontmatter syntax (no tabs, starts with --- on line 1)
- Verify file path is correct: `~/.claude/skills/skill-name/SKILL.md`
- Check script permissions: `chmod +x scripts/*.py`
- Use `claude --debug` to see loading errors

**Claude uses wrong Skill:**
- Make descriptions more distinct with specific trigger terms
- Add more context about when NOT to use each Skill

## File Location and Distribution

**Where to create Skills:**
- Personal: `~/.claude/skills/` (available across all projects)
- Project: `.claude/skills/` (committed to version control)
- Plugin: `skills/` in plugin directory (distributed via marketplace)
- Enterprise: Managed settings (organization-wide)

**Distribution:**
- Commit `.claude/skills/` to share with team
- Create plugin for cross-repository sharing
- Use managed settings for enterprise deployment

## Next Steps

1. Choose a real use case that would benefit from a Skill
2. Follow the workflow above step-by-step
3. Review with the complete checklist: [CHECKLIST.md](CHECKLIST.md)
4. Study pattern examples: [PATTERNS.md](PATTERNS.md)
5. Reference complete examples: [EXAMPLES.md](EXAMPLES.md)

Remember: Start simple, iterate based on real usage, and always test with actual scenarios.
