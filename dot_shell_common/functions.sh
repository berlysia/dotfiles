#!/bin/sh
# Common functions for all shells

# Create a directory and cd into it
mkcd() {
  mkdir -p "$1" && cd "$1"
}

# Extract various archive formats
extract() {
  if [ -f "$1" ]; then
    case "$1" in
      *.tar.bz2)   tar xjf "$1"     ;;
      *.tar.gz)    tar xzf "$1"     ;;
      *.bz2)       bunzip2 "$1"     ;;
      *.rar)       unrar e "$1"     ;;
      *.gz)        gunzip "$1"      ;;
      *.tar)       tar xf "$1"      ;;
      *.tbz2)      tar xjf "$1"     ;;
      *.tgz)       tar xzf "$1"     ;;
      *.zip)       unzip "$1"       ;;
      *.Z)         uncompress "$1"  ;;
      *.7z)        7z x "$1"        ;;
      *)           echo "'$1' cannot be extracted via extract()" ;;
    esac
  else
    echo "'$1' is not a valid file"
  fi
}

opr () {
	who=$(op whoami)
	if [[ $? != 0 ]]
	then
		eval $(op signin)
	fi
	if [[ -f "$PWD/.env" ]]; then
		op run --env-file=$PWD/.env -- $@
  elif [[ -f "$HOME/.env.1password" ]]; then
		op run --env-file=$HOME/.env.1password -- $@
	fi
}

export OP_COMMAND_PATHS=$OP_COMMAND_PATHS # Preserve existing values

opl () {
  who=$(op whoami)
  if [[ $? != 0 ]]
  then
    eval $(op signin)
  fi

  if [[ -f "$PWD/.env" ]]; then
    echo -e '⏳ Setting secrets in environment...'
    source <(cat $PWD/.env | op inject)
    # append to OP_COMMAND_PATHS
    OP_COMMAND_PATHS=$OP_COMMAND_PATHS:"$PWD"
    echo -e '☑️ Done!'
  elif [[ -f "$HOME/.env.1password" ]]; then
    echo -e '⏳ Setting secrets in environment...'
    source <(cat $HOME/.env.1password | op inject)
    OP_COMMAND_PATHS=$OP_COMMAND_PATHS:"$HOME"
    echo -e '☑️ Done!'
  fi
}
