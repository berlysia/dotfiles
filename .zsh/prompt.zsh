autoload -Uz add-zsh-hook

setopt prompt_subst

typeset -A emoji
emoji[ok]=$'\U2705'
emoji[error]=$'\U274C'
emoji[git]=$'\U1F500'
emoji[git_changed]=$'\U1F37A'
emoji[git_untracked]=$'\U1F363'
emoji[git_clean]=$'\U2728'
emoji[right_arrow]=$'\U2794'

function _vcs_git_indicator () {
  typeset -A git_info
  local git_indicator git_status
  git_status=("${(f)$(git status --porcelain --branch 2> /dev/null)}")
  (( $? == 0 )) && {
    git_info[branch]="${${git_status[1]}#\#\# }"
    shift git_status
    git_info[changed]=${#git_status:#\?\?*}
    git_info[untracked]=$(( $#git_status - ${git_info[changed]} ))
    git_info[clean]=$(( $#git_status == 0 ))

    git_indicator=("${emoji[git]}  %{%F{blue}%B%}${git_info[branch]}%{%b%f%}")
    (( ${git_info[clean]}     )) && git_indicator+=("${emoji[git_clean]}")
    (( ${git_info[changed]}   )) && git_indicator+=("${emoji[git_changed]}  %{%F{yellow}%}${git_info[changed]} changed%{%f%}")
    (( ${git_info[untracked]} )) && git_indicator+=("${emoji[git_untracked]}  %{%F{red}%}${git_info[untracked]} untracked%{%f%}")
  }
  _vcs_git_indicator="${git_indicator}"
}

add-zsh-hook precmd _vcs_git_indicator

function {
  local dir='%F{green}%B%~%{%b%f%}'
  local rc="%(?,${emoji[ok]} ,${emoji[error]}  %F{red}%?%f)"

  local user
  if [ $UID -eq 0 ]; then
      user='%F{red}%B%n%b%f'
  else
      user='%F{cyan}%B%n%b%f'
  fi

  local host='%F{blue}%B%m%b%f'
  [ "$SSH_CLIENT" ] && local via="${${=SSH_CLIENT}[1]} %{%B%}${emoji[right_arrow]}%{%b%} "
  local git='$_vcs_git_indicator'
  local mark=$'\n> '
  local br=$'\n'

  PROMPT="$dir $user($via$host) $rc $git $mark"
}
