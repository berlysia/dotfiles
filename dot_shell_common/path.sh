#!/bin/sh
# Common PATH configuration for all shells

# Define paths to add (as an array for easier maintenance)
_common_paths=(
  "$HOME/.local/bin"
  "$HOME/.local/.bin"
  "$HOME/.claude/local"
  "$HOME/.deno/bin"
  "$HOME/google-cloud-sdk/bin"
  "$HOME/workspace/depot_tools"
  "${GOPATH:-$HOME/go}/bin"
)

# Function to add paths to PATH without duplication
# This function will be called by shell-specific scripts
add_to_path() {
  local new_path="$1"
  case ":$PATH:" in
    *":$new_path:"*) :;; # Already in PATH
    *) PATH="$new_path:$PATH";;
  esac
}

# Export the paths array for shell-specific handling
COMMON_PATHS=("${_common_paths[@]}")
