setopt IGNOREEOF

autoload -Uz colors
colors

autoload -Uz compinit
compinit

bindkey -e

bindkey "^[[3~" delete-char
bindkey "^?" backward-delete-char
bindkey ";5D" backward-word
bindkey ";5C" forward-word

autoload -Uz select-word-style
select-word-style default
zstyle ':zle:*' word-chars ' /=;@:{}[]()<>,|.'
zstyle ':zle:*' word-style unspecified

setopt share_history
setopt histignorealldups

HISTFILE=$ZDOTDIR/.zsh_history
HISTSIZE=10000
SAVEHIST=10000

source $ZDOTDIR/prompt.zsh

if [ "`uname`" = "Darwin" ]; then
  source $ZDOTDIR/.zshrc.darwin
elif [ "`uname`" = "Linux" ]; then
  source $ZDOTDIR/.zshrc.linux
fi

source $ZDOTDIR/path.zsh

source $HOME/.asdf/asdf.sh

if type fzf &> /dev/null; then
  function fzf-history-selection() {
    local selected=`history -E 1 | fzf | cut -b 26-`
    BUFFER=`[ ${#selected} -gt 0 ] && echo $selected || echo $BUFFER`
    CURSOR=$#BUFFER
    zle reset-prompt
  }

  zle -N fzf-history-selection
  bindkey '^R' fzf-history-selection
fi


if type fzf &> /dev/null && type rg &> /dev/null; then
  function fzgrep() {
    local MYCAT=$(type bat &> /dev/null && echo "bat" || echo "cat")
    local INITIAL_QUERY=""
    local RG_PREFIX="rg --column --line-number --no-heading --color=always --smart-case "
    FZF_DEFAULT_COMMAND="$RG_PREFIX '$INITIAL_QUERY'" \
      fzf --bind "change:reload:$RG_PREFIX {q} || true" \
          --ansi --phony --query "$INITIAL_QUERY" \
          --preview "$MYCAT `echo {} | cut -f 1 --delim \":\"`"
  }
fi

if [ -e $HOME/.zshrc.local ]; then
    source $HOME/.zshrc.local
fi

if type asdf &> /dev/null && asdf plugin list | grep direnv > /dev/null; then
  if type emacs &> /dev/null; then
    export EDITOR=emacs
  fi

  # Hook direnv into your shell.
  eval "$(asdf exec direnv hook zsh)"

  # A shortcut for asdf managed direnv.
  direnv() { asdf exec direnv "$@"; }
fi

if type opam &> /dev/null; then
  eval `opam env`
fi

# fzf completion & key-bindings (when installed fzf via brew or git)
[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

# fzf completion & key-bindings (when installed fzf via apt)
[ -f /usr/share/doc/fzf/examples/key-bindings.zsh ] && source /usr/share/doc/fzf/examples/key-bindings.zsh
[ -f /usr/share/doc/fzf/examples/completion.zsh ] && source /usr/share/doc/fzf/examples/completion.zsh

if type asdf &> /dev/null && asdf plugin list | grep python > /dev/null && type gcloud &> /dev/null; then
  export CLOUDSDK_PYTHON=`asdf which python`
fi

:
