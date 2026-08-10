#!/usr/bin/env bash
# Unit test for hooks/shared/post-up/zsh.
# compinit/compaudit are zsh built-in functions, not external binaries, so
# they can't be stubbed on PATH the way other hooks' dependencies are.
# Instead this points compaudit at a fixture directory via
# ZSH_FPATH_OVERRIDE and exercises the real thing.

set -eo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dotfiles_root="$(cd "$script_dir/.." && pwd)"
hook="$dotfiles_root/hooks/shared/post-up/zsh"

if [ ! -x "$hook" ]; then
  echo "FAIL: $hook does not exist or is not executable"
  exit 1
fi

if ! command -v zsh >/dev/null 2>&1; then
  echo "SKIP: zsh not installed"
  exit 0
fi

fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

fpath_dir="$fixture/fpath"
mkdir -p "$fpath_dir"
touch "$fpath_dir/_mytool"

# compaudit's own source (functions/compaudit) only flags *files* for
# foreign ownership, never for permission bits — chmod could never fix
# that anyway. It flags *directories* for either foreign ownership OR
# being group/world-writable, so an owned-but-group-writable directory is
# the one case chmod g-w can actually remediate.
echo "==> owned, group-writable fpath directory gets chmod g-w'd"
chmod g+w "$fpath_dir"
before_mode="$(stat -f "%Sp" "$fpath_dir")"
if [[ "$before_mode" != *w*w* ]]; then
  echo "FAIL: fixture setup didn't actually make the directory group-writable: $before_mode"
  exit 1
fi

if ! out="$(ZSH_FPATH_OVERRIDE="$fpath_dir" bash "$hook" 2>&1)"; then
  echo "FAIL: hook exited non-zero unexpectedly:"
  echo "$out"
  exit 1
fi
if echo "$out" | grep -qi "not permitted"; then
  echo "FAIL: expected no permission errors for a directory we own, got:"
  echo "$out"
  exit 1
fi
after_mode="$(stat -f "%Sp" "$fpath_dir")"
if [[ "$after_mode" == *w*w* ]]; then
  echo "FAIL: expected group-write bit to be cleared, mode is still $after_mode"
  exit 1
fi
echo "  PASS"

echo "==> re-running is idempotent (already-secure directory, no-op, no crash)"
if ! ZSH_FPATH_OVERRIDE="$fpath_dir" bash "$hook" >/dev/null 2>&1; then
  echo "FAIL: second run should also succeed"
  exit 1
fi
echo "  PASS"

echo "zsh hook test: OK"
