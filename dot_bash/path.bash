# Path configuration for bash

# Save original PATH to avoid duplication when re-sourcing
if [ -z "$ORIGINAL_PATH" ]; then
    ORIGINAL_PATH="$PATH"
else
    PATH="$ORIGINAL_PATH"
fi

# Add directories to PATH
# Equivalent to zsh's path=(...) array
PATH="$HOME/.local/bin:$PATH"
PATH="$HOME/.local/.bin:$PATH"
PATH="$HOME/.deno/bin:$PATH"
PATH="$HOME/google-cloud-sdk/bin:$PATH"
PATH="$HOME/workspace/depot_tools:$PATH"

export PATH

# Note: fpath in zsh is for function path
# Bash doesn't have a direct equivalent, but we can set up
# a similar mechanism for bash completion if needed
if [ -d "$HOME/.bash/completions" ]; then
    for f in "$HOME/.bash/completions"/*; do
        [ -f "$f" ] && . "$f"
    done
fi
