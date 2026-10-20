# Zsh Configuration

`~/.zsh/` holds auxiliary files for zsh (prompt, completion dump, history). The entry points are `~/.zshenv` and `~/.zshrc`, managed by chezmoi as `home/dot_zshenv` and `home/dot_zshrc`.

## Files

- `../dot_zshenv` - Environment variables (loaded first by Zsh)
- `../dot_zshrc` - Interactive shell configuration
- `dot_zshenv` - Transitional only: shells that inherited `ZDOTDIR=$HOME/.zsh` read this instead of `~/.zshenv`. It drops `ZDOTDIR` and loads the real entry

## Key Features

- **Profiling support**: `zsh-profiler` function for performance debugging
- **History**: 2000 entries, shared across sessions
- **Key bindings**: Emacs style
- **Platform support**: Darwin (macOS), Linux, WSL
- **Tool integrations**: fzf, mise, direnv, etc.
- **Local overrides**: `~/.zshrc.local` for machine-specific settings

## Custom Prompt

The configuration includes a feature-rich prompt with:

- Git status integration (branch, dirty state)
- Node.js project info (package version, runtime version)
- Error status indication
- SSH connection awareness
- Command timestamp

## Migration Notes

When porting to another environment:

1. Review tool integrations (fzf, mise) based on availability
2. Adapt platform-specific sections as needed
3. Maintain `~/.zshrc.local` support for local overrides
