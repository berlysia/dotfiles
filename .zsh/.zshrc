setopt IGNOREEOF

autoload -Uz colors
colors

autoload -Uz compinit
compinit

bindkey -e

bindkey "^[[3~" delete-char
bindkey "^?" backward-delete-char
bindkey "[D" backward-word
bindkey "[C" forward-word

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

source $ZDOTDIR/zplug.zsh
source $ZDOTDIR/alias.zsh
source $ZDOTDIR/path.zsh

source $HOME/.asdf/asdf.sh

if type nodenv &> /dev/null; then
  eval "$(nodenv init -)"
fi

if type direnv &> /dev/null; then
  if type emacs &> /dev/null; then
    export EDITOR=emacs
  fi
  eval "$(direnv hook zsh)"
fi
