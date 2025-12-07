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
_ope_auth_check() {
	op whoami >/dev/null 2>&1 || eval $(op signin)
}

_ope_update_paths() {
	local path="$1"
	if [[ ! ":$OP_COMMAND_PATHS:" == *":$path:"* ]]; then
		export OP_COMMAND_PATHS="${OP_COMMAND_PATHS:+$OP_COMMAND_PATHS:}$path"
	fi
}

# Get env files based on scope (outputs file paths, one per line)
_ope_get_env_files() {
	local scope="$1"
	if [[ "$scope" == "global" ]]; then
		[[ -f "$HOME/.env.1password" ]] && echo "$HOME/.env.1password"
		[[ -f "$HOME/.env.1password.local" ]] && echo "$HOME/.env.1password.local"
	else
		[[ -f "$PWD/.env" ]] && echo "$PWD/.env"
		[[ -f "$PWD/.env.local" ]] && echo "$PWD/.env.local"
	fi
}

# Unified 1Password environment helper
# Usage: ope [-g|--global] [-i|--interactive] [-l|--load] [command...]
#   -g, --global       Use global env files (~/.env.1password*)
#   -i, --interactive  Interactive mode (PTY for commands like claude)
#   -l, --load         Load/inject secrets into current shell
#   -h, --help         Show help
ope() {
	local global=false interactive=false load=false

	# Parse flags
	while [[ $# -gt 0 ]]; do
		case "$1" in
			-g|--global)  global=true; shift ;;
			-i|--interactive)  interactive=true; shift ;;
			-l|--load)  load=true; shift ;;
			-gi|-ig) global=true; interactive=true; shift ;;
			-gl|-lg) global=true; load=true; shift ;;
			-il|-li) interactive=true; load=true; shift ;;  # Invalid but handle gracefully
			-h|--help)
				echo "Usage: ope [-g|--global] [-i|--interactive] [-l|--load] [command...]"
				echo ""
				echo "Flags:"
				echo "  -g, --global       Use global env files (~/.env.1password, ~/.env.1password.local)"
				echo "  -i, --interactive  Interactive mode (uses PTY for commands like claude)"
				echo "  -l, --load         Load/inject secrets into current shell environment"
				echo "  -h, --help         Show this help"
				echo ""
				echo "Examples:"
				echo "  ope npm start          # Run with local .env"
				echo "  ope -g npm start       # Run with global env"
				echo "  ope -i claude          # Interactive command with local env"
				echo "  ope -gi claude         # Interactive command with global env"
				echo "  ope -l                 # Load local env into shell"
				echo "  ope -gl                # Load global env into shell"
				echo ""
				echo "Aliases: opr, opri, opl, oprg, oprgi, oplg (for backward compatibility)"
				return 0
				;;
			-*) echo "❌ Unknown flag: $1"; ope -h; return 1 ;;
			*)  break ;;
		esac
	done

	_ope_auth_check

	# Determine scope
	local scope="local"
	$global && scope="global"

	# Get env files
	local env_files=()
	while IFS= read -r file; do
		[[ -n "$file" ]] && env_files+=("$file")
	done < <(_ope_get_env_files "$scope")

	# Check if env files exist
	if [[ ${#env_files[@]} -eq 0 ]]; then
		if $global; then
			echo "❌ Neither ~/.env.1password nor ~/.env.1password.local found"
		else
			echo "❌ Neither .env nor .env.local found in current directory ($PWD)"
			echo "   Use 'ope -g' to use global env files"
		fi
		return 1
	fi

	# Execute based on mode
	if $load; then
		local scope_label="local"
		local update_path="$PWD"
		if $global; then
			scope_label="global"
			update_path="$HOME"
		fi

		echo "⏳ Setting $scope_label secrets in environment..."
		for env_file in "${env_files[@]}"; do
			echo "📁 Loading $(basename "$env_file")"
			source <(cat "$env_file" | op inject)
		done
		_ope_update_paths "$update_path"
		echo "☑️ Done!"
	else
		# Build --env-file options
		local env_opts=()
		for env_file in "${env_files[@]}"; do
			env_opts+=("--env-file=$env_file")
		done

		if $interactive; then
			# Build properly escaped command string for script
			local cmd_quoted=""
			for arg in "$@"; do
				cmd_quoted+="$(printf '%q ' "$arg")"
			done
			# script command syntax differs between Linux and macOS
			if [[ "$(uname)" == "Darwin" ]]; then
				# macOS: script [-q] file command
				op run "${env_opts[@]}" -- script -q /dev/null bash -c "$cmd_quoted"
			else
				# Linux: script [-q] -c command file
				op run "${env_opts[@]}" -- script -q /dev/null -c "$cmd_quoted"
			fi
		else
			op run "${env_opts[@]}" -- "$@"
		fi
	fi
}

export OP_COMMAND_PATHS=$OP_COMMAND_PATHS # Preserve existing values

# Backward-compatible aliases for ope
opr()   { ope "$@"; }
opri()  { ope -i "$@"; }
opl()   { ope -l; }
oprg()  { ope -g "$@"; }
oprgi() { ope -gi "$@"; }
oplg()  { ope -gl; }

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
