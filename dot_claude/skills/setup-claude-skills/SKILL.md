---
name: setup-claude-skills
description: Setup Claude Code skills from berlysia/dotfiles in other projects. Creates .claude/settings.json with auto-update hook. Use when setting up skills in a new project or when user asks to configure, install, or setup external Claude Code skills.
---

# Setup Claude Skills

This Skill sets up Claude Code skills from berlysia/dotfiles repository in other projects with a single command.

## What it does

1. Creates `.claude/settings.json` with SessionStart hook (if not exists)
2. Installs all skills to `~/.claude/` immediately
3. Skills auto-update on every Claude Code startup

## When to use

- Setting up skills in a new project
- User asks to "setup Claude skills" or "install skills"
- User wants to use berlysia/dotfiles skills in current project

## Implementation Steps

### Step 1: Check if .claude/settings.json exists

Read `.claude/settings.json` to check current state:
- If file doesn't exist → Proceed to Step 2
- If file exists → Proceed to Step 3

### Step 2: Create new settings.json (if not exists)

Create `.claude/settings.json` with this content:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "curl -fsSL https://raw.githubusercontent.com/berlysia/dotfiles/master/scripts/install-skills.sh | bash"
          }
        ]
      }
    ]
  }
}
```

**Important:** Use exact JSON structure with proper nesting.

### Step 3: Handle existing settings.json

If `.claude/settings.json` already exists, guide user to manually add SessionStart hook:

1. Read current settings.json content
2. Check if SessionStart hook already exists
3. If SessionStart exists, check if it includes the install-skills.sh command
4. If not exists, provide instructions to add it:

```
To enable auto-update, add this to your .claude/settings.json:

{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "curl -fsSL https://raw.githubusercontent.com/berlysia/dotfiles/master/scripts/install-skills.sh | bash"
          }
        ]
      }
    ]
  }
}
```

### Step 4: Run installation immediately

After creating or updating settings.json, run installation:

```bash
curl -fsSL https://raw.githubusercontent.com/berlysia/dotfiles/master/scripts/install-skills.sh | bash
```

This installs skills to `~/.claude/skills/` right away.

### Step 5: Verify installation

Check that skills were installed:

```bash
ls ~/.claude/skills/
```

Expected output: List of skill directories.

### Step 6: Inform user

Tell user:
- Skills are now available via `/skill-name` commands
- Skills auto-update on Claude Code startup
- List installed skills with descriptions
- Mention documentation at https://github.com/berlysia/dotfiles/blob/master/docs/external-usage.md

## Available Skills

After installation, these skills will be available:

- `/semantic-commit` - Complex commit splitting and semantic commit generation
- `/react-hooks` - React hooks best practices and optimization
- `/codex-review-cli` - Quick code review via Codex CLI
- `/codex-review-mcp` - Conversational code review via Codex MCP
- `/logic-validation` - Logic consistency validation
- `/optimizing-claude-md` - CLAUDE.md quality analysis
- `/skill-builder` - Guided skill creation

## Error Handling

**curl command fails:**
- Check network connection
- Verify GitHub is accessible
- Try manual installation: `git clone https://github.com/berlysia/dotfiles`

**Settings.json syntax error:**
- Validate JSON syntax
- Ensure proper quote escaping
- Check no trailing commas

**Skills not appearing:**
- Check `~/.claude/skills/` directory exists
- Verify curl and git are installed
- Run install script manually

## Example Usage

User: "Setup Claude skills from your dotfiles"