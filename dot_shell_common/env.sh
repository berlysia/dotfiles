# Common environment variables for all shells

# Default editor
if type code &>/dev/null; then
  EDITOR="code --wait"
elif type emacs &>/dev/null; then
  EDITOR=emacs
fi
export EDITOR

# FZF configuration
export FZF_DEFAULT_OPTS="--height=50% --layout=reverse --info=inline --border --padding=1"
