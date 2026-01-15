# Skill Builder

A comprehensive guide for creating effective Claude Code Skills following official best practices.

## What This Skill Does

The `skill-builder` Skill helps you create high-quality Claude Code Skills by providing:

- Step-by-step workflow for Skill creation
- Best practices from official documentation
- Common patterns and examples
- Quality checklist for verification
- Troubleshooting guidance

## When to Use

This Skill automatically activates when you:

- Ask to "create a new Skill"
- Request help with "Skill structure" or "Skill best practices"
- Want to "improve an existing Skill"
- Mention "building a Claude Code Skill"

## Quick Start

1. **Ask for guidance**: "Help me create a Skill for [your use case]"
2. **Follow the workflow**: The Skill guides you through 6 steps
3. **Use reference files**: Access patterns, checklist, and examples as needed
4. **Test and iterate**: Verify your Skill works with real scenarios

## File Structure

```
skill-builder/
├── SKILL.md          # Main workflow and guidance
├── PATTERNS.md       # Common patterns (template, workflow, etc.)
├── CHECKLIST.md      # Quality verification checklist
├── EXAMPLES.md       # Complete working examples
└── README.md         # This file
```

## Key Principles

This Skill teaches and demonstrates:

1. **Concise is Key**: Only add context Claude doesn't already have
2. **Progressive Disclosure**: Essential info in SKILL.md, details in referenced files
3. **Evaluation-Driven**: Create tests before extensive documentation
4. **Iterative Development**: Build with Claude, test with Claude, refine based on real usage
5. **Appropriate Freedom**: Match instruction specificity to task fragility

## Features

### Guided Workflow

The Skill provides a 6-step checklist:
1. Understand the use case
2. Design the Skill structure
3. Write SKILL.md with metadata and instructions
4. Add supporting files (if needed)
5. Review against quality checklist
6. Test with real scenarios

### Pattern Library

Access common patterns in [PATTERNS.md](PATTERNS.md):
- Template Pattern
- Examples Pattern
- Workflow Pattern
- Conditional Workflow Pattern
- Progressive Disclosure Pattern
- Feedback Loop Pattern
- Domain Organization Pattern

### Quality Checklist

Comprehensive checklist in [CHECKLIST.md](CHECKLIST.md) covering:
- Core quality (metadata, structure, content)
- Instructions quality (conciseness, clarity)
- Code and scripts (if applicable)
- Testing coverage
- Advanced considerations
- Distribution readiness

### Complete Examples

Working examples in [EXAMPLES.md](EXAMPLES.md):
- Simple single-file Skill
- Moderate multi-file Skill
- Complex Skill with progressive disclosure
- Specialized patterns (read-only, forked context, utility scripts)

## Example Usage

### Creating a Simple Skill

```
You: "Help me create a Skill for generating API documentation from code comments"

Claude: [Activates skill-builder]
I'll guide you through creating an API documentation Skill. Let's start by understanding the use case...

[Follows the 6-step workflow, providing guidance at each step]
```

### Improving an Existing Skill

```
You: "My commit message Skill isn't triggering reliably. How can I improve it?"

Claude: [Activates skill-builder]
Let me help improve your Skill's discoverability. The description field is key...

[Guides through improving the description with trigger keywords]
```

### Checking Quality

```
You: "Review my new Skill against best practices"

Claude: [Activates skill-builder]
Let's verify your Skill against the quality checklist. See CHECKLIST.md for the complete list...

[Reviews Skill against checklist items]
```

## Benefits

- **Save time**: Don't reinvent patterns, use proven templates
- **Follow best practices**: Built from official Anthropic documentation
- **Avoid common mistakes**: Learn anti-patterns upfront
- **Create effective Skills**: Higher quality, better discovery, more reliable
- **Learn by example**: Multiple working examples to study

## Requirements

- Claude Code installed and configured
- Basic understanding of markdown
- Familiarity with Claude Code Skills concept (see [official docs](https://code.claude.com/docs/en/skills))

## Installation

This Skill is designed for personal use. Copy to your Skills directory:

```bash
# For personal Skills (available across all projects)
cp -r skill-builder ~/.claude/skills/

# For project Skills (shared with team)
cp -r skill-builder .claude/skills/
```

After copying, Claude Code automatically loads the Skill.

## Tips

1. **Start simple**: Use the single-file example first, add complexity only when needed
2. **Test early**: Create evaluation scenarios before writing extensive docs
3. **Iterate with Claude**: Use one Claude instance to build, another to test
4. **Follow patterns**: Don't reinvent - adapt proven patterns to your needs
5. **Check the list**: Use CHECKLIST.md before finalizing any Skill

## Troubleshooting

**Skill doesn't activate**:
- Check that it's in the correct directory
- Verify SKILL.md has valid YAML frontmatter
- Try rephrasing your request with keywords: "create Skill", "Skill best practices"

**Need more detail on a topic**:
- Check PATTERNS.md for pattern examples
- See EXAMPLES.md for complete working examples
- Review CHECKLIST.md for quality criteria

**Want to contribute or report issues**:
- This Skill is based on official Anthropic documentation
- Report issues with the official docs at: https://github.com/anthropics/anthropic-cookbook

## Credits

This Skill consolidates best practices from:
- [Claude Code Skills Documentation](https://code.claude.com/docs/en/skills)
- [Agent Skills Best Practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [Agent Skills Overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)

## Version

Version: 1.0.0
Last Updated: 2026-01-16

## License

This Skill is provided as-is for use with Claude Code. Based on public Anthropic documentation.
