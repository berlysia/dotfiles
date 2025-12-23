#!/bin/sh
# dotfiles repository update check - notify when remote changes are available
# Checks every hour by fetching from remote and comparing commits

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

  # Fetch from remote (faster than pull - no merge operation)
  chezmoi git fetch -- --quiet 2>/dev/null || true

  # Clear trap
  trap - INT

  # Check if remote has new commits
  local behind
  behind=$(chezmoi git rev-list -- --count HEAD..@{u} 2>/dev/null) || behind=0

  if [ -n "$behind" ] && [ "$behind" -gt 0 ]; then
    echo "💡 dotfiles: $behind commit(s) behind remote (run 'chezmoi update' to update)"
  fi
}

dotfiles_check_updates
