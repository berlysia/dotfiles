# Shell Common Configuration

This directory contains common shell configuration files that are shared between zsh and bash, along with a comprehensive testing suite.

## Structure

### Core Configuration Files
- `init.sh` - Common entry point for both shells
- `path.sh` - Common PATH configuration
- `aliases.sh` - Common aliases
- `functions.sh` - Common shell functions
- `env.sh` - Common environment variables
- `tools.sh` - Common tool integrations (mise, opam, etc.)
- `darwin.sh` - macOS-specific common settings
- `linux.sh` - Linux-specific common settings
- `windows.sh` - Windows-specific common settings

### Testing Suite
- `test_suite.sh` - Comprehensive testing and health check system
- `executable_doctor` - Legacy wrapper for backward compatibility
- `core/` - Core testing infrastructure
  - `test_engine.sh` - Main test engine with 8 categories
  - `reporter.sh` - Test reporting and output formatting
  - `validator.sh` - Validation utilities
- `adapters/` - Environment-specific adapter pattern

## Usage

### Loading Configuration
The common configuration is loaded from the shell-specific configuration files:

- For zsh: `~/.zsh/dot_zshrc.tmpl`
- For bash: `~/.bash/dot_bashrc`

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
