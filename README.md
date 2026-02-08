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

### `home/dot_claude/scripts/update-auto-approve.ts`

Automated permission pattern analysis and management tool:

```bash
# Interactive review of all patterns
bun home/dot_claude/scripts/update-auto-approve.ts

# Preview changes without applying
bun home/dot_claude/scripts/update-auto-approve.ts --dry-run

# Analyze last 7 days only
bun home/dot_claude/scripts/update-auto-approve.ts --since 7d

# Auto-approve safe patterns without interaction
bun home/dot_claude/scripts/update-auto-approve.ts --auto-approve-safe

# Show detailed analysis information
bun home/dot_claude/scripts/update-auto-approve.ts --verbose
```

**Features:**
- Analyzes `~/.claude/logs/decisions.jsonl` for permission patterns
- Provides risk scoring and confidence levels
- Interactive review interface for pattern approval
- Automatic backup of permission files
- Supports time-based filtering of logs

## Claude Code Configuration

This repository includes comprehensive Claude Code configuration with:
- Custom skills (see `.skills/` directory)
- Global development guidelines (CLAUDE.md)
- Development rules (debugging, external-review, TypeScript standards)

### Settings.json Split Management

`~/.claude/settings.json` is managed by splitting it into multiple files:

- **`.settings.base.json`**: Core settings (model, language, statusLine, alwaysThinkingEnabled, etc.)
- **`.settings.permissions.json`**: Permission settings (allow/deny)
- **`.settings.hooks.json.tmpl`**: Hooks configuration (dynamically generated with chezmoi variables)
- **`.settings.plugins.json`**: Plugin configuration (enabledPlugins)

These files are automatically merged by `run_onchange_update-settings-json.sh.tmpl` during `chezmoi apply`.

**Important notes:**
- To modify hooks configuration, edit `.settings.hooks.json.tmpl` and run `chezmoi apply`
- Existing `enabledPlugins` settings are preserved (user manual changes are not overwritten)

### ~/.claude.json Automatic Management

`~/.claude.json` (MCP servers configuration) is automatically managed by `run_onchange_update-claude-json.sh.tmpl`:

**How it works:**
- Reads MCP server versions from `package.json` dependencies
- Merges template content with existing `~/.claude.json`
- Auto-updates `mcpServers`, `preferredNotifChannel`, and `defaultMode`
- Creates backup before changes and shows diff

**Managed MCP servers:**
- `@mizchi/readability` - Web page content extraction
- `chrome-devtools-mcp` - Chrome DevTools automation
- `@playwright/mcp` - Browser automation
- `@upstash/context7-mcp` - Documentation search
- `@openai/codex` - Code review and analysis

**To update versions:** Edit `package.json` dependencies and run `chezmoi apply`

### Dual-Layer Skills Management

This project uses a two-layer approach for managing Claude Code skills:

#### 1. Handcrafted Skills (`.skills/`)
- Stored in `${projectRoot}/.skills/` for unified management (at repo root, outside `home/`)
- Synced to both `~/.claude/skills/` and `~/.codex/skills/` via `run_after_sync-skills.sh.tmpl`
- Used by both Claude Code and Codex
- Always preserved during updates

#### 2. External Skills (`home/.chezmoidata/claude_skills.yaml`)
- Declaratively managed in YAML configuration
- Installed via `add-skill` from GitHub repositories
- Tracked in `.claude/.external-skills-installed`
- Auto-removed when deleted from YAML (handcrafted skills are protected)

Both layers coexist in `~/.claude/skills/` directory.

### Plugin Management

Plugins are managed declaratively through `.settings.plugins.json`:

**After `chezmoi apply`:**
- `show-missing-plugins.sh` detects missing plugins
- Displays marketplace registration commands (if needed)
- Shows plugin installation commands to run in Claude Code IDE

**Syncing plugin changes back to dotfiles:**
```bash
~/.claude/scripts/sync-enabled-plugins.sh
```
This exports current `enabledPlugins` from `~/.claude/settings.json` to dotfiles for version control.

### Using in Other Projects

To use these skills in another project:

```bash
cd /path/to/your/project
curl -fsSL https://raw.githubusercontent.com/berlysia/dotfiles/master/scripts/setup-claude-skills.sh | bash
```

This creates a simple `.claude/settings.json` with inline SessionStart command - no hook files needed!

Skills are installed to `~/.claude/` and auto-update on Claude Code startup.

See [docs/external-usage.md](docs/external-usage.md) for detailed documentation.

### Skills Included

See `.skills/` directory for available skills. Key skills include setup-claude-skills-for-web, commit-conventions, react-hooks, codex-review-cli, and logic-validation.
