# Using User-Level Skills in Other Projects

This dotfiles repository contains reusable Claude Code skills that can be used in any project via `~/.claude/`.

## Using the Skill (Easiest)

If you already have these skills installed, simply run:

```
/setup-claude-skills
```

Claude will automatically create `.claude/settings.json` with the auto-update hook and install all skills.

## Quick Setup (Recommended)

From any project directory, run:

```bash
curl -fsSL https://raw.githubusercontent.com/berlysia/dotfiles/master/scripts/setup-claude-skills.sh | bash
```

This will:
1. Create `.claude/settings.json` with inline SessionStart command
2. Install all skills to `~/.claude/` immediately
3. Auto-update skills on every Claude Code startup

**No hook files needed** - just one settings.json file!

## Manual Setup

If you prefer manual installation:

1. **Create settings.json with inline command:**

   ```bash
   mkdir -p .claude
   cat > .claude/settings.json <<'EOF'
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
   EOF
   ```

2. **Start Claude Code:**

   The inline SessionStart command will automatically install skills to `~/.claude/` on startup.

## Available Skills

- **setup-claude-skills** - Setup skills in other projects with one command
- **semantic-commit** - Complex commit splitting and semantic commit message generation
- **react-hooks** - React hooks best practices and performance optimization
- **codex-review-cli** - Quick code review via Codex CLI
- **codex-review-mcp** - Conversational code review via Codex MCP
- **logic-validation** - Logic consistency validation
- **optimizing-claude-md** - CLAUDE.md quality analysis
- **skill-builder** - Guided skill creation following best practices

## Using Global CLAUDE.md

To reference global development guidelines in your project:

Add this to your project's `.claude/CLAUDE.md`:

```markdown
# Project-Specific Instructions
[Your project instructions here]

## User-Level Development Guidelines
@~/.claude/CLAUDE.md
```

Note: In web version, you may need to include guidelines directly or copy them in SessionStart hook.

## Security Note

Before running scripts from the internet, review their contents:

```bash
curl -fsSL https://raw.githubusercontent.com/berlysia/dotfiles/master/scripts/setup-claude-skills.sh
curl -fsSL https://raw.githubusercontent.com/berlysia/dotfiles/master/scripts/install-skills.sh
```

## How It Works

- **Inline SessionStart command**: Defined directly in settings.json (no hook files!)
- **Skill installation**: Skills are installed to `~/.claude/skills/`
- **Global availability**: All projects automatically have access to installed skills
- **Auto-update**: Skills update on every startup (pulls from GitHub)

## Troubleshooting

**Hook not running:**
- Verify `.claude/settings.json` contains SessionStart hook configuration
- Check settings.json syntax is valid JSON

**Skills not appearing:**
- Check `~/.claude/skills/` directory: `ls ~/.claude/skills/`
- Run install script manually: `curl -fsSL https://raw.githubusercontent.com/berlysia/dotfiles/master/scripts/install-skills.sh | bash`
- Check for curl and git availability: `curl --version && git --version`

**Network errors:**
- Ensure GitHub is accessible
- Try manual clone: `git clone --depth 1 https://github.com/berlysia/dotfiles`
