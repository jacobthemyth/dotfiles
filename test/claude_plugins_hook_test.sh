#!/usr/bin/env bash
# Unit test for hooks/shared/post-up/claude-plugins.
# Stubs a fake `claude` on PATH and an isolated fixture $HOME so the drift
# check (enabledPlugins vs the manifest) can be exercised without touching
# real Claude Code state or hitting the network.

set -eo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dotfiles_root="$(cd "$script_dir/.." && pwd)"
hook="$dotfiles_root/hooks/shared/post-up/claude-plugins"

if [ ! -x "$hook" ]; then
  echo "FAIL: $hook does not exist or is not executable"
  exit 1
fi

fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

fake_home="$fixture/home"
fake_bin="$fixture/bin"
mkdir -p "$fake_home/.dotfiles" "$fake_home/.claude/plugins" "$fake_bin"

cat > "$fake_bin/claude" <<'EOF'
#!/usr/bin/env bash
# Records calls; always succeeds.
echo "$*" >> "$FAKE_CLAUDE_CALLS"
EOF
chmod +x "$fake_bin/claude"

cat > "$fake_home/.dotfiles/claude-plugins" <<'EOF'
superpowers@claude-plugins-official anthropics/claude-plugins-official
EOF

cat > "$fake_home/.claude/plugins/known_marketplaces.json" <<'EOF'
{"claude-plugins-official": {}}
EOF
cat > "$fake_home/.claude/plugins/installed_plugins.json" <<'EOF'
{"plugins": {"superpowers@claude-plugins-official": {}}}
EOF

# bash "$hook" would resolve `bash` via this shell's own ambient PATH,
# which may put macOS's bash 3.2 first (the exact issue this hook's own
# version guard exists to catch) — resolve a modern bash explicitly so the
# test isn't at the mercy of the same PATH ordering being tested elsewhere.
resolve_bash() {
  for candidate in /opt/homebrew/bin/bash /usr/local/bin/bash bash; do
    command -v "$candidate" >/dev/null 2>&1 && { echo "$candidate"; return; }
  done
}
test_bash="$(resolve_bash)"

run_hook() {
  : > "$fixture/calls"
  PATH="$fake_bin:$PATH" HOME="$fake_home" FAKE_CLAUDE_CALLS="$fixture/calls" "$test_bash" "$hook"
}

echo "==> no drift: manifest and enabledPlugins agree, no warning, no CLI calls"
cat > "$fake_home/.claude/settings.json" <<'EOF'
{"enabledPlugins": {"superpowers@claude-plugins-official": true}}
EOF
if ! out="$(run_hook 2>&1)"; then
  echo "FAIL: hook exited non-zero unexpectedly:"
  echo "$out"
  exit 1
fi
if echo "$out" | grep -q "WARNING"; then
  echo "FAIL: unexpected drift warning:"
  echo "$out"
  exit 1
fi
if [ -s "$fixture/calls" ]; then
  echo "FAIL: expected no claude CLI calls (already in sync), got:"
  cat "$fixture/calls"
  exit 1
fi
echo "  PASS"

echo "==> drift: enabledPlugins has a plugin missing from the manifest warns, still no CLI calls"
cat > "$fake_home/.claude/settings.json" <<'EOF'
{"enabledPlugins": {"superpowers@claude-plugins-official": true, "extra@somewhere": true}}
EOF
if ! out="$(run_hook 2>&1)"; then
  echo "FAIL: hook exited non-zero unexpectedly:"
  echo "$out"
  exit 1
fi
if ! echo "$out" | grep -q "WARNING.*extra@somewhere.*missing from"; then
  echo "FAIL: expected a drift warning for extra@somewhere, got:"
  echo "$out"
  exit 1
fi
if [ -s "$fixture/calls" ]; then
  echo "FAIL: drift check should only warn, not act, got CLI calls:"
  cat "$fixture/calls"
  exit 1
fi
echo "  PASS"

echo "claude-plugins hook test: OK"
