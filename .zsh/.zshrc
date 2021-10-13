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

if [ $+commands[brew] -a -f $(brew --prefix)/etc/brew-wrap ]; then
  source $(brew --prefix)/etc/brew-wrap
fi

if [ -e $HOME/.zshrc.local ]; then
    source $HOME/.zshrc.local
fi

if type direnv &> /dev/null; then
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
