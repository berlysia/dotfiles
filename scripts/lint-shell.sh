#!/usr/bin/env bash
# shellcheck shell=bash
# Single source of truth for shellcheck target discovery.
# Local development, the pre-commit hook and CI all invoke this script, and all use
# the shellcheck version pinned in .mise.toml.
#
# Usage:
#   scripts/lint-shell.sh            check every shell file in the repository
#   scripts/lint-shell.sh <path>...  check only these paths (relative to the repository
#                                    root); each path is classified like a discovered file
#
# Exit codes: 0 all passed / 1 findings / 2 a required tool is missing or does not match
# the pin (nothing was checked).
#
# To count findings, run this script rather than `shellcheck a.sh b.sh ...`.
# A multi-file call treats every listed file as input, so sources between
# them resolve and their notes disappear. Editors and this script check one
# file at a time, which is the count that matters.

set -euo pipefail
# bash 5.2+ expands '&' in the replacement of ${var//pat/repl}; file names must stay literal.
shopt -u patsub_replacement 2>/dev/null || true

# Paths from the pre-commit hook and the find below are relative to the repository root.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "Running shellcheck (version pinned in .mise.toml)..."

# Directories to ignore during target discovery
IGNORE_PATHS=(
  "node_modules"
  ".git"
  ".tmp"
)

# Render targets. Only .chezmoi.os and .chezmoi.kernel.osrelease decide the branches in *.sh.tmpl
# today; the osrelease values are stand-ins for that decision. Add a target here if a template
# starts to branch on other data.
RENDER_TARGETS=(
  'darwin|{"chezmoi":{"os":"darwin","kernel":{"osrelease":"25.0.0"}}}'
  'linux|{"chezmoi":{"os":"linux","kernel":{"osrelease":"6.8.0-generic"}}}'
  'linux-wsl|{"chezmoi":{"os":"linux","kernel":{"osrelease":"6.6.87.2-microsoft-standard-WSL2"}}}'
)

readonly SHELLCHECK_TOOL="github:koalaman/shellcheck"

# classify_path <path>: prints sh | tmpl | shebang | skip.
# Shebang detection is by content rather than by a name list, so a newly added
# extensionless script (git hooks, chezmoi executable_* / modify_* files) is covered
# without touching this script again.
classify_path() {
  local path=$1
  if [[ ! -f "$path" ]]; then
    echo skip
    return
  fi
  case "$path" in
    *.sh.tmpl) echo tmpl ;;
    *.sh) echo sh ;;
    *)
      if head -n 1 -- "$path" 2>/dev/null |
        grep -qE '^#!.*[/ ](bash|sh|dash|ksh)$|^#!.*env +(bash|sh)'; then
        echo shebang
      else
        echo skip
      fi
      ;;
  esac
}

# Collect candidate paths: arguments in path mode, a find over the repository otherwise.
# Use while-read loops instead of mapfile for macOS compatibility (Bash 3.2)
CANDIDATES=()
if [[ $# -gt 0 ]]; then
  CANDIDATES=("$@")
else
  FIND_ARGS=()
  for ignore in "${IGNORE_PATHS[@]}"; do
    FIND_ARGS+=(-not -path "*/${ignore}/*")
  done
  while IFS= read -r file; do
    CANDIDATES+=("$file")
  done < <(find . -type f "${FIND_ARGS[@]}" | sort)
fi

SHELL_FILES=()
TEMPLATE_FILES=()
SCRIPT_FILES=()
if [[ ${#CANDIDATES[@]} -gt 0 ]]; then
  for file in "${CANDIDATES[@]}"; do
    case "$(classify_path "$file")" in
      sh) SHELL_FILES+=("$file") ;;
      tmpl) TEMPLATE_FILES+=("$file") ;;
      shebang) SCRIPT_FILES+=("$file") ;;
    esac
  done
fi

TOTAL=$((${#SHELL_FILES[@]} + ${#TEMPLATE_FILES[@]} + ${#SCRIPT_FILES[@]}))
if [[ ${TOTAL} -eq 0 ]]; then
  echo -e "${YELLOW}No shell files found to check${NC}"
  exit 0
fi

echo "Found ${#SHELL_FILES[@]} .sh, ${#TEMPLATE_FILES[@]} .sh.tmpl and ${#SCRIPT_FILES[@]} shebang-detected file(s) to check"
echo ""

print_recovery() {
  echo "recover: mise install ${SHELLCHECK_TOOL}   (in the repository root; run \`mise trust\` first if mise reports a trust error)"
  echo "recover: if GitHub rate-limits the download: MISE_GITHUB_TOKEN=\$(gh auth token) mise install ${SHELLCHECK_TOOL}"
  echo "recover: if the versions differ, remove local overrides (.mise.local.toml, MISE_ENV) and install the pinned version"
}

# resolve_shellcheck: sets SHELLCHECK to the binary of the version pinned in .mise.toml, or
# exits 2. Called only when there is something to check.
resolve_shellcheck() {
  local pinned dir actual
  # .mise.toml must hold this exact line: "github:koalaman/shellcheck" = "<version>"
  pinned=$(sed -n 's/^"github:koalaman\/shellcheck"[[:space:]]*=[[:space:]]*"\([0-9][0-9.]*\)"[[:space:]]*$/\1/p' .mise.toml 2>/dev/null | head -n 1 || true)
  if ! command -v mise >/dev/null 2>&1; then
    echo -e "${RED}mise is required to run the pinned shellcheck but was not found${NC}"
    print_recovery
    exit 2
  fi
  if [[ -z "$pinned" ]]; then
    echo -e "${RED}.mise.toml has no line of the form: \"${SHELLCHECK_TOOL}\" = \"<version>\"${NC}"
    print_recovery
    exit 2
  fi
  if ! dir=$(mise where "$SHELLCHECK_TOOL" 2>/dev/null); then
    echo -e "${RED}shellcheck ${pinned} (${SHELLCHECK_TOOL}) is not installed${NC}"
    print_recovery
    exit 2
  fi
  SHELLCHECK="$dir/shellcheck"
  if ! actual=$("$SHELLCHECK" --version 2>/dev/null); then
    echo -e "${RED}${SHELLCHECK} could not be run${NC}"
    print_recovery
    exit 2
  fi
  actual=$(printf '%s\n' "$actual" | sed -n 's/^version: //p')
  if [[ "$actual" != "$pinned" ]]; then
    echo -e "${RED}shellcheck version mismatch: .mise.toml pins ${pinned}, running ${actual:-unknown}${NC}"
    print_recovery
    exit 2
  fi
  echo "version: ${actual}"
}

resolve_shellcheck

if [[ ${#TEMPLATE_FILES[@]} -gt 0 ]] && ! command -v chezmoi >/dev/null 2>&1; then
  echo -e "${RED}chezmoi is required to lint .sh.tmpl files but was not found${NC}"
  echo "Install chezmoi (https://www.chezmoi.io/install/) and re-run."
  exit 2
fi

# Run shellcheck with repository-standard settings
# Note: .shellcheckrc will be automatically loaded
# `--` keeps a file name that starts with '-' from being read as an option.
FAILED=0

if [[ ${#SHELL_FILES[@]} -gt 0 ]]; then
  for file in "${SHELL_FILES[@]}"; do
    echo "Checking: $file"
    "$SHELLCHECK" -- "$file" || FAILED=1
  done
fi

if [[ ${#SCRIPT_FILES[@]} -gt 0 ]]; then
  for file in "${SCRIPT_FILES[@]}"; do
    echo "Checking (shebang-detected): $file"
    "$SHELLCHECK" -- "$file" || FAILED=1
  done
fi

# .sh.tmpl: render via chezmoi execute-template once per render target, then shellcheck the
# rendered output. Output paths are rewritten back to the original .sh.tmpl path (plus the
# target) so users can navigate to the source location.
if [[ ${#TEMPLATE_FILES[@]} -gt 0 ]]; then
  # Source path for chezmoi execute-template. This repo follows the convention
  # of placing source state under ./home (see .chezmoiroot at the repo root).
  CHEZMOI_SOURCE_PATH="${PWD}/home"

  TMPDIR_RENDER=$(mktemp -d)
  trap 'rm -rf "${TMPDIR_RENDER}"' EXIT
  trap 'exit 130' INT TERM

  # Make .shellcheckrc directives (e.g., disable=SC1090) reachable from the
  # rendered file's directory, since the linter walks up from each file's dir
  # to find the rc file.
  if [[ -f "${PWD}/.shellcheckrc" ]]; then
    cp "${PWD}/.shellcheckrc" "${TMPDIR_RENDER}/.shellcheckrc"
  fi

  for file in "${TEMPLATE_FILES[@]}"; do
    # Deterministic, collision-free name so the linter diagnostics carry a
    # recognisable suffix; the target is part of the name so the targets do not overwrite
    # each other.
    rendered_name=$(echo "${file#./}" | tr '/' '_')
    checked_any=0

    for entry in "${RENDER_TARGETS[@]}"; do
      target=${entry%%|*}
      json=${entry#*|}
      rendered="${TMPDIR_RENDER}/${target}_${rendered_name%.tmpl}"

      if ! chezmoi execute-template --source "${CHEZMOI_SOURCE_PATH}" --override-data "$json" < "$file" > "$rendered" 2>"${TMPDIR_RENDER}/render.err"; then
        echo -e "${RED}Template render failed (${target}): $file${NC}"
        cat "${TMPDIR_RENDER}/render.err" >&2
        FAILED=1
        checked_any=1
        continue
      fi

      # Skip empty renders: when a template is OS-gated (e.g., darwin-only on
      # Linux), the rendered output may be empty or whitespace-only. There is
      # nothing meaningful to lint in that case.
      if ! grep -qv '^[[:space:]]*\(#.*\)\?$' "$rendered" 2>/dev/null; then
        echo "Skipping (empty render for ${target}): $file"
        continue
      fi

      checked_any=1
      echo "Checking (rendered: ${target}): $file"
      repl="$file (rendered: ${target})"
      # --shell=bash forces shell detection for templates that may render
      # without a shebang on certain OS branches.
      out=$("$SHELLCHECK" --shell=bash -- "$rendered" 2>&1) || FAILED=1
      if [[ -n "$out" ]]; then
        while IFS= read -r line; do
          relabelled=${line//"$rendered"/$repl}
          printf '%s\n' "$relabelled"
        done <<<"$out"
      fi
    done

    if [[ $checked_any -eq 0 ]]; then
      echo "NOTE: $file renders empty for every target"
    fi
  done
fi

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo -e "${GREEN}✓ All shell scripts passed shellcheck${NC}"
  exit 0
else
  echo -e "${RED}✗ Some shell scripts failed shellcheck${NC}"
  exit 1
fi
