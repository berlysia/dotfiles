# Shell Common Configuration

This directory contains common shell configuration files that are shared between zsh and bash.

## Structure

- `init.sh` - Common entry point for both shells
- `path.sh` - Common PATH configuration
- `aliases.sh` - Common aliases
- `functions.sh` - Common shell functions
- `env.sh` - Common environment variables
- `tools.sh` - Common tool integrations (mise, opam, etc.)
- `darwin.sh` - macOS-specific common settings
- `linux.sh` - Linux-specific common settings
- `windows.sh` - Windows-specific common settings

## Usage

The common configuration is loaded from the shell-specific configuration files:

- For zsh: `~/.zsh/dot_zshrc.tmpl`
- For bash: `~/.bash/dot_bashrc`

## Design Principles

1. **Shell Detection**: The `init.sh` file detects the current shell and applies appropriate shell-specific handling.
2. **Minimal Duplication**: Common settings are defined once and used by both shells.
3. **Shell-Specific Optimizations**: Each shell can still use its own optimized implementations for certain features.
4. **Maintainability**: Changes to common settings only need to be made in one place.

## Adding New Settings

To add new common settings:

1. Identify if the setting is truly common or shell-specific
2. For common settings, add them to the appropriate common file
3. For shell-specific settings, keep them in the shell-specific configuration files

## Troubleshooting

If you encounter issues with the common configuration:

1. Check that `$HOME/.shell_common/init.sh` is being sourced correctly
2. Verify that the shell detection is working properly
3. Check for syntax errors in the common configuration files
4. Ensure that shell-specific features are properly handled
