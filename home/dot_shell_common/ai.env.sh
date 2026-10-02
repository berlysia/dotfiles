# shellcheck shell=sh
# Non-interactive defaults for AI-driven shells. Read after env.sh so these override it.
# Mirrored in home/dot_codex/.config.toml [shell_environment_policy.set] (tests/shell-gate assert 4).
export EDITOR=true
export VISUAL=true
export GIT_EDITOR=true
export GIT_SEQUENCE_EDITOR=true
export PAGER=cat
export GIT_PAGER=cat
export MANPAGER=cat
export GIT_TERMINAL_PROMPT=0
