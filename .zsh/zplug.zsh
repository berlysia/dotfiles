export ZPLUG_HOME=$ZDOTDIR/.zplug
if [ ! -e $ZPLUG_HOME/init.zsh ]; then
    git clone https://github.com/zplug/zplug $ZPLUG_HOME
fi
source $ZPLUG_HOME/init.zsh

zplug "jimeh/zsh-peco-history"

if ! zplug check; then
    zplug install
fi

zplug load
