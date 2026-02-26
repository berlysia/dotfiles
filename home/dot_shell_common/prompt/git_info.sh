#!/bin/sh
# Git information extraction for shell prompts
# Compatible with bash and zsh - shared between both

__prompt_git_info() {
  # Reset all variables
  PROMPT_GIT_BRANCH=""
  PROMPT_GIT_REMOTE=""
  PROMPT_GIT_AHEAD=""
  PROMPT_GIT_BEHIND=""
  PROMPT_GIT_STAGED=0
  PROMPT_GIT_MODIFIED=0
  PROMPT_GIT_UNTRACKED=0
  PROMPT_GIT_DELETED=0
  PROMPT_GIT_STATE=""
  PROMPT_GIT_ACTIVE=0

  # Check if we're in a git repository
  local git_dir
  git_dir="$(git rev-parse --git-dir 2>/dev/null)" || return

  PROMPT_GIT_ACTIVE=1

  # Detect special states (merge, rebase, etc.)
  if [ -f "$git_dir/MERGE_HEAD" ]; then
    PROMPT_GIT_STATE="merge"
  elif [ -d "$git_dir/rebase-merge" ]; then
    PROMPT_GIT_STATE="rebase"
  elif [ -d "$git_dir/rebase-apply" ]; then
    PROMPT_GIT_STATE="rebase"
  elif [ -f "$git_dir/CHERRY_PICK_HEAD" ]; then
    PROMPT_GIT_STATE="cherry-pick"
  elif [ -f "$git_dir/BISECT_LOG" ]; then
    PROMPT_GIT_STATE="bisect"
  elif [ -f "$git_dir/REVERT_HEAD" ]; then
    PROMPT_GIT_STATE="revert"
  fi

  # Get branch and file status in one command
  local status_output
  status_output=$(git status --porcelain --branch 2>/dev/null) || return

  # Parse header line (## branch...remote [ahead N, behind N])
  local header
  header=$(printf '%s\n' "$status_output" | head -1)
  header="${header#\#\# }"

  case "$header" in
    *...*)
      PROMPT_GIT_BRANCH="${header%%...*}"
      local tracking="${header#*...}"
      # Extract remote name (before any space or [)
      local remote_ref="${tracking%% *}"
      remote_ref="${remote_ref%%\[*}"
      # remote_ref is like "origin/master" or "origin/other-branch"
      local remote_name="${remote_ref%%/*}"
      local remote_branch="${remote_ref#*/}"
      if [ "$remote_branch" = "$PROMPT_GIT_BRANCH" ]; then
        # Same name: just show remote (e.g. "origin")
        PROMPT_GIT_REMOTE="$remote_name"
      else
        # Different name: show full ref (e.g. "origin/other-branch")
        PROMPT_GIT_REMOTE="$remote_ref"
      fi
      case "$tracking" in
        *'[ahead '*)
          local tmp="${tracking#*\[ahead }"
          PROMPT_GIT_AHEAD="${tmp%%[],]*}"
          ;;
      esac
      case "$tracking" in
        *'behind '*)
          local tmp="${tracking#*behind }"
          PROMPT_GIT_BEHIND="${tmp%%[],]*}"
          ;;
      esac
      ;;
    'No commits yet on '*)
      PROMPT_GIT_BRANCH="${header#No commits yet on }"
      ;;
    *)
      PROMPT_GIT_BRANCH="$header"
      ;;
  esac

  # Count file statuses (skip header line)
  local files
  files=$(printf '%s\n' "$status_output" | tail -n +2)

  if [ -n "$files" ]; then
    # Untracked: XY = ??
    PROMPT_GIT_UNTRACKED=$(printf '%s\n' "$files" | grep -c '^??' || true)
    # Staged: X is one of MADRC (changes in index)
    PROMPT_GIT_STAGED=$(printf '%s\n' "$files" | grep -c '^[MADRC]' || true)
    # Modified in worktree: Y is M
    PROMPT_GIT_MODIFIED=$(printf '%s\n' "$files" | grep -c '^.M' || true)
    # Deleted in worktree: Y is D
    PROMPT_GIT_DELETED=$(printf '%s\n' "$files" | grep -c '^.D' || true)
  fi
}
