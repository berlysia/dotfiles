#!/bin/bash
# Install Claude Code skills from berlysia/dotfiles to ~/.claude/
# Called from SessionStart inline commands

set -euo pipefail

# Only run in web/remote environment
if [[ -z "${CLAUDE_CODE_REMOTE:-}" ]]; then
    echo "[install-skills] Skipping in CLI version (managed by chezmoi)" >&2
    exit 0
fi

DOTFILES_REPO="https://github.com/berlysia/dotfiles"
BRANCH="master"
SKILLS_PATH="dot_claude/skills"
RULES_PATH="dot_claude/rules"
TARGET_DIR="$HOME/.claude"

log() {
    echo "[install-skills] $1" >&2
}

error() {
    echo "[install-skills ERROR] $1" >&2
    exit 1
}

# Check for git
if ! command -v git &> /dev/null; then
    error "git is required but not found"
fi

# Clone or update temporary repo
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

log "Fetching skills from $DOTFILES_REPO..."
git clone --depth 1 --branch "$BRANCH" --single-branch "$DOTFILES_REPO" "$TEMP_DIR" &> /dev/null || error "Failed to clone repository"

# Create target directory
mkdir -p "$TARGET_DIR/skills" "$TARGET_DIR/rules"

# Copy skills
if [[ -d "$TEMP_DIR/$SKILLS_PATH" ]]; then
    log "Installing skills to $TARGET_DIR/skills/"
    cp -rf "$TEMP_DIR/$SKILLS_PATH/"* "$TARGET_DIR/skills/"
    SKILL_COUNT=$(ls -1 "$TARGET_DIR/skills" 2>/dev/null | wc -l)
    log "Installed $SKILL_COUNT skills"
else
    log "Warning: Skills directory not found in repository"
fi

# Copy rules
if [[ -d "$TEMP_DIR/$RULES_PATH" ]]; then
    log "Installing rules to $TARGET_DIR/rules/"
    cp -rf "$TEMP_DIR/$RULES_PATH/"* "$TARGET_DIR/rules/"
    RULE_COUNT=$(ls -1 "$TARGET_DIR/rules" 2>/dev/null | wc -l)
    log "Installed $RULE_COUNT rule files"
else
    log "Warning: Rules directory not found in repository"
fi

log "Setup complete - skills available globally in ~/.claude/"
