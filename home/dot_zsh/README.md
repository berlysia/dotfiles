# Zsh Configuration

This directory contains the Zsh configuration managed by chezmoi.

## Files

- `dot_zshenv` - Environment variables (loaded first by Zsh)
- `dot_zshrc` - Interactive shell configuration

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
