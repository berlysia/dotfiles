# dotfiles

depends on [chezmoi](https://github.com/twpayne/chezmoi)

## How to use(for me)

1. [install chezmoi](https://www.chezmoi.io/install/)
   - `sh -c "$(curl -fsLS get.chezmoi.io)" -- -b $HOME/.local/bin`
   - `winget install twpayne.chezmoi`
1. if you are in PowerShell, `Set-ExecutionPolicy -ExecutionPolicy ByPass -Scope Process`
1. `chezmoi init --apply berlysia`

## note

- `~/.local/bin` will be added to `$PATH`
- `~/.local/.bin` will be added to `$PATH` , and overwrite this directory with symlink

## list of something will be set up

- homebrew (only mac)
- [mise](https://github.com/jdx/mise)
- direnv
- fzf
- ripgrep
- bat
- WSL2 ssh-agent (only WSL)

- my custom zsh prompt

## Claude Decision Log Analysis

This dotfiles project includes tools for analyzing Claude Code hook decision logs:

### `dot_claude/scripts/update-auto-approve.ts`

Automated permission pattern analysis and management tool:

```bash
# Interactive review of all patterns
bun dot_claude/scripts/update-auto-approve.ts

# Preview changes without applying
bun dot_claude/scripts/update-auto-approve.ts --dry-run

# Analyze last 7 days only  
bun dot_claude/scripts/update-auto-approve.ts --since 7d

# Auto-approve safe patterns without interaction
bun dot_claude/scripts/update-auto-approve.ts --auto-approve-safe

# Show detailed analysis information
bun dot_claude/scripts/update-auto-approve.ts --verbose
```

**Features:**
- Analyzes `~/.claude/logs/decisions.jsonl` for permission patterns
- Provides risk scoring and confidence levels
- Interactive review interface for pattern approval
- Automatic backup of permission files
- Supports time-based filtering of logs

## Claude Code Configuration

This repository includes comprehensive Claude Code configuration with:
- 7 custom skills (semantic-commit, react-hooks, codex-review, logic-validation, etc.)
- Global development guidelines (CLAUDE.md)
- Development rules (debugging, external-review, TypeScript standards)

### Using in Other Projects

To use these skills in another project:

```bash
cd /path/to/your/project
curl -fsSL https://raw.githubusercontent.com/berlysia/dotfiles/master/scripts/setup-claude-skills.sh | bash
```

This creates a simple `.claude/settings.json` with inline SessionStart command - no hook files needed!

Skills are installed to `~/.claude/` and auto-update on Claude Code startup.

See [dot_claude/README-external-usage.md](dot_claude/README-external-usage.md) for detailed documentation.

### Skills Included

- **semantic-commit**: Semantic commit message generation with change analysis
- **react-hooks**: React hooks best practices and optimization guidance
- **codex-review-cli**: Quick code review via Codex CLI (read-only)
- **codex-review-mcp**: Conversational code review via Codex MCP
- **logic-validation**: Validate logical consistency of decisions
- **optimizing-claude-md**: Analyze and improve CLAUDE.md files
- **skill-builder**: Guided skill creation following best practices
