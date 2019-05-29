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

case ${OSTYPE} in
    darwin*)
        source $ZDOTDIR/.zshrc.darwin
        ;;
    linux*)
        source $ZDOTDIR/.zshrc.linux
        ;;
esac

source $ZDOTDIR/zplug.zsh
source $ZDOTDIR/alias.zsh

if [ $+commands[brew] -a -f $(brew --prefix)/etc/brew-wrap ]; then
  source $(brew --prefix)/etc/brew-wrap
fi

source $ZDOTDIR/path.zsh

if type rbenv &> /dev/null; then
  eval "$(rbenv init -)"
fi

if type nodenv &> /dev/null; then
  eval "$(nodenv init -)"
fi

if type direnv &> /dev/null; then
  if type emacs &> /dev/null; then
    export EDITOR=emacs
  fi
  eval "$(direnv hook zsh)"
fi
