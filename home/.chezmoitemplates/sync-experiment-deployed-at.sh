# Keeps ~/.claude/logs/auto-mode-experiment/deployed-at in step with whether the
# home-destruction guard is registered in the hooks about to be deployed: created
# (or rewritten when it fails validation) while the guard is registered, removed
# otherwise. Never fails the caller; every problem is a warning on stderr.
# The four literals below must equal the constants in
# dot_claude/hooks/lib/auto-mode-experiment.ts (checked by
# sync-experiment-deployed-at.test.ts).
sync_experiment_deployed_at() {
    local hooks_json="$1"
    local dir="$HOME/.claude/logs/auto-mode-experiment"
    local file="$dir/deployed-at"
    local guard="implementations/home-destruction-guard.ts"
    local iso='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
    local registered now current tmp

    if [ -z "${HOME:-}" ]; then
        echo "WARNING: HOME is not set; deployed-at was not synced" >&2
        return 0
    fi
    if ! registered=$(printf '%s' "$hooks_json" | jq -r --arg g "$guard" \
        '[.. | objects | .command? | strings | select(contains($g))] | length' 2>/dev/null); then
        echo "WARNING: could not read the hooks to sync $file; left as is" >&2
        return 0
    fi
    if [ -L "$dir" ] || [ -L "$file" ]; then
        echo "WARNING: $dir or $file is a symlink; deployed-at was not synced" >&2
        return 0
    fi

    if [ "$registered" = "0" ]; then
        if [ -f "$file" ] && ! rm -f "$file"; then
            echo "WARNING: could not remove $file" >&2
        fi
        return 0
    fi

    if ! now=$(date -u +%Y-%m-%dT%H:%M:%SZ); then
        echo "WARNING: could not read the clock; deployed-at was not synced" >&2
        return 0
    fi
    if [ -f "$file" ]; then
        current=$(head -c 64 "$file" | head -n 1) || current=""
        # Same-format ISO strings order as text, so this is "not later than now".
        if [[ "$current" =~ $iso ]] && [[ ! "$current" > "$now" ]]; then
            return 0
        fi
    elif [ -e "$file" ]; then
        echo "WARNING: $file is not a regular file; deployed-at was not synced" >&2
        return 0
    fi

    if ! (umask 077 && mkdir -p "$dir" && chmod 700 "$dir"); then
        echo "WARNING: could not create $dir; deployed-at was not written" >&2
        return 0
    fi
    if ! tmp=$(mktemp "$dir/.deployed-at.XXXXXX"); then
        echo "WARNING: could not create a temp file in $dir; deployed-at was not written" >&2
        return 0
    fi
    if ! { printf '%s\n' "$now" > "$tmp" && mv -f "$tmp" "$file"; }; then
        rm -f "$tmp" || true
        echo "WARNING: could not write $file" >&2
    fi
    return 0
}
