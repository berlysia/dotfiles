# Zsh Configuration Structure

This directory contains a modular Zsh configuration setup that can be easily ported to other environments. The configuration is split into several focused files for better organization and maintainability.

## Directory Structure

```
dot_zsh/
├── darwin.zsh      # macOS-specific configurations
├── dot_zshrc.tmpl  # Main Zsh configuration template
├── path.zsh        # Path and fpath configurations
├── prompt.zsh      # Custom prompt configuration
└── windows.zsh     # Windows-specific configurations
```

## Component Details

### 1. Main Configuration (`dot_zshrc.tmpl`)

The main configuration file that sets up core Zsh behavior and sources other configuration files. Key features:

- Profiling support (via `zsh-profiler` function)
- Basic Zsh options and key bindings
- History configuration
- Platform-specific configurations (Darwin/Linux/Windows)
- Tool integrations (fzf, mise, etc.)
- Editor configuration
- Terminal title updates

Key configurations:

- History size: 2000 entries
- Uses emacs key bindings
- Enables command history sharing between sessions
- Configures word-style for better word navigation
- Sets up FZF integration with custom options
- Supports local overrides via ~/.zshrc.local

### 2. Path Configuration (`path.zsh`)

Manages the PATH and FPATH environment variables. Structure:

```zsh
path=(
  $HOME/.local/bin              # Environment-specific executables
  $HOME/.local/.bin            # Dotfiles-managed executables
  $HOME/.deno/bin             # Deno binaries
  $HOME/google-cloud-sdk/bin  # Google Cloud SDK
  $HOME/workspace/depot_tools # Chrome depot tools
  $path                      # Original PATH
)

fpath=(
  $HOME/.zsh/completions    # Custom completions
  $fpath                   # Original FPATH
)
```

### 3. Prompt Configuration (`prompt.zsh`)

Implements a feature-rich prompt with:

- Git status integration
- Node.js project information
- Error status indication
- SSH connection awareness
- Timestamp display

Features:

- Color-coded user and host information
- Git branch and status indicators with emoji
- Package.json version display
- Node.js/npm/yarn/pnpm version information
- Command execution timestamp
- Custom prompt rewriting on command execution

### 4. Platform-Specific Configurations

#### macOS (`darwin.zsh`)

- Homebrew integration
- Supports both Intel and Apple Silicon paths
- Auto-detection of Homebrew location

#### Windows (`windows.zsh`)

- SSH command aliases for Windows executables
- Maps `ssh` and `ssh-add` to their `.exe` counterparts

## Migration Guidelines

When porting to another implementation:

1. **Core Configuration**

   - Ensure history configuration matches your needs
   - Adapt key bindings to your preferred style
   - Review and adjust tool integrations based on availability

2. **Path Management**

   - Maintain the hierarchical path structure
   - Adjust paths based on your environment
   - Consider adding platform-specific paths in separate files

3. **Prompt System**

   - The prompt system is modular and can be ported in pieces
   - Consider implementing the git status feature first
   - Node.js integration can be added later if needed
   - Timestamp and SSH awareness are optional enhancements

4. **Platform Specifics**

   - Create new platform-specific files as needed
   - Follow the pattern of minimal, focused configurations
   - Use conditional loading based on platform detection

5. **Local Customization**
   - Maintain support for `.zshrc.local` for user overrides
   - Consider environment variables for feature toggles

Remember to test each component individually when migrating, as some features may depend on specific tools or system configurations.
