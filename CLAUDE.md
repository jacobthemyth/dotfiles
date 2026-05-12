# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Personal dotfiles managed with [rcm](https://github.com/thoughtbot/rcm) (RC file management). Files in this repo are symlinked to `$HOME` by rcm, with dotfile prefixes added automatically (e.g., `zshrc` becomes `~/.zshrc`).

## Key Commands

- **Install/update dotfiles**: `./script/setup` — installs rcm if needed, then runs `rcup`
- **After editing dotfiles**: `RCRC=~/.dotfiles/rcrc rcup` to re-symlink
- **Run tests/lint**: `./script/test` — bash -n, shellcheck (if installed), guard assertion, dispatcher unit test. Non-destructive.

## How rcm Works Here

- `rcrc` defines the rcm configuration: dotfiles dir, OS tags, and excluded paths
- `tag-mac/` contains macOS-specific files (applied when `TAGS=mac`)
- `config/` maps to `~/.config/` (XDG config home)
- `hooks/pre-up/dispatch` and `hooks/post-up/dispatch` are the only rcm-visible hooks. They source `hooks/dispatch.sh`, which detects the OS (`mac` or `linux`) and runs scripts from `hooks/shared/<phase>/*` then `hooks/<os>/<phase>/*`. Individual hook scripts are OS-pure — no inline guards. Override OS detection in tests with `DOTFILES_OS_OVERRIDE={mac,linux}`. Arch package state is declared in `tag-linux/config/aconfmgr/` and applied by `hooks/linux/pre-up/aconfmgr-apply`.
- Files listed in `EXCLUDES` in rcrc (`script/*`, `README.md`, `LICENSE`) are not symlinked

## Structure

- Top-level files (e.g., `zshrc`, `vimrc`, `tmux.conf`, `aliases`) symlink directly to `~/.<name>`
- `config/*` symlinks to `~/.config/*` (Doom Emacs, Neovim, Ghostty, git, starship, etc.)
- `tag-mac/` — macOS-only: Brewfile, yabai config, skhd config
- `tag-linux/` — Linux-only (Arch). `config/aconfmgr/` declares pacman+AUR state; `config/hypr/` (and siblings) hold Hyprland-stack configs symlinked to `~/.config/`. See `docs/superpowers/specs/2026-05-12-arch-aconfmgr-seeding.md` for how to seed the package manifest.
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
