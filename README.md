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
