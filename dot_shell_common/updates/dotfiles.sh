#!/bin/sh
# dotfiles repository update check - notify when remote changes are available
# Checks every hour by pulling from remote and comparing status

_DOTFILES_CHECK_INTERVAL=3600  # 1 hour in seconds
_DOTFILES_LAST_CHECK="${XDG_CACHE_HOME:-$HOME/.cache}/dotfiles_last_check"

dotfiles_check_updates() {
  # Verify chezmoi is installed
  type chezmoi >/dev/null 2>&1 || return

  # Load common functions
  . "$SHELL_COMMON/updates/_common.sh"

  # Check if interval has passed
  local last_check
  last_check=$(_update_read_timestamp "$_DOTFILES_LAST_CHECK")
  _update_interval_passed "$last_check" "$_DOTFILES_CHECK_INTERVAL" || return

  # Update timestamp first to prevent duplicate checks
  _update_write_timestamp "$_DOTFILES_LAST_CHECK" "$(_update_now)"

  # Restore timestamp on interrupt (auth prompt may cause user to cancel)
  trap 'echo "$last_check" > "$_DOTFILES_LAST_CHECK"; trap - INT; return' INT

  # Pull from remote (may prompt for authentication)
  echo "dotfiles: Checking for updates..."
  chezmoi git pull -- --quiet 2>/dev/null || true

  # Clear trap
  trap - INT

  # Check for pending changes
  local status
  status=$(chezmoi status 2>/dev/null)
  if [ -n "$status" ]; then
    echo "💡 dotfiles: Updates available (run 'chezmoi apply' to apply)"
  fi
}

dotfiles_check_updates
