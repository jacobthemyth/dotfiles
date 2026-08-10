#!/usr/bin/env bash
set -eo pipefail

phase="$(basename "$(dirname "$(realpath "${BASH_SOURCE[1]}")")")"

DOTFILES_ROOT="$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)"
export DOTFILES_ROOT

if [ -n "$DOTFILES_OS_OVERRIDE" ]; then
  os="$DOTFILES_OS_OVERRIDE"
else
  case "$(uname -s)" in
    Darwin) os=mac ;;
    Linux)  os=linux ;;
    *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
  esac
fi

# Hooks shell out to `env bash`, `env jq`, etc. and expect modern tool
# versions (e.g. bash >= 4). A fully sourced interactive zsh session
# already prepends Homebrew's bin dirs (see zshenv.local), but rcup can be
# invoked from contexts that never source that — cron, IDE terminals, CI —
# leaving the OS's own ancient defaults (e.g. bash 3.2) first on PATH.
# Normalize once here so every dispatched hook sees the same PATH,
# regardless of how rcup itself was invoked.
if [[ "$os" == "mac" ]]; then
  brew_paths=""
  for d in ${DOTFILES_BREW_DIRS_OVERRIDE:-/opt/homebrew/bin /opt/homebrew/sbin /usr/local/bin /usr/local/sbin}; do
    [ -d "$d" ] && brew_paths="$brew_paths:$d"
  done
  if [ -n "$brew_paths" ]; then
    PATH="${brew_paths#:}:$PATH"
    export PATH
  fi
fi

_run_dir() {
  local d="$1"
  [ -d "$d" ] || return 0
  for h in "$d"/*; do
    [ -f "$h" ] && [ -x "$h" ] || continue
    echo "▶ $phase/$(basename "$(dirname "$d")")/$(basename "$h")"
    "$h"
  done
}

_run_dir "$DOTFILES_ROOT/hooks/shared/$phase"
_run_dir "$DOTFILES_ROOT/hooks/$os/$phase"
