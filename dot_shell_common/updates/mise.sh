#!/bin/sh
# mise update check - notify when new version is available
# Checks every 24 hours using mise --version warning output

_MISE_CHECK_INTERVAL=86400  # 24 hours in seconds
_MISE_LAST_CHECK="${XDG_CACHE_HOME:-$HOME/.cache}/mise_last_check"

mise_check_updates() {
  # Verify mise is installed
  [ -f "$HOME/.local/bin/mise" ] || return

  # Load common functions
  . "$SHELL_COMMON/updates/_common.sh"

  # Check if interval has passed
  local last_check
  last_check=$(_update_read_timestamp "$_MISE_LAST_CHECK")
  _update_interval_passed "$last_check" "$_MISE_CHECK_INTERVAL" || return

  # Update timestamp first to prevent duplicate checks
  _update_write_timestamp "$_MISE_LAST_CHECK" "$(_update_now)"

  # Check for new version via mise --version warning
  local version_output current_version latest_version
  version_output=$("$HOME/.local/bin/mise" --version 2>&1)

  if echo "$version_output" | grep -q "available"; then
    # Extract current version from first line (e.g., "2025.7.10 linux-x64 ...")
    current_version=$(echo "$version_output" | head -1 | awk '{print $1}')
    # Extract latest version from warning line (e.g., "mise version 2025.12.9 available")
    latest_version=$(echo "$version_output" | grep "available" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
    echo "💡 mise: New version $latest_version available (current: $current_version, run 'mise self-update' to update)"
  fi
}

mise_check_updates
