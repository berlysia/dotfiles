# shellcheck shell=sh
# Human-only interactive layer. Read from .zshrc / .bashrc after the is_human guard.
# Environment variables that AI shells also need go in ~/local.env.sh (read by env.sh), not here.
# shellcheck disable=SC2154 # SHELL_COMMON is set by init.sh / the rc preamble

# shellcheck source=/dev/null
[ -f "$SHELL_COMMON/aliases.sh" ] && . "$SHELL_COMMON/aliases.sh"

case "$(uname -s)" in
  Linux*)
    alias ls='ls --color=auto'
    alias grep='grep --color=auto'
    alias fgrep='fgrep --color=auto'
    alias egrep='egrep --color=auto'
    ;;
  Darwin*)
    alias showfiles='defaults write com.apple.finder AppleShowAllFiles YES; killall Finder'
    alias hidefiles='defaults write com.apple.finder AppleShowAllFiles NO; killall Finder'
    ;;
  MINGW*|MSYS*|CYGWIN*)
    alias explorer='explorer.exe'
    alias notepad='notepad.exe'
    alias cmd='cmd.exe /c'
    alias pwsh='powershell.exe -Command'
    ;;
esac

# shellcheck source=/dev/null
[ -f "$SHELL_COMMON/gomi.sh" ] && . "$SHELL_COMMON/gomi.sh"

# shellcheck source=/dev/null
[ -f "$SHELL_COMMON/interactive.sh" ] && . "$SHELL_COMMON/interactive.sh"
