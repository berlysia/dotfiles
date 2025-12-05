#!/bin/sh
# Common functions for all shells

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

# 1Password helper functions
_op_auth_check() {
	who=$(op whoami)
	if [[ $? != 0 ]]; then
		eval $(op signin)
	fi
}

_op_update_paths() {
	local path="$1"
	if [[ ! ":$OP_COMMAND_PATHS:" == *":$path:"* ]]; then
		export OP_COMMAND_PATHS="${OP_COMMAND_PATHS:+$OP_COMMAND_PATHS:}$path"
	fi
}

# Global 1Password commands (use ~/.env.1password and ~/.env.1password.local if exists)
oprg() {
	_op_auth_check
	local env_files=()

	if [[ -f "$HOME/.env.1password" ]]; then
		env_files+=("$HOME/.env.1password")
	fi

	if [[ -f "$HOME/.env.1password.local" ]]; then
		env_files+=("$HOME/.env.1password.local")
	fi

	if [[ ${#env_files[@]} -eq 0 ]]; then
		echo "❌ Neither ~/.env.1password nor ~/.env.1password.local found"
		return 1
	fi

	# Build env file options (op run supports multiple --env-file flags)
	local env_opts=()
	for env_file in "${env_files[@]}"; do
		env_opts+=("--env-file=$env_file")
	done

	op run "${env_opts[@]}" -- "$@"
}

# Interactive version of oprg (uses PTY to support interactive commands like claude)
oprgi() {
	_op_auth_check
	local env_files=()

	if [[ -f "$HOME/.env.1password" ]]; then
		env_files+=("$HOME/.env.1password")
	fi

	if [[ -f "$HOME/.env.1password.local" ]]; then
		env_files+=("$HOME/.env.1password.local")
	fi

	if [[ ${#env_files[@]} -eq 0 ]]; then
		echo "❌ Neither ~/.env.1password nor ~/.env.1password.local found"
		return 1
	fi

	# Build env file options (op run supports multiple --env-file flags)
	local env_opts=()
	for env_file in "${env_files[@]}"; do
		env_opts+=("--env-file=$env_file")
	done

	# Build properly escaped command string for script -c
	local cmd_quoted=""
	for arg in "$@"; do
		cmd_quoted+="$(printf '%q ' "$arg")"
	done

	op run "${env_opts[@]}" -- script -q /dev/null -c "$cmd_quoted"
}

oplg() {
	_op_auth_check
	local env_files=()
	
	if [[ -f "$HOME/.env.1password" ]]; then
		env_files+=("$HOME/.env.1password")
	fi
	
	if [[ -f "$HOME/.env.1password.local" ]]; then
		env_files+=("$HOME/.env.1password.local")
	fi
	
	if [[ ${#env_files[@]} -eq 0 ]]; then
		echo "❌ Neither ~/.env.1password nor ~/.env.1password.local found"
		return 1
	fi
	
	echo -e '⏳ Setting global secrets in environment...'
	
	# Process each file and inject into environment
	for env_file in "${env_files[@]}"; do
		echo "📁 Loading $(basename "$env_file")"
		source <(cat "$env_file" | op inject)
	done
	
	_op_update_paths "$HOME"
	echo -e '☑️ Done!'
}

# Local 1Password commands (use .env and .env.local if exists in current directory)
opr () {
	_op_auth_check
	local env_files=()

	if [[ -f "$PWD/.env" ]]; then
		env_files+=("$PWD/.env")
	fi

	if [[ -f "$PWD/.env.local" ]]; then
		env_files+=("$PWD/.env.local")
	fi

	if [[ ${#env_files[@]} -eq 0 ]]; then
		echo "❌ Neither .env nor .env.local found in current directory ($PWD)"
		echo "   Use 'oprg' to run with global env files (~/.env.1password or ~/.env.1password.local)"
		return 1
	fi

	# Build env file options (op run supports multiple --env-file flags)
	local env_opts=()
	for env_file in "${env_files[@]}"; do
		env_opts+=("--env-file=$env_file")
	done

	op run "${env_opts[@]}" -- "$@"
}

# Interactive version of opr (uses PTY to support interactive commands like claude)
opri () {
	_op_auth_check
	local env_files=()

	if [[ -f "$PWD/.env" ]]; then
		env_files+=("$PWD/.env")
	fi

	if [[ -f "$PWD/.env.local" ]]; then
		env_files+=("$PWD/.env.local")
	fi

	if [[ ${#env_files[@]} -eq 0 ]]; then
		echo "❌ Neither .env nor .env.local found in current directory ($PWD)"
		echo "   Use 'oprgi' to run with global env files (~/.env.1password or ~/.env.1password.local)"
		return 1
	fi

	# Build env file options (op run supports multiple --env-file flags)
	local env_opts=()
	for env_file in "${env_files[@]}"; do
		env_opts+=("--env-file=$env_file")
	done

	# Build properly escaped command string for script -c
	local cmd_quoted=""
	for arg in "$@"; do
		cmd_quoted+="$(printf '%q ' "$arg")"
	done

	op run "${env_opts[@]}" -- script -q /dev/null -c "$cmd_quoted"
}

export OP_COMMAND_PATHS=$OP_COMMAND_PATHS # Preserve existing values

opl () {
	_op_auth_check
	local env_files=()
	
	if [[ -f "$PWD/.env" ]]; then
		env_files+=("$PWD/.env")
	fi
	
	if [[ -f "$PWD/.env.local" ]]; then
		env_files+=("$PWD/.env.local")
	fi
	
	if [[ ${#env_files[@]} -eq 0 ]]; then
		echo "❌ Neither .env nor .env.local found in current directory ($PWD)"
		echo "   Use 'oplg' to load global env files (~/.env.1password or ~/.env.1password.local)"
		return 1
	fi
	
	echo -e '⏳ Setting local secrets in environment...'
	
	# Process each file and inject into environment
	for env_file in "${env_files[@]}"; do
		echo "📁 Loading $(basename "$env_file")"
		source <(cat "$env_file" | op inject)
	done
	
	_op_update_paths "$PWD"
	echo -e '☑️ Done!'
}

# Enhanced dotfiles health check function - now using unified test suite
dotfiles_doctor() {
  local script_path="$SHELL_COMMON/test_suite.sh"
  
  # Check if new unified test suite exists
  if [ -f "$script_path" ]; then
    # Show upgrade notice for interactive sessions (not in quiet mode)
    local show_notice=1
    for arg in "$@"; do
      case "$arg" in
        -q|--quiet) show_notice=0 ;;
      esac
    done
    
    if [ $show_notice -eq 1 ] && [ -t 1 ]; then
      echo "🚀 dotfiles_doctor() upgraded with enhanced features:" >&2
      echo "   • Weighted health scoring" >&2
      echo "   • Actionable recommendations" >&2
      echo "   • Chezmoi apply readiness status" >&2
      echo "" >&2
    fi
    
    # Execute new test suite with all arguments
    "$SHELL" "$script_path" "$@"
  elif [ -f "$SHELL_COMMON/dotfiles_doctor.sh" ]; then
    # Fallback to legacy if new suite not found
    echo "⚠️  Using legacy dotfiles_doctor.sh (consider upgrading)" >&2
    "$SHELL" "$SHELL_COMMON/dotfiles_doctor.sh" "$@"
  else
    echo "❌ Neither test_suite.sh nor dotfiles_doctor.sh found at $SHELL_COMMON/" >&2
    echo "   Please ensure dotfiles are properly installed." >&2
    return 1
  fi
}
