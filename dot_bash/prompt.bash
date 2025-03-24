# Prompt configuration for bash

# Define colors
BLACK='\[\e[0;30m\]'
RED='\[\e[0;31m\]'
GREEN='\[\e[0;32m\]'
YELLOW='\[\e[0;33m\]'
BLUE='\[\e[0;34m\]'
MAGENTA='\[\e[0;35m\]'
CYAN='\[\e[0;36m\]'
WHITE='\[\e[0;37m\]'
BOLD_BLACK='\[\e[1;30m\]'
BOLD_RED='\[\e[1;31m\]'
BOLD_GREEN='\[\e[1;32m\]'
BOLD_YELLOW='\[\e[1;33m\]'
BOLD_BLUE='\[\e[1;34m\]'
BOLD_MAGENTA='\[\e[1;35m\]'
BOLD_CYAN='\[\e[1;36m\]'
BOLD_WHITE='\[\e[1;37m\]'
RESET='\[\e[0m\]'

# Define emoji (equivalent to zsh emoji array)
EMOJI_OK='✅'
EMOJI_ERROR='❌'
EMOJI_GIT='🔄'
EMOJI_GIT_STAGED='📝'
EMOJI_GIT_CHANGED='💬'
EMOJI_GIT_UNTRACKED='❗'
EMOJI_GIT_CLEAN='✨'
EMOJI_NODE_PACKAGE='📦'
EMOJI_RIGHT_ARROW='➔'

# Git status function (simplified version of zsh's __vcs_git_indicator)
git_status() {
    local git_status_output
    local branch
    local staged=0
    local changed=0
    local untracked=0
    local git_indicator=""
    
    # Check if we're in a git repository
    git_status_output=$(git status --porcelain --branch 2>/dev/null)
    if [ $? -eq 0 ]; then
        # Extract branch name
        branch=$(echo "$git_status_output" | head -n1 | sed 's/## //')
        
        # Count staged, changed, and untracked files
        staged=$(echo "$git_status_output" | grep -v "^?" | grep -v "^ " | wc -l)
        changed=$(echo "$git_status_output" | grep "^ " | wc -l)
        untracked=$(echo "$git_status_output" | grep "^?" | wc -l)
        
        # Build git indicator
        git_indicator="${EMOJI_GIT} ${BOLD_BLUE}${branch}${RESET}"
        
        if [ $((staged + changed + untracked)) -eq 0 ]; then
            git_indicator="${git_indicator} ${EMOJI_GIT_CLEAN}"
        else
            if [ $staged -gt 0 ]; then
                git_indicator="${git_indicator} ${EMOJI_GIT_STAGED} ${GREEN}${staged} staged${RESET}"
            fi
            if [ $changed -gt 0 ]; then
                git_indicator="${git_indicator} ${EMOJI_GIT_CHANGED} ${YELLOW}${changed} unstaged${RESET}"
            fi
            if [ $untracked -gt 0 ]; then
                git_indicator="${git_indicator} ${EMOJI_GIT_UNTRACKED} ${RED}${untracked} untracked${RESET}"
            fi
        fi
        
        echo -e "$git_indicator"
    fi
}

# JavaScript environment function (simplified version of zsh's __env_js_indicator)
js_env() {
    local package_version
    local package_name
    local node_version
    local npm_version
    local yarn_version
    local pnpm_version
    local js_indicator=""
    
    # Check if package.json exists
    if [ -f "./package.json" ]; then
        # Try to extract package name and version using jq if available
        if type jq &>/dev/null; then
            package_version=$(jq -r ".version" ./package.json 2>/dev/null)
            package_name=$(jq -r ".name" ./package.json 2>/dev/null)
            
            if [ -n "$package_version" ] && [ "$package_version" != "null" ]; then
                js_indicator="${EMOJI_NODE_PACKAGE} \e[38;5;214m${package_name}@v${package_version}\e[0m"
                
                # Add node version
                if type node &>/dev/null; then
                    node_version=$(node -v 2>/dev/null)
                    js_indicator="${js_indicator} via ${GREEN}nodejs ${node_version}${RESET}"
                fi
                
                # Check for package managers
                if [ -f "package-lock.json" ] && type npm &>/dev/null; then
                    npm_version=$(npm -v 2>/dev/null)
                    js_indicator="${js_indicator} with ${GREEN}npm v${npm_version}${RESET}"
                elif [ -f "yarn.lock" ] && type yarn &>/dev/null; then
                    yarn_version=$(yarn -v 2>/dev/null)
                    js_indicator="${js_indicator} with ${GREEN}yarn v${yarn_version}${RESET}"
                elif [ -f "pnpm-lock.yaml" ] && type pnpm &>/dev/null; then
                    pnpm_version=$(pnpm -v 2>/dev/null)
                    js_indicator="${js_indicator} with ${GREEN}pnpm v${pnpm_version}${RESET}"
                fi
            fi
        fi
    fi
    
    echo -e "$js_indicator"
}

# Set up the prompt
set_prompt() {
    # Get the exit status of the last command
    local exit_status=$?
    
    # Set up status indicator
    local status_indicator
    if [ $exit_status -eq 0 ]; then
        status_indicator="${EMOJI_OK} "
    else
        status_indicator="${EMOJI_ERROR} ${RED}${exit_status}${RESET}"
    fi
    
    # Set up user color
    local user_color
    if [ $UID -eq 0 ]; then
        user_color="${BOLD_RED}"
    else
        user_color="${BOLD_CYAN}"
    fi
    
    # Set up SSH indicator
    local via=""
    if [ -n "$SSH_CLIENT" ]; then
        via="$(echo $SSH_CLIENT | cut -d' ' -f1) ${BOLD}${EMOJI_RIGHT_ARROW}${RESET} "
    fi
    
    # Get git status
    local git_info=$(git_status)
    if [ -n "$git_info" ]; then
        git_info="\n${git_info}"
    fi
    
    # Get JavaScript environment
    local js_info=$(js_env)
    if [ -n "$js_info" ]; then
        js_info="\n${js_info}"
    fi
    
    # Current datetime
    local datetime=$(date "+%Y-%m-%d %H:%M:%S %Z(%z)")
    
    # Set the prompt
    PS1="${BOLD_GREEN}\w${RESET} ${user_color}\u${RESET}(${via}${BOLD_BLUE}\h${RESET})${status_indicator} ${BLUE}${datetime}${RESET}${js_info}${git_info}\n> "
}

# Set the prompt command to update the prompt before each command
PROMPT_COMMAND="set_prompt; $PROMPT_COMMAND"
