#!/usr/bin/env bash

WORKTREE_MARKER_KIND=""
WORKTREE_MARKER_VALUE=""
WORKTREE_MARKER_ENTRIES=0
WORKTREE_MARKER_PATH=""
WORKTREE_UNSAFE_PATH=""

repoName() {
  local common_dir=$1 parent name
  while [[ "$common_dir" != "/" && "$common_dir" == */ ]]; do
    common_dir=${common_dir%/}
  done
  [[ "${common_dir##*/}" == ".git" ]] || return 1
  parent=${common_dir%/*}
  [[ -n "$parent" ]] || parent="/"
  name=${parent##*/}
  [[ -n "$name" && "$name" != "." && "$name" != ".." ]] || return 1
  printf '%s\n' "$name"
}

currentRoot() {
  local name home=$2
  name=$(repoName "$1") || return 1
  printf '%s/worktrees/%s/\n' "${home%/}" "$name"
}

legacyRoot() {
  local common_dir=${1%/}
  printf '%s/worktree/\n' "$common_dir"
}

_worktree_normalize_path() {
  local path=$1 segment
  local -a parts stack=()
  [[ "$path" == /* ]] || return 1
  IFS=/ read -r -a parts <<<"$path"
  for segment in "${parts[@]}"; do
    case "$segment" in
      ""|.) ;;
      ..)
        if [[ ${#stack[@]} -gt 0 ]]; then
          stack=("${stack[@]:0:${#stack[@]}-1}")
        fi
        ;;
      *) stack+=("$segment") ;;
    esac
  done
  local IFS=/
  printf '/%s\n' "${stack[*]}"
}

_worktree_is_child() {
  local path=$1 root=$2 child first
  [[ "$path" != "$root" && "$path" == "$root/"* ]] || return 1
  child=${path#"$root"/}
  first=${child%%/*}
  [[ -n "$first" && "$first" != ".common-dir" && "$first" != ".common-dir.tmp."* ]]
}

isUnderManagedRoot() {
  local path=$1 common_dir=$2 home=$3 current legacy
  path=$(_worktree_normalize_path "$path") || return 1
  current=$(currentRoot "$common_dir" "$home") || return 1
  current=$(_worktree_normalize_path "$current") || return 1
  legacy=$(legacyRoot "$common_dir")
  legacy=$(_worktree_normalize_path "$legacy") || return 1
  _worktree_is_child "$path" "$current" || _worktree_is_child "$path" "$legacy"
}

_worktree_check_safe_target() {
  local common_dir=$1 home=$2 target=$3 root worktrees_dir relative_path current segment
  WORKTREE_UNSAFE_PATH=""
  root=$(currentRoot "$common_dir" "$home") || {
    WORKTREE_UNSAFE_PATH=$common_dir
    return 1
  }
  root=$(_worktree_normalize_path "$root") || {
    WORKTREE_UNSAFE_PATH=$root
    return 1
  }
  worktrees_dir=$(_worktree_normalize_path "${home%/}/worktrees") || {
    WORKTREE_UNSAFE_PATH=$home
    return 1
  }
  if [[ -L "$worktrees_dir" || ( -e "$worktrees_dir" && ! -d "$worktrees_dir" ) ]]; then
    WORKTREE_UNSAFE_PATH=$worktrees_dir
    return 1
  fi
  if [[ -L "$root" ]]; then
    WORKTREE_UNSAFE_PATH=$root
    return 1
  fi

  target=$(_worktree_normalize_path "$target") || {
    WORKTREE_UNSAFE_PATH=$target
    return 1
  }
  if [[ "$target" != "$root" && "$target" != "$root/"* ]]; then
    WORKTREE_UNSAFE_PATH=$target
    return 1
  fi

  current=$root
  relative_path=${target#"$root"}
  if [[ -n "$relative_path" ]]; then
    relative_path=${relative_path#/}
    while [[ -n "$relative_path" ]]; do
      segment=${relative_path%%/*}
      current="$current/$segment"
      if [[ -L "$current" ]]; then
        WORKTREE_UNSAFE_PATH=$current
        return 1
      fi
      if [[ "$relative_path" == */* ]]; then
        if [[ -e "$current" && ! -d "$current" ]]; then
          WORKTREE_UNSAFE_PATH=$current
          return 1
        fi
        relative_path=${relative_path#*/}
      else
        relative_path=""
      fi
    done
  fi
  return 0
}

_worktree_unmarked_entries() {
  local root=$1 path name count=0
  for path in "$root"/* "$root"/.[!.]* "$root"/..?*; do
    [[ -e "$path" || -L "$path" ]] || continue
    name=${path##*/}
    if [[ "$name" == ".common-dir.tmp."* ]]; then
      # A concurrent reservation removes its temp file after linking; a name
      # that vanished since the glob expanded is not a leftover entry.
      [[ -e "$path" || -L "$path" ]] || continue
      [[ -f "$path" && ! -L "$path" ]] && continue
    fi
    count=$((count + 1))
  done
  printf '%s\n' "$count"
}

worktree_marker_read_first_line() {
  local marker_path=$1 value=""
  IFS= read -r value <"$marker_path" || :
  WORKTREE_MARKER_VALUE=${value%$'\r'}
}

_worktree_judge_marker() {
  local common_dir=$1 home=$2 root marker_stat own_common_dir marker_value physical_marker
  WORKTREE_MARKER_KIND=""
  WORKTREE_MARKER_VALUE=""
  WORKTREE_MARKER_ENTRIES=0
  root=$(currentRoot "$common_dir" "$home") || {
    WORKTREE_MARKER_KIND=unsafe-path
    WORKTREE_UNSAFE_PATH=$common_dir
    return 0
  }
  root=$(_worktree_normalize_path "$root") || {
    WORKTREE_MARKER_KIND=unsafe-path
    WORKTREE_UNSAFE_PATH=$common_dir
    return 0
  }
  if ! _worktree_check_safe_target "$common_dir" "$home" "$root"; then
    WORKTREE_MARKER_KIND=unsafe-path
    return 0
  fi
  if ! own_common_dir=$(cd -P -- "$common_dir" 2>/dev/null && pwd -P); then
    WORKTREE_MARKER_KIND=unsafe-path
    WORKTREE_UNSAFE_PATH=$common_dir
    return 0
  fi
  WORKTREE_MARKER_PATH="$root/.common-dir"
  if [[ ! -e "$root" && ! -L "$root" ]]; then
    WORKTREE_MARKER_KIND=ok-new
    return 0
  fi
  if [[ -L "$root" || ! -d "$root" ]]; then
    WORKTREE_MARKER_KIND=unsafe-path
    WORKTREE_UNSAFE_PATH=$root
    return 0
  fi
  if [[ ! -e "$WORKTREE_MARKER_PATH" && ! -L "$WORKTREE_MARKER_PATH" ]]; then
    WORKTREE_MARKER_ENTRIES=$(_worktree_unmarked_entries "$root")
    if [[ "$WORKTREE_MARKER_ENTRIES" -eq 0 ]]; then
      WORKTREE_MARKER_KIND=ok-new
      return 0
    fi
    # A concurrent reservation may have linked the marker after the test
    # above; the entry we counted is then the marker, so judge it instead.
    if [[ ! -e "$WORKTREE_MARKER_PATH" && ! -L "$WORKTREE_MARKER_PATH" ]]; then
      WORKTREE_MARKER_KIND=unmarked
      return 0
    fi
  fi
  if [[ -L "$WORKTREE_MARKER_PATH" || ! -f "$WORKTREE_MARKER_PATH" ]]; then
    WORKTREE_MARKER_ENTRIES=$(_worktree_unmarked_entries "$root")
    WORKTREE_MARKER_KIND=unmarked
    return 0
  fi

  worktree_marker_read_first_line "$WORKTREE_MARKER_PATH"
  marker_value=$WORKTREE_MARKER_VALUE
  if [[ -L "$WORKTREE_MARKER_PATH" || ! -f "$WORKTREE_MARKER_PATH" ]]; then
    WORKTREE_MARKER_VALUE=""
    WORKTREE_MARKER_ENTRIES=$(_worktree_unmarked_entries "$root")
    WORKTREE_MARKER_KIND=unmarked
    return 0
  fi
  if [[ "$marker_value" == "$own_common_dir" ]]; then
    WORKTREE_MARKER_KIND=ok-same
    return 0
  fi
  if [[ "$marker_value" == /* && "$marker_value" != *$'\n'* && -f "$marker_value/HEAD" ]]; then
    if physical_marker=$(cd -P -- "$marker_value" 2>/dev/null && pwd -P); then
      if [[ "$physical_marker" == "$own_common_dir" ]]; then
        WORKTREE_MARKER_KIND=ok-same
      else
        WORKTREE_MARKER_KIND=conflict
        WORKTREE_MARKER_VALUE=$physical_marker
      fi
      return 0
    fi
  fi
  WORKTREE_MARKER_KIND=stale
  return 0
}

judgeMarker() {
  _worktree_judge_marker "$@"
  printf '%s\n' "$WORKTREE_MARKER_KIND"
}

_worktree_report_marker_failure() {
  local common_dir=$1 home=$2 root marker_path_arg unsafe_path_arg
  root=$(currentRoot "$common_dir" "$home" 2>/dev/null) || root="$home/worktrees"
  printf -v marker_path_arg '%q' "$WORKTREE_MARKER_PATH"
  printf -v unsafe_path_arg '%q' "$WORKTREE_UNSAFE_PATH"
  printf -v root '%q' "$root"
  case "$WORKTREE_MARKER_KIND" in
    conflict)
      printf 'worktree location conflicts with another repository; its path cannot be changed (marker: %s)\n' "$marker_path_arg" >&2
      ;;
    stale)
      printf 'stale marker at %s; inspect its contents, then run rm -- %s in a terminal\n' "$marker_path_arg" "$marker_path_arg" >&2
      ;;
    unmarked)
      printf 'worktree location has %s unmarked entries; inspect them, then create the marker or move %s\n' "$WORKTREE_MARKER_ENTRIES" "$root" >&2
      ;;
    unsafe-path)
      printf 'unsafe worktree path at %s; remove the symlink or fix the path, then retry\n' "$unsafe_path_arg" >&2
      ;;
    *)
      printf 'could not reserve the worktree marker at %s; inspect the location and retry\n' "$marker_path_arg" >&2
      ;;
  esac
}

worktree_marker_temp_path() {
  local root=$1 pid=$2 attempt=$3
  printf '%s/.common-dir.tmp.%s.%s%s\n' "$root" "$pid" "$RANDOM" "$attempt"
}

worktree_link_marker() {
  ln -n "$1" "$2"
}

reserveMarker() {
  local common_dir=$1 home=$2 target_path=${3:-} root own_common_dir marker_path temp_path="" created=0 attempt status=1
  root=$(currentRoot "$common_dir" "$home") || {
    WORKTREE_MARKER_KIND=unsafe-path
    WORKTREE_MARKER_PATH="$home/worktrees/.common-dir"
    WORKTREE_UNSAFE_PATH=$common_dir
    _worktree_report_marker_failure "$common_dir" "$home"
    return 1
  }
  if [[ -z "$target_path" ]]; then target_path=$root; fi
  if ! _worktree_check_safe_target "$common_dir" "$home" "$target_path"; then
    WORKTREE_MARKER_KIND=unsafe-path
    WORKTREE_MARKER_PATH="$root/.common-dir"
    _worktree_report_marker_failure "$common_dir" "$home"
    return 1
  fi
  _worktree_judge_marker "$common_dir" "$home"
  if [[ "$WORKTREE_MARKER_KIND" == "ok-same" ]]; then return 0; fi
  if [[ "$WORKTREE_MARKER_KIND" != "ok-new" ]]; then
    _worktree_report_marker_failure "$common_dir" "$home"
    return 1
  fi

  root=$(_worktree_normalize_path "$root") || {
    WORKTREE_MARKER_KIND=unsafe-path
    WORKTREE_MARKER_PATH="$home/worktrees/.common-dir"
    WORKTREE_UNSAFE_PATH=$home
    _worktree_report_marker_failure "$common_dir" "$home"
    return 1
  }
  marker_path="$root/.common-dir"
  if ! own_common_dir=$(cd -P -- "$common_dir" 2>/dev/null && pwd -P) || ! mkdir -p -- "$root"; then
    WORKTREE_MARKER_KIND=reservation-failed
    WORKTREE_MARKER_PATH=$marker_path
    _worktree_report_marker_failure "$common_dir" "$home"
    return 1
  fi
  if ! _worktree_check_safe_target "$common_dir" "$home" "$target_path"; then
    WORKTREE_MARKER_KIND=unsafe-path
    WORKTREE_MARKER_PATH=$marker_path
    _worktree_report_marker_failure "$common_dir" "$home"
    return 1
  fi

  for attempt in 1 2 3; do
    temp_path=$(worktree_marker_temp_path "$root" "${BASHPID:-$$}" "$attempt")
    if (set -o noclobber; printf '%s\n' "$own_common_dir" >"$temp_path") 2>/dev/null; then
      created=1
      break
    fi
  done
  if [[ "$created" -ne 1 ]]; then
    WORKTREE_MARKER_KIND=reservation-failed
    WORKTREE_MARKER_PATH=$marker_path
    _worktree_report_marker_failure "$common_dir" "$home"
    return 1
  fi

  if worktree_link_marker "$temp_path" "$marker_path"; then
    if [[ -L "$marker_path" ]]; then
      rm -- "$marker_path"
      WORKTREE_MARKER_KIND=unsafe-path
      WORKTREE_UNSAFE_PATH=$marker_path
    elif [[ ! -f "$marker_path" ]]; then
      WORKTREE_MARKER_KIND=reservation-failed
    else
      _worktree_judge_marker "$common_dir" "$home"
      if [[ "$WORKTREE_MARKER_KIND" == "ok-same" ]]; then
        status=0
      fi
    fi
  else
    _worktree_judge_marker "$common_dir" "$home"
    if [[ "$WORKTREE_MARKER_KIND" == "ok-same" ]]; then
      status=0
    elif [[ "$WORKTREE_MARKER_KIND" == "ok-new" ]]; then
      WORKTREE_MARKER_KIND=reservation-failed
    fi
  fi
  rm -f -- "$temp_path"
  if [[ "$status" -ne 0 ]]; then
    WORKTREE_MARKER_PATH=$marker_path
    _worktree_report_marker_failure "$common_dir" "$home"
  fi
  return "$status"
}
