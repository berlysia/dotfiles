# Bash Configuration

This directory contains bash configuration files that are compatible with the zsh configuration in the `dot_zsh` directory. The goal is to provide a similar experience for bash users while maintaining the existing zsh configuration.

## Structure

- `path.bash`: Configures the PATH environment variable
- `prompt.bash`: Sets up a customized bash prompt with git status and other indicators
- `darwin.bash`: macOS-specific configuration
- `windows.bash`: Windows-specific configuration
- `linux.bash`: Linux-specific configuration

## Features

- Git status in prompt
- JavaScript environment detection
- Platform-specific configurations
- Integration with tools like fzf, mise, and more

## Usage

These files are automatically loaded by `.bashrc` based on the current platform and environment.
