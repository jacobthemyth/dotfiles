#!/usr/bin/env bash
# Unit test for hooks/mac/pre-up/homebrew.
# Stubs a fake `brew` on PATH (via BREW_PATH_OVERRIDE) so the owner and
# fallback branches can be exercised without touching the real Homebrew
# install. Uses chmod to make a fixture prefix genuinely unwritable, even
# to its own owner, so the [ -w ] check behaves like a foreign-owned prefix.

set -eo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dotfiles_root="$(cd "$script_dir/.." && pwd)"
hook="$dotfiles_root/hooks/mac/pre-up/homebrew"

if [ ! -x "$hook" ]; then
  echo "FAIL: $hook does not exist or is not executable"
  exit 1
fi

fixture="$(mktemp -d)"
trap 'chmod -R u+w "$fixture" 2>/dev/null; rm -rf "$fixture"' EXIT

fake_home="$fixture/home"
calls_dir="$fixture/calls"
mkdir -p "$fake_home" "$calls_dir"

cat > "$fixture/brew" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  shellenv)
    echo "export PATH=\"$(cd "$(dirname "$0")" && pwd):\$PATH\""
    ;;
  --prefix)
    echo "$FAKE_BREW_PREFIX"
    ;;
  update)
    touch "$FAKE_BREW_CALLS_DIR/update"
    ;;
  bundle)
    if [[ "$2" == "check" ]]; then
      touch "$FAKE_BREW_CALLS_DIR/bundle_check"
      if [[ "$FAKE_BUNDLE_SATISFIED" == "1" ]]; then
        exit 0
      else
        echo "brew bundle: jq"
        exit 1
      fi
    else
      touch "$FAKE_BREW_CALLS_DIR/bundle_install"
    fi
    ;;
  cleanup)
    touch "$FAKE_BREW_CALLS_DIR/cleanup"
    ;;
  *)
    echo "fake brew: unhandled command $*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$fixture/brew"

run_hook() {
  local prefix="$1"
  local bundle_satisfied="$2"
  rm -rf "$calls_dir"
  mkdir -p "$calls_dir"
  BREW_PATH_OVERRIDE="$fixture/brew" \
    FAKE_BREW_PREFIX="$prefix" \
    FAKE_BREW_CALLS_DIR="$calls_dir" \
    FAKE_BUNDLE_SATISFIED="$bundle_satisfied" \
    HOME="$fake_home" \
    "$hook"
}

assert_called() {
  [ -f "$calls_dir/$1" ] || { echo "FAIL: expected brew $1 to be called"; return 1; }
}

assert_not_called() {
  [ ! -f "$calls_dir/$1" ] || { echo "FAIL: expected brew $1 NOT to be called"; return 1; }
}

echo "==> owner path: writable prefix runs update/bundle/cleanup"
writable_prefix="$fixture/writable_prefix"
mkdir -p "$writable_prefix"
run_hook "$writable_prefix" "1" >/dev/null
assert_called update || exit 1
assert_called bundle_install || exit 1
assert_called cleanup || exit 1
assert_not_called bundle_check || exit 1
echo "  PASS"

echo "==> fallback path: unwritable prefix + satisfied Brewfile stays quiet, never mutates"
readonly_prefix="$fixture/readonly_prefix"
mkdir -p "$readonly_prefix"
chmod 555 "$readonly_prefix"
run_hook "$readonly_prefix" "1" >/dev/null
assert_called bundle_check || exit 1
assert_not_called update || exit 1
assert_not_called bundle_install || exit 1
assert_not_called cleanup || exit 1
echo "  PASS"

echo "==> fallback path: unwritable prefix + missing packages warns and still exits 0"
out="$(run_hook "$readonly_prefix" "0" 2>&1)"
status=$?
if [ "$status" -ne 0 ]; then
  echo "FAIL: hook exited $status, expected 0"
  exit 1
fi
if ! echo "$out" | grep -q "no write access"; then
  echo "FAIL: expected a no-write-access warning, got:"
  echo "$out"
  exit 1
fi
assert_not_called update || exit 1
assert_not_called bundle_install || exit 1
assert_not_called cleanup || exit 1
echo "  PASS"

chmod u+w "$readonly_prefix"

echo "homebrew hook test: OK"
