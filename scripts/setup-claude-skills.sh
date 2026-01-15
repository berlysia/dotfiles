#!/bin/bash
# One-liner setup script for Claude Code skills from berlysia/dotfiles
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/berlysia/dotfiles/master/scripts/setup-claude-skills.sh | bash
#
# This will:
#   1. Create .claude/settings.json with inline SessionStart command
#   2. Run the installation immediately

set -euo pipefail

DOTFILES_REPO="https://raw.githubusercontent.com/berlysia/dotfiles/master"
INSTALL_SCRIPT="$DOTFILES_REPO/scripts/install-skills.sh"

log() {
    echo "[setup-claude-skills] $1"
}

error() {
    echo "[setup-claude-skills ERROR] $1" >&2
    exit 1
}

# Create directory
log "Creating .claude directory..."
mkdir -p .claude

# Create settings.json with inline hook command
if [[ ! -f .claude/settings.json ]]; then
    log "Creating .claude/settings.json with SessionStart hook..."
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
    log "settings.json created"
else
    log "settings.json already exists"
    log "Please manually add SessionStart hook configuration:"
    log '  "SessionStart": [{"matcher": "startup", "hooks": [{"type": "command", "command": "curl -fsSL https://raw.githubusercontent.com/berlysia/dotfiles/master/scripts/install-skills.sh | bash"}]}]'
fi

# Run installation immediately
log "Running installation..."
curl -fsSL "$INSTALL_SCRIPT" | bash || log "Installation completed with warnings"

log ""
log "Setup complete!"
log "Skills are now available in ~/.claude/ and will auto-update on Claude Code startup."
log ""
log "Available skills:"
ls -1 ~/.claude/skills 2>/dev/null | sed 's/^/  - \//' || log "  (run Claude Code to see skills)"
