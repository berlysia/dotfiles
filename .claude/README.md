# Claude Local Commands

This directory contains custom slash commands for Claude Code to enhance development workflows.

## Available Commands

### /analyze-permissions

Analyzes Claude permission settings across all workspace projects and generates specific update recommendations for `settings.json.tmpl`.

**Features:**
- Scans all `.claude/settings.local.json` files in workspace
- Compares findings with current `settings.json.tmpl`
- Categorizes commands into ADD, MODIFY, REMOVE, and KEEP
- Generates actionable update recommendations with line numbers
- Creates comprehensive analysis report

**Usage:**
```
/analyze-permissions
```

**Output:**
- Generates detailed report with:
  - Executive summary with statistics
  - 🟢 **ADDITIONS**: Commands to add (used in 3+ projects)
  - 🟡 **MODIFICATIONS**: Pattern adjustments needed
  - 🔴 **REMOVALS**: Unused template commands
  - 📋 **CONSIDERATIONS**: Commands used in 2 projects
  - Implementation priority guide
  - Template line references for easy updates

**Use Cases:**
- Regular template maintenance and optimization
- Identifying unused permissions to remove
- Finding missing commonly-used commands
- Improving security through pattern refinement
- Creating data-driven permission policies

## Adding New Commands

To add a new slash command:

1. Create a new `.md` file in this directory with the command name
2. Document the command purpose, implementation steps, and usage
3. Follow the existing command format for consistency
4. Test the command thoroughly before committing

## Command Guidelines

- Commands should be focused on specific workflows
- Include clear implementation steps for Claude to follow
- Document expected inputs and outputs
- Consider security implications of operations
- Provide example usage scenarios