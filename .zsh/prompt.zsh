autoload -Uz add-zsh-hook

setopt prompt_subst

typeset -A emoji
emoji[ok]=$'\U2705'
emoji[error]=$'\U274C'
emoji[git]=$'\U1F500'
emoji[git_staged]=$'\U1F4DD'
emoji[git_changed]=$'\U1F4AC'
emoji[git_untracked]=$'\U2757'
emoji[git_clean]=$'\U2728'
emoji[right_arrow]=$'\U2794'

local vcs_git_indicator
function __vcs_git_indicator () {
  typeset -A git_info
  local git_indicator git_status
  git_status=("${(f)$(git status --porcelain --branch 2> /dev/null)}")
  (( $? == 0 )) && {
    git_info[branch]="${${git_status[1]}#\#\# }"
    shift git_status
    git_info[all]=$#git_status
    git_info[tracked]=${#git_status:#\?\?*} # untrackじゃないもの
    git_info[untracked]=$(( ${git_info[all]} - ${git_info[tracked]}))
    git_info[staged]=$(( ${#git_status:# ?*} - ${git_info[untracked]} )) # 1文字目が空白じゃなくてuntrackではないもの（untrackが/^??/にマッチする前提
    git_info[changed]=${#git_status:#? *} # 2文字目が空白じゃないもの
    git_info[clean]=$(( ${git_info[all]} == 0 ))

    git_indicator=("${emoji[git]}  %{%F{blue}%B%}${git_info[branch]}%{%b%f%}")
    (( ${git_info[clean]}     )) && git_indicator+=("${emoji[git_clean]}")
    (( ${git_info[staged]}    )) && git_indicator+=("${emoji[git_staged]} %{%F{green}%}${git_info[staged]} staged%{%f%}")
    (( ${git_info[changed]}   )) && git_indicator+=("${emoji[git_changed]} %{%F{yellow}%}${git_info[changed]} unstaged%{%f%}")
    (( ${git_info[untracked]} )) && git_indicator+=("${emoji[git_untracked]} %{%F{red}%}${git_info[untracked]} / ${git_info[changed]} untracked%{%f%}")
  }

  # 使うときに改行を処理したいが、すぐできなかったのでここで埋めている
  if [ -n "$git_indicator" ]; then
    vcs_git_indicator="${git_indicator}
"
  else
    vcs_git_indicator=""
  fi
}

add-zsh-hook precmd __vcs_git_indicator

function {
  local dir='%F{green}%B%~%{%b%f%}'
  local rc="%(?,${emoji[ok]} ,${emoji[error]} %F{red}%?%f)"
  local br=$'\n'

  local user
  if [ $UID -eq 0 ]; then
      user='%F{red}%B%n%b%f'
  else
      user='%F{cyan}%B%n%b%f'
  fi

  local host='%F{blue}%B%m%b%f'
  [ "$SSH_CLIENT" ] && local via="${${=SSH_CLIENT}[1]} %{%B%}${emoji[right_arrow]}%{%b%} "
  local git='$vcs_git_indicator'
  local mark=$'> '
  local datetime=$'%D{%Y-%m-%d %H:%M:%S %Z(%z)}'

  # 最初は表示時の時刻が出る
  PROMPT="$dir $user($via$host)$rc %F{blue}$datetime%f $br$git$mark"
  # コマンド実行すると実行時の時刻が残る
  BASE_PROMPT="$dir $user($via$host)$rc %F{magenta}$datetime%f $br$git$mark"
}

function __rewrite_on_accept() {
  if [[ ${#PROMPT} -ne ${#BASE_PROMPT} ]]; then
    local saved=$PROMPT
    PROMPT=$BASE_PROMPT
    zle reset-prompt
    PROMPT=$saved
  fi
  zle accept-line
}
zle -N __rewrite_on_accept
bindkey '^M' __rewrite_on_accept
