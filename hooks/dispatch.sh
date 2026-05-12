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
