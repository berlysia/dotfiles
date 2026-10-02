# shellcheck shell=sh
# AI-only interactive layer: only the shared gomi fragment (rm -> trash).
# shellcheck disable=SC2154 # SHELL_COMMON is set by the rc preamble
# shellcheck source=/dev/null
[ -f "$SHELL_COMMON/gomi.sh" ] && . "$SHELL_COMMON/gomi.sh"
