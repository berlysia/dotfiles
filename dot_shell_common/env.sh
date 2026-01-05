# Common environment variables for all shells

# XDG Base Directory specification
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

# Default editor
if type code >/dev/null 2>&1; then
  EDITOR="code --wait"
elif type emacs >/dev/null 2>&1; then
  EDITOR=emacs
fi
export EDITOR

# FZF configuration
export FZF_DEFAULT_OPTS="--height=50% --layout=reverse --info=inline --border --padding=1"

# Go configuration
export GOPATH="${GOPATH:-$HOME/go}"

if [ -f ~/local.env.sh ]; then
  . ~/local.env.sh
fi
