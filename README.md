# dotfiles

depends on [chezmoi](https://github.com/twpayne/chezmoi)

## How to use(for me)

1. setup chezmoi
1. `chezmoi init git@github.com:berlysia/dotfiles.git`

## note

- `~/.local/bin` will be added to `$PATH`
- `~/.bin` will be added to `$PATH` , and overwrite this directory with symlink

## list of something will be set up

- homebrew (only mac)
- asdf
- direnv (via asdf)
- fzf
- ripgrep
- bat
- WSL2 ssh-agent (only WSL)

- my custom zsh prompt
