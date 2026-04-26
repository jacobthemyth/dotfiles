# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Personal dotfiles managed with [rcm](https://github.com/thoughtbot/rcm) (RC file management). Files in this repo are symlinked to `$HOME` by rcm, with dotfile prefixes added automatically (e.g., `zshrc` becomes `~/.zshrc`).

## Key Commands

- **Install/update dotfiles**: `./script/setup` — installs rcm if needed, then runs `rcup`
- **After editing dotfiles**: `RCRC=~/.dotfiles/rcrc rcup` to re-symlink

## How rcm Works Here

- `rcrc` defines the rcm configuration: dotfiles dir, OS tags, and excluded paths
- `tag-mac/` contains macOS-specific files (applied when `TAGS=mac`)
- `config/` maps to `~/.config/` (XDG config home)
- `hooks/pre-up/` and `hooks/post-up/` run during `rcup` — these handle Homebrew, Ruby, Node, Vim plugins, git-crypt, fonts, and macOS preferences
- Files listed in `EXCLUDES` in rcrc (`script/*`, `README.md`, `LICENSE`) are not symlinked

## Structure

- Top-level files (e.g., `zshrc`, `vimrc`, `tmux.conf`, `aliases`) symlink directly to `~/.<name>`
- `config/*` symlinks to `~/.config/*` (Doom Emacs, Neovim, Ghostty, git, starship, etc.)
- `tag-mac/` — macOS-only: Brewfile, yabai config, skhd config
- `tag-encrypted/` — git-crypt encrypted files
- `zsh/configs/*.zsh` — sourced by zshrc; `zsh/functions/` — custom shell functions added to FPATH
- `local/bin/` — user scripts (symlinked to `~/.local/bin/`)

## Shell Environment

- zsh with vi keybindings (`bindkey -v`) plus emacs-style shortcuts in viins mode
- Starship prompt
- Version managers: rbenv, nodenv, pyenv (all with `--no-rehash`)
- direnv for per-directory env
- Default editor: nvim (`vim` is aliased to `nvim`)
- fzf with ripgrep backend (`rg --files`)
