#!/usr/bin/env bash
# agent-vm golden seal: runs inside the golden machine after its bootstrap, right before it is stopped and cloned.
# Called by the host launcher (home/dot_local/bin/executable_agent-vm, ensure_golden) with no arguments.
# Design: docs/decisions/0020-agent-vm-golden-clone.md (spec K6, K7, K12).
# shellcheck disable=SC2088 # "~/" appears only in error text shown to the user, never as a path
set -euo pipefail

MARKER="${AGENT_VM_MARKER:-/etc/agent-vm}"
MACHINE_ID_FILE="${AGENT_VM_MACHINE_ID_FILE:-/etc/machine-id}"
RANDOM_SEED_FILE="${AGENT_VM_RANDOM_SEED_FILE:-/var/lib/systemd/random-seed}"
# bootstrap.sh's record of what it applied (agent-vm/bootstrap.sh, last lines). Removing it makes every clone run
# bootstrap once, which re-renders the templates that use .chezmoi.hostname with the clone's own name (spec K2).
APPLIED_HASH="$HOME/.local/state/agent-vm/applied-hash"

fail() { printf 'agent-vm golden seal: %s\n' "$1" >&2; exit 1; }

[[ -f "$MARKER" ]] || fail "not an agent-vm machine ($MARKER missing)"

# The golden never receives secrets by construction (no repo mount, no secret injection, no login); this only
# detects someone having worked inside it. The list is representative, not exhaustive (spec K6).
recover="every clone would inherit it; recover on the host: agent-vm golden rm"
for f in .claude/.credentials.json .codex/auth.json .config/gh/hosts.yml .git-credentials .netrc \
  .docker/config.json .bash_history .zsh_history .claude/history.jsonl .aws .config/gcloud; do
  # -L as well: a dangling symlink fails -e but still points a clone at something.
  [[ ! -e "$HOME/$f" && ! -L "$HOME/$f" ]] || fail "~/$f exists in the golden machine; $recover"
done
for f in "$HOME"/.ssh/id_*; do
  [[ ! -e "$f" && ! -L "$f" ]] || fail "~/.ssh/$(basename "$f") exists in the golden machine; $recover"
done
if [[ -f "$HOME/.npmrc" ]] && grep -q '_authToken' "$HOME/.npmrc"; then
  fail "~/.npmrc holds an npm token in the golden machine; $recover"
fi
if [[ -f "$HOME/.claude.json" ]] && [[ "$(jq -r 'has("oauthAccount")' "$HOME/.claude.json")" != false ]]; then
  fail "~/.claude.json has a logged-in account in the golden machine; $recover"
fi

# Identifiers a fresh machine would have to itself: systemd creates a new machine-id at first boot when the file
# is empty (measured on OrbStack: each clone gets its own, kept across restarts), and a new random seed.
sudo truncate -s 0 "$MACHINE_ID_FILE"
sudo rm -f "$RANDOM_SEED_FILE"

# Claude Code regenerates userID and machineID on its next start (measured on a real golden), so clones do not share them.
if [[ -f "$HOME/.claude.json" ]]; then
  tmp=$(mktemp "$HOME/.claude.json.XXXXXX") || fail "cannot create a temp file next to ~/.claude.json"
  jq 'del(.userID, .machineID)' "$HOME/.claude.json" >"$tmp" || { rm -f "$tmp"; fail "could not drop the claude identifiers"; }
  [[ -s "$tmp" ]] || { rm -f "$tmp"; fail "dropping the claude identifiers produced nothing"; }
  chmod --reference="$HOME/.claude.json" "$tmp"
  mv "$tmp" "$HOME/.claude.json"
fi

rm -f "$APPLIED_HASH" 2>/dev/null || fail "could not remove $APPLIED_HASH"
[[ ! -e "$APPLIED_HASH" ]] || fail "could not remove $APPLIED_HASH"
