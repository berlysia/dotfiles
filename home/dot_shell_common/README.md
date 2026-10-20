# Shell Common Configuration

This directory contains common shell configuration files that are shared between zsh and bash, along with a comprehensive testing suite.

## Structure

- `init.sh` is the common entry point for both shells. It detects the current shell and sources the other files in this directory (PATH, aliases, functions, environment variables, tool integrations, and per-OS settings).
- `test_suite.sh` is the testing and health check system. `core/` holds its engine (8 test categories), reporter, and validators, and `adapters/` holds the environment-specific adapters.
- `executable_doctor` is deployed as `doctor`, a thin wrapper around `test_suite.sh` that supplies default arguments.

Use `git ls-files home/dot_shell_common` for the file list.

## Usage

### Loading Configuration

The common configuration is loaded from the shell-specific configuration files:

- For zsh: `~/.zshrc` (source: `home/dot_zshrc`)
- For bash: `~/.bashrc`

### Health Checks

Run comprehensive health checks on your dotfiles setup:

```bash
# Full health check
./test_suite.sh

# Check specific categories
./test_suite.sh --categories=core,tools

# Verbose output
./test_suite.sh -v

# Quiet mode
./test_suite.sh -q
```

### Test Categories

- **core** - Essential commands (sh, bash, git, curl, chezmoi)
- **tools** - Development tools (rg, fzf, bat, jq, mise)
- **languages** - Programming language runtimes
- **development** - Development environment (starship, gh, vim)
- **security** - Security tools (age, 1password-cli)
- **config** - Configuration files and directories
- **shell** - Shell compatibility and features
- **integration** - Shell functions and aliases integration

## Design Principles

1. **Shell Detection**: The `init.sh` file detects the current shell and applies appropriate shell-specific handling.
2. **Minimal Duplication**: Common settings are defined once and used by both shells.
3. **Shell-Specific Optimizations**: Each shell can still use its own optimized implementations for certain features.
4. **Maintainability**: Changes to common settings only need to be made in one place.
5. **Testing-First**: Comprehensive testing ensures reliability across environments.

## Adding New Settings

To add new common settings:

1. Identify if the setting is truly common or shell-specific
2. For common settings, add them to the appropriate common file
3. For shell-specific settings, keep them in the shell-specific configuration files
4. Add appropriate tests to the test suite for verification

## Troubleshooting

If you encounter issues with the common configuration:

1. Run `./test_suite.sh` to identify problems
2. Check that `$HOME/.shell_common/init.sh` is being sourced correctly
3. Verify that the shell detection is working properly
4. Check for syntax errors in the common configuration files
5. Ensure that shell-specific features are properly handled

Use the testing suite to validate your configuration and get actionable recommendations for fixes.
