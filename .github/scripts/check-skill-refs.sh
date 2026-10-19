#!/usr/bin/env bash
# Checks the cross-skill references and symlinks under a skills directory (.skills/ in CI, or a
# deployed ~/.claude/skills). Detection only: nothing is written. All problems are printed to
# stderr, one line each, and the exit status is 1 if there is any.
#
#   check-skill-refs.sh <skills_dir> [--names-from <dir>]
#
# Exit: 0 no problem / 1 problems found / 2 usage error, or a directory that is missing or unreadable.
#
# --names-from <dir>: scan only the skills whose name is also an entry of <dir>. On a deployed
# skills dir this leaves out the skills that apm or private skills installed (pass .skills).
#
# --- Contract owned by this script (single owner) ----------------------------------------------
#
# Scanned: each skill's SKILL.md, and for a role skill (name starts with "ja-") every *.md under
# its references/. Not scanned: the tool-owned directories (TOOL_OWNED below; the same list the
# sync script excludes).
#
# Reference: a "../<name>/<path>" in the body (code blocks included) whose "../" is preceded by
# line start, whitespace, ` ( [ " or '. <name> matches ^[a-z0-9][a-z0-9._-]*$. <path> runs up to
# whitespace, ` ) ] " ' or >, minus trailing . , : characters. A "." or ".." segment in <path> is
# a problem by itself. References not starting with "../" (absolute, ~/, ./) are not checked.
#
#   (1) the target exists inside <skills_dir>; symlinks are never followed, so a symlink on the
#       way (the skill directory included) is a problem
#   (2) a role skill may point only at ROLE_ALLOWED_EXACT / ROLE_ALLOWED_PREFIXES below; other
#       skills are not restricted. This list is the one place the allowlist lives.
#   (4) a SKILL.md line starting with "役割:" names only existing "ja-" skills of <skills_dir>
#   (S) symlinks under <skills_dir> (outside the tool-owned directories), listed without -L: the
#       only one allowed is tanteki/node_modules, and its readlink string must be exactly
#       ../../../.config/textlint/node_modules (compared as a string, never resolved)
#
# Safety: the scanned files can be the body of a PR. Their text is only matched with [[ =~ ]] and
# compared; it is never evaluated, expanded as a glob, or used to open anything but the path built
# from a validated <name> and <path>. Printed text has its non-printable bytes replaced.

set -euo pipefail
export LC_ALL=C
shopt -s dotglob nullglob

TOOL_OWNED=(ui-skills claude-recall .system synced .trash)
ROLE_ALLOWED_EXACT=(ja-fact-preservation/SKILL.md)
ROLE_ALLOWED_PREFIXES=(tanteki/references/ tanteki/scripts/ yomiyasu/references/ yomiyasu/scripts/)
NODE_MODULES_REL=tanteki/node_modules
NODE_MODULES_TARGET=../../../.config/textlint/node_modules

NAME_RE='^[a-z0-9][a-z0-9._-]*$'
# 1: prefix char (or empty at line start), 2: name, 3: path, 4: rest of the line
REF_RE=$'(^|[[:space:]`(["\'])\\.\\./([a-z0-9][a-z0-9._-]*)/([^][:space:]`)"\'>]+)(.*)$'

usage() {
  printf 'usage: %s <skills_dir> [--names-from <dir>]\n' "${0##*/}" >&2
  exit 2
}

SKILLS_DIR=""
NAMES_FROM=""
while (($#)); do
  case "$1" in
    --names-from)
      (($# >= 2)) || usage
      [[ -z "$NAMES_FROM" ]] || usage
      NAMES_FROM="$2"
      shift 2
      ;;
    -*) usage ;;
    *)
      [[ -z "$SKILLS_DIR" ]] || usage
      SKILLS_DIR="$1"
      shift
      ;;
  esac
done
[[ -n "$SKILLS_DIR" ]] || usage
for d in "$SKILLS_DIR" ${NAMES_FROM:+"$NAMES_FROM"}; do
  if [[ ! -d "$d" || ! -r "$d" || ! -x "$d" ]]; then
    printf '%s: not a readable directory: %s\n' "${0##*/}" "$d" >&2
    exit 2
  fi
done
SKILLS_DIR="${SKILLS_DIR%/}"
[[ -n "$SKILLS_DIR" ]] || SKILLS_DIR=/

PROBLEMS=0
problem() {
  local msg="$1"
  printf '%s\n' "${msg//[![:print:]]/?}" >&2
  PROBLEMS=$((PROBLEMS + 1))
}

declare -A TOOL_OWNED_SET=()
for t in "${TOOL_OWNED[@]}"; do TOOL_OWNED_SET["$t"]=1; done

declare -A NAMES_SET=()
if [[ -n "$NAMES_FROM" ]]; then
  for p in "$NAMES_FROM"/*; do NAMES_SET["${p##*/}"]=1; done
fi

# in_scope <skill name>: true when the skill is scanned
in_scope() {
  [[ -z "${TOOL_OWNED_SET[$1]:-}" ]] || return 1
  [[ -z "$NAMES_FROM" || -n "${NAMES_SET[$1]:-}" ]]
}

# role_allows <name/path>: true when a role skill may point there
role_allows() {
  local target="$1" e p
  for e in "${ROLE_ALLOWED_EXACT[@]}"; do
    [[ "$target" == "$e" ]] && return 0
  done
  for p in "${ROLE_ALLOWED_PREFIXES[@]}"; do
    [[ "$target" == "$p"?* ]] && return 0
  done
  return 1
}

# target_state <name> <path>: prints ok / symlink / missing. Walks the path component by component
# and stops at the first symlink, so nothing is resolved through one.
target_state() {
  local cur="$SKILLS_DIR/$1" seg
  local -a segs
  if [[ -L "$cur" ]]; then
    printf symlink
    return
  fi
  IFS=/ read -r -a segs <<<"$2"
  for seg in "${segs[@]}"; do
    [[ -n "$seg" ]] || continue
    cur="$cur/$seg"
    if [[ -L "$cur" ]]; then
      printf symlink
      return
    fi
  done
  if [[ -e "$cur" ]]; then printf ok; else printf missing; fi
}

# check_ref <file label> <skill> <name> <path>
check_ref() {
  local label="$1" skill="$2" name="$3" path="$4" seg state
  local -a segs
  IFS=/ read -r -a segs <<<"$path"
  for seg in "${segs[@]}"; do
    if [[ "$seg" == . || "$seg" == .. ]]; then
      problem "$label: reference ../$name/$path has a \"$seg\" segment"
      return
    fi
  done
  state=$(target_state "$name" "$path")
  case "$state" in
    symlink) problem "$label: reference ../$name/$path goes through a symlink" ;;
    missing) problem "$label: reference ../$name/$path does not exist" ;;
  esac
  if [[ "$skill" == ja-* ]] && ! role_allows "$name/$path"; then
    problem "$label: role skill $skill may not reference ../$name/$path"
  fi
}

# check_role_line <file label> <line>: check (4) on a line that starts with "役割:"
check_role_line() {
  local label="$1" names="${2#役割:}" tok
  names="${names//[,、\`]/ }"
  for tok in $names; do
    if [[ ! "$tok" =~ $NAME_RE || "$tok" != ja-* ]]; then
      problem "$label: role name \"$tok\" is not a ja- skill name"
    elif [[ ! -d "$SKILLS_DIR/$tok" || -L "$SKILLS_DIR/$tok" ]]; then
      problem "$label: role skill \"$tok\" does not exist in $SKILLS_DIR"
    fi
  done
}

# scan_file <file> <skill> <label>
scan_file() {
  local file="$1" skill="$2" label="$3" line rest name path
  local is_skill_md=0
  [[ "$label" == */SKILL.md ]] && is_skill_md=1
  while IFS= read -r line || [[ -n "$line" ]]; do
    if ((is_skill_md)) && [[ "$line" == 役割:* ]]; then
      check_role_line "$label" "$line"
    fi
    rest="$line"
    while [[ "$rest" =~ $REF_RE ]]; do
      name="${BASH_REMATCH[2]}"
      path="${BASH_REMATCH[3]}"
      rest="${BASH_REMATCH[4]}"
      while [[ "$path" == *[.,:] ]]; do path="${path%?}"; done
      [[ -n "$path" ]] || continue
      check_ref "$label" "$skill" "$name" "$path"
    done
  done <"$file"
}

# --- scan SKILL.md and role references ---------------------------------------------------------
while IFS= read -r -d '' f; do
  rel="${f#"$SKILLS_DIR"/}"
  skill="${rel%%/*}"
  [[ "$rel" == */* ]] || continue
  in_scope "$skill" || continue
  if [[ "$rel" == "$skill/SKILL.md" ]] ||
    [[ "$skill" == ja-* && "$rel" == "$skill/references/"*.md ]]; then
    scan_file "$f" "$skill" "$rel"
  fi
done < <(find -H "$SKILLS_DIR" -type f -print0)

# --- (S) symlinks -------------------------------------------------------------------------------
while IFS= read -r -d '' l; do
  rel="${l#"$SKILLS_DIR"/}"
  skill="${rel%%/*}"
  in_scope "$skill" || continue
  if [[ "$rel" != "$NODE_MODULES_REL" ]]; then
    problem "$rel: symlink is not allowed"
  elif [[ "$(readlink "$l")" != "$NODE_MODULES_TARGET" ]]; then
    problem "$rel: symlink target is not $NODE_MODULES_TARGET"
  fi
done < <(find -H "$SKILLS_DIR" -type l -print0)

if [[ -e "$SKILLS_DIR/$NODE_MODULES_REL" && ! -L "$SKILLS_DIR/$NODE_MODULES_REL" ]] && in_scope tanteki; then
  problem "$NODE_MODULES_REL: must be a symlink to $NODE_MODULES_TARGET, not a real directory"
fi

((PROBLEMS == 0)) || exit 1
