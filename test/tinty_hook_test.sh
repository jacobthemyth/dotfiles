#!/usr/bin/env bash
# Unit test for hooks/shared/post-up/tinty.
# Stubs `tinty` on PATH so the install/apply branches can be exercised
# without touching the real tinty data dir.

set -eo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dotfiles_root="$(cd "$script_dir/.." && pwd)"
hook="$dotfiles_root/hooks/shared/post-up/tinty"

if [ ! -x "$hook" ]; then
  echo "FAIL: $hook does not exist or is not executable"
  exit 1
fi

resolve_bash() {
  for candidate in /opt/homebrew/bin/bash /usr/local/bin/bash bash; do
    command -v "$candidate" >/dev/null 2>&1 && { echo "$candidate"; return; }
  done
}
test_bash="$(resolve_bash)"

fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

fake_bin="$fixture/bin"
state_dir="$fixture/state"
mkdir -p "$fake_bin" "$state_dir"

cat > "$fake_bin/tinty" <<'EOF'
#!/usr/bin/env bash
echo "tinty $*" >> "$FAKE_CALLS"
case "$1" in
  list)
    [ -f "$FAKE_STATE_DIR/schemes_missing" ] && exit 1
    exit 0
    ;;
  install)
    rm -f "$FAKE_STATE_DIR/schemes_missing"
    exit 0
    ;;
  current)
    [ -f "$FAKE_STATE_DIR/no_scheme_applied" ] && exit 1
    exit 0
    ;;
  apply)
    rm -f "$FAKE_STATE_DIR/no_scheme_applied"
    exit 0
    ;;
  *)
    echo "fake tinty: unhandled $*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$fake_bin/tinty"

run_hook() {
  : > "$fixture/calls"
  # Full replacement, not a prepend — a stub dir that's merely prepended
  # ahead of the real $PATH doesn't make a tool "absent," it just fails to
  # shadow the real one further down.
  PATH="$1" FAKE_STATE_DIR="$state_dir" FAKE_CALLS="$fixture/calls" \
    "$test_bash" "$hook"
}

echo "==> tinty not installed: hard failure, no calls"
if run_hook "/usr/bin:/bin" >"$fixture/out" 2>&1; then
  echo "FAIL: expected non-zero exit when tinty is missing"
  cat "$fixture/out"
  exit 1
fi
if ! grep -q "tinty not found" "$fixture/out"; then
  echo "FAIL: expected install instructions, got: $(cat "$fixture/out")"
  exit 1
fi
echo "  PASS"

echo "==> templates already installed, scheme already applied: no install/apply calls"
if ! out="$(run_hook "$fake_bin:$PATH" 2>&1)"; then
  echo "FAIL: hook exited non-zero unexpectedly:"
  echo "$out"
  exit 1
fi
if grep -qE '^tinty (install|apply)' "$fixture/calls"; then
  echo "FAIL: expected no install/apply calls, got:"
  cat "$fixture/calls"
  exit 1
fi
echo "  PASS"

echo "==> templates missing: runs install"
touch "$state_dir/schemes_missing"
if ! out="$(run_hook "$fake_bin:$PATH" 2>&1)"; then
  echo "FAIL: hook exited non-zero unexpectedly:"
  echo "$out"
  exit 1
fi
if ! grep -q '^tinty install' "$fixture/calls"; then
  echo "FAIL: expected a tinty install call, got:"
  cat "$fixture/calls"
  exit 1
fi
rm -f "$state_dir/schemes_missing"
echo "  PASS"

echo "==> no scheme applied yet: applies the default scheme"
touch "$state_dir/no_scheme_applied"
if ! out="$(run_hook "$fake_bin:$PATH" 2>&1)"; then
  echo "FAIL: hook exited non-zero unexpectedly:"
  echo "$out"
  exit 1
fi
if ! grep -q '^tinty apply base16-tomorrow-night-eighties' "$fixture/calls"; then
  echo "FAIL: expected a tinty apply call with the default scheme, got:"
  cat "$fixture/calls"
  exit 1
fi
rm -f "$state_dir/no_scheme_applied"
echo "  PASS"

echo "tinty hook test: OK"
