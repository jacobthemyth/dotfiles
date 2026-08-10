#!/usr/bin/env bash
# Unit test for hooks/shared/post-up/git-crypt.
# Stubs `git-crypt` and `op` on PATH so the unlock branches can be
# exercised without a real encrypted repo or 1Password session.

set -eo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dotfiles_root="$(cd "$script_dir/.." && pwd)"
hook="$dotfiles_root/hooks/shared/post-up/git-crypt"

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

fake_home="$fixture/home"
fake_bin="$fixture/bin"
state_dir="$fixture/state"
mkdir -p "$fake_home/.dotfiles" "$fake_bin" "$state_dir"

cat > "$fake_bin/git-crypt" <<'EOF'
#!/usr/bin/env bash
echo "git-crypt $*" >> "$FAKE_CALLS"
case "$1" in
  status)
    cat "$FAKE_STATE_DIR/status"
    ;;
  unlock)
    if [ -f "$FAKE_STATE_DIR/unlock_fails" ]; then
      echo "git-crypt: error: unlock failed" >&2
      exit 1
    fi
    echo "    unlocked" > "$FAKE_STATE_DIR/status"
    ;;
  *)
    echo "fake git-crypt: unhandled $*" >&2
    exit 1
    ;;
esac
EOF

cat > "$fake_bin/op" <<'EOF'
#!/usr/bin/env bash
echo "op $*" >> "$FAKE_CALLS"
case "$1" in
  read)
    if [ -f "$FAKE_STATE_DIR/op_signed_out" ]; then
      echo "op: not signed in" >&2
      exit 1
    fi
    echo "fake-git-crypt-key-material"
    ;;
  *)
    echo "fake op: unhandled $*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$fake_bin/git-crypt" "$fake_bin/op"

run_hook() {
  : > "$fixture/calls"
  # Redirect stdin from /dev/null so [ -t 0 ] is reliably false here even
  # if this test itself is run from a real interactive terminal — otherwise
  # the hook's manual-paste prompt would hang waiting for terminal input.
  PATH="$fake_bin:$PATH" HOME="$fake_home" \
    FAKE_STATE_DIR="$state_dir" FAKE_CALLS="$fixture/calls" \
    "$test_bash" "$hook" < /dev/null
}

echo "==> already unlocked: no-op, no op CLI calls"
printf '    unlocked\n' > "$state_dir/status"
if ! out="$(run_hook 2>&1)"; then
  echo "FAIL: hook exited non-zero unexpectedly:"
  echo "$out"
  exit 1
fi
if ! echo "$out" | grep -q "already unlocked"; then
  echo "FAIL: expected 'already unlocked', got: $out"
  exit 1
fi
if grep -q '^op ' "$fixture/calls" 2>/dev/null; then
  echo "FAIL: expected no op CLI calls when already unlocked"
  exit 1
fi
echo "  PASS"

echo "==> locked, op signed out, non-interactive: hard failure with fallback instructions, no unlock attempted"
printf '    encrypted: some-file\n' > "$state_dir/status"
touch "$state_dir/op_signed_out"
if run_hook >"$fixture/out" 2>&1; then
  echo "FAIL: expected non-zero exit when op fails and stdin isn't a TTY:"
  cat "$fixture/out"
  exit 1
fi
out="$(cat "$fixture/out")"
if ! echo "$out" | grep -q "Failed to retrieve git-crypt key from 1Password"; then
  echo "FAIL: expected the 1Password failure message, got: $out"
  exit 1
fi
if ! echo "$out" | grep -q "Not running interactively"; then
  echo "FAIL: expected a non-interactive notice, got: $out"
  exit 1
fi
if ! echo "$out" | grep -q "git-crypt unlock /path/to/key"; then
  echo "FAIL: expected fallback unlock instructions, got: $out"
  exit 1
fi
if grep -q '^git-crypt unlock' "$fixture/calls" 2>/dev/null; then
  echo "FAIL: git-crypt unlock should not have been attempted"
  exit 1
fi
echo "  PASS"

echo "==> locked, op available and has the secret: unlocks successfully"
rm -f "$state_dir/op_signed_out"
printf '    encrypted: some-file\n' > "$state_dir/status"
if ! out="$(run_hook 2>&1)"; then
  echo "FAIL: hook exited non-zero unexpectedly:"
  echo "$out"
  exit 1
fi
if ! echo "$out" | grep -q "git-crypt unlocked successfully"; then
  echo "FAIL: expected success message, got: $out"
  exit 1
fi
echo "  PASS"

echo "==> locked, op succeeds but git-crypt unlock itself fails: still a hard failure"
printf '    encrypted: some-file\n' > "$state_dir/status"
touch "$state_dir/unlock_fails"
if run_hook >/dev/null 2>&1; then
  echo "FAIL: expected non-zero exit when git-crypt unlock itself fails"
  exit 1
fi
echo "  PASS"

echo "git-crypt hook test: OK"
