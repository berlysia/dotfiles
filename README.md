# dotfiles

depends on [chezmoi](https://github.com/twpayne/chezmoi)

## How to use(for me)

1. [install chezmoi](https://www.chezmoi.io/install/)
   - `sh -c "$(curl -fsLS get.chezmoi.io)" -- -b $HOME/.local/bin`
1. if you are in PowerShell, `Set-ExecutionPolicy -ExecutionPolicy ByPass -Scope Process`
1. `chezmoi init --apply berlysia`

## note

- `~/.local/bin` will be added to `$PATH`
- `~/.local/.bin` will be added to `$PATH` , and overwrite this directory with symlink

## list of something will be set up

- homebrew (only mac)
- asdf
- direnv (via asdf)
- fzf
- ripgrep
- bat
- WSL2 ssh-agent (only WSL)

- my custom zsh prompt
