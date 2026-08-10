#!/usr/bin/env bash
# Unit test for hooks/shared/post-up/vim.
# Stubs `uv` and `nvim` on PATH so the venv-creation flow can be exercised
# without actually creating a venv or installing real packages.

set -eo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dotfiles_root="$(cd "$script_dir/.." && pwd)"
hook="$dotfiles_root/hooks/shared/post-up/vim"

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
mkdir -p "$fake_home" "$fake_bin"

venv_dir="$fake_home/.local/share/nvim/venv"

cat > "$fake_bin/uv" <<'EOF'
#!/usr/bin/env bash
echo "uv $*" >> "$FAKE_CALLS"
case "$1" in
  venv)
    # Simulate `uv venv --allow-existing <path>` idempotently.
    shift
    path=""
    for arg in "$@"; do
      case "$arg" in
        --*) ;;
        *) path="$arg" ;;
      esac
    done
    mkdir -p "$path/bin"
    : > "$path/bin/python3"
    chmod +x "$path/bin/python3"
    ;;
  pip)
    ;;
  *)
    echo "fake uv: unhandled $*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$fake_bin/uv"

cat > "$fake_bin/nvim" <<'EOF'
#!/usr/bin/env bash
echo "nvim $*" >> "$FAKE_CALLS"
EOF
chmod +x "$fake_bin/nvim"

run_hook() {
  : > "$fixture/calls"
  # Full replacement, not a prepend — a stub dir that's merely prepended
  # ahead of the real $PATH doesn't make a tool "absent," it just fails to
  # shadow the real one further down.
  PATH="$1" HOME="$fake_home" FAKE_CALLS="$fixture/calls" "$test_bash" "$hook"
}

echo "==> uv not found: clear error, exit 1"
if run_hook "/usr/bin:/bin" >"$fixture/out" 2>&1; then
  echo "FAIL: expected non-zero exit when uv is missing"
  cat "$fixture/out"
  exit 1
fi
if ! grep -q "uv not found" "$fixture/out"; then
  echo "FAIL: expected a clear 'uv not found' message, got:"
  cat "$fixture/out"
  exit 1
fi
echo "  PASS"

echo "==> uv and nvim present: creates venv, installs into it, updates remote plugins"
if ! out="$(run_hook "$fake_bin:/usr/bin:/bin" 2>&1)"; then
  echo "FAIL: hook exited non-zero unexpectedly:"
  echo "$out"
  exit 1
fi
if [ ! -x "$venv_dir/bin/python3" ]; then
  echo "FAIL: expected a venv to be created at $venv_dir"
  exit 1
fi
if ! grep -q "^uv venv --allow-existing $venv_dir\$" "$fixture/calls"; then
  echo "FAIL: expected 'uv venv --allow-existing $venv_dir', got:"
  cat "$fixture/calls"
  exit 1
fi
if ! grep -q "^uv pip install --python $venv_dir/bin/python3 --upgrade neovim neovim-remote\$" "$fixture/calls"; then
  echo "FAIL: expected uv pip install targeting the venv's python3, got:"
  cat "$fixture/calls"
  exit 1
fi
if ! grep -q "^nvim --headless -c UpdateRemotePlugins -c qa\$" "$fixture/calls"; then
  echo "FAIL: expected nvim --headless to run UpdateRemotePlugins, got:"
  cat "$fixture/calls"
  exit 1
fi
echo "  PASS"

echo "==> re-running is idempotent (--allow-existing doesn't error on an existing venv)"
if ! run_hook "$fake_bin:/usr/bin:/bin" >/dev/null 2>&1; then
  echo "FAIL: second run should also succeed"
  exit 1
fi
echo "  PASS"

echo "vim hook test: OK"
