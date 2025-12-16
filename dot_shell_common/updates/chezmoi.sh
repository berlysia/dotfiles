#!/bin/sh
# chezmoi tool update check - notify when new version is available
# Checks every 24 hours using chezmoi upgrade --dry-run

_CHEZMOI_CHECK_INTERVAL=86400  # 24 hours in seconds
_CHEZMOI_LAST_CHECK="${XDG_CACHE_HOME:-$HOME/.cache}/chezmoi_version_last_check"

chezmoi_check_updates() {
  # Verify chezmoi is installed
  type chezmoi >/dev/null 2>&1 || return

  # Load common functions
  . "$SHELL_COMMON/updates/_common.sh"

  # Check if interval has passed
  local last_check
  last_check=$(_update_read_timestamp "$_CHEZMOI_LAST_CHECK")
  _update_interval_passed "$last_check" "$_CHEZMOI_CHECK_INTERVAL" || return

  # Update timestamp first to prevent duplicate checks
  _update_write_timestamp "$_CHEZMOI_LAST_CHECK" "$(_update_now)"

  # Get current and latest versions
  local current_version latest_version
  current_version=$(chezmoi --version 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  latest_version=$(chezmoi upgrade --dry-run 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1)

  # Notify if new version available
  if [ -n "$current_version" ] && [ -n "$latest_version" ] && [ "$current_version" != "$latest_version" ]; then
    echo "💡 chezmoi: New version $latest_version available (current: $current_version, run 'chezmoi upgrade' to update)"
  fi
}

chezmoi_check_updates
