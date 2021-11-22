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
emoji[node_package]=$'\U1F4E6'
emoji[right_arrow]=$'\U2794'

readonly local br=$'\n'
readonly local rawbr="
"

local vcs_git_indicator
function __vcs_git_indicator () {
  typeset -A git_info
  typeset -a git_indicator
  local git_status
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

    git_indicator+=("${emoji[git]} %{%F{blue}%B%}${git_info[branch]}%{%b%f%}")
    (( ${git_info[clean]}     )) && git_indicator+=("${emoji[git_clean]}")
    (( ${git_info[staged]}    )) && git_indicator+=("${emoji[git_staged]} %{%F{green}%}${git_info[staged]} staged%{%f%}")
    (( ${git_info[changed]}   )) && git_indicator+=("${emoji[git_changed]} %{%F{yellow}%}${git_info[changed]} unstaged%{%f%}")
    (( ${git_info[untracked]} )) && git_indicator+=("${emoji[git_untracked]} %{%F{red}%}${git_info[untracked]} untracked%{%f%}")
  }

  vcs_git_indicator="$git_indicator"
  if [ -n "$git_indicator" ]; then
    vcs_git_indicator+=$rawbr
  fi
}

add-zsh-hook precmd __vcs_git_indicator

local env_js_indicator env_js_indicator_cached env_js_lastpwd
function __env_js_indicator() {
  typeset -a js_indicator js_package_version
  local package_version
  package_version=$(grep -oP '(?<="version": ")(.+?)(?=")' ./package.json 2> /dev/null)
  (( $? == 0 )) && {
    js_package_version+=("${emoji[node_package]} %F{214}v$package_version%f")

    if [ "$env_js_lastpwd" != "$PWD" ]; then
      local node_version
      ## 回数減らすならそのまま叩いてよさそう
      # if type asdf > /dev/null; then
      #   local res=(`asdf current nodejs 2> /dev/null`)
      #   (( ${#res[@]} > 0 )) && {
      #     node_version=${res[2]}
      #   }
      # fi

      if  [ -z "$node_version" ]; then
        node_version=$(node -v 2> /dev/null)
      fi

      if [ -n "$node_version" ]; then
        js_indicator+=("via %F{green}nodejs $node_version%f")
      fi

      # super slow
      if [ -e package-lock.json ]; then
        npm_version=$(npm -v 2> /dev/null)
        (( $? == 0 )) && {
          js_indicator+=("with %F{green}npm v$npm_version%f")
        }
      fi

      # super slow
      if [ -e yarn.lock ]; then
        yarn_version=$(yarn -v 2> /dev/null)
        (( $? == 0 )) && {
          js_indicator+=("with %F{green}yarn v$yarn_version%f")
        }
      fi

      env_js_indicator_cached="$js_indicator"
    fi
  }

  if (( ${#js_package_version} > 0 )); then
    env_js_indicator="$js_package_version $env_js_indicator_cached$rawbr"
  else
    env_js_indicator=""
  fi

  env_js_lastpwd=$PWD
}

add-zsh-hook precmd __env_js_indicator

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
  local js='$env_js_indicator'
  local mark=$'> '
  local datetime=$'%D{%Y-%m-%d %H:%M:%S %Z(%z)}'

  # 最初は表示時の時刻が出る
  PROMPT="$dir $user($via$host)$rc %F{blue}$datetime%f $br$js$git$mark"
  # コマンド実行すると実行時の時刻が残る
  BASE_PROMPT="$dir $user($via$host)$rc %F{magenta}$datetime%f $br$js$git$mark"
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
