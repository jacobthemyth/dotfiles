#!/usr/bin/env bash
# Unit test for hooks/shared/post-up/claude-plugins.
# Stubs a fake `claude` on PATH and an isolated fixture $HOME so the sync logic
# (derived from ~/.claude/settings.json) can be exercised without touching real
# Claude Code state or hitting the network.

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
mkdir -p "$fake_home/.claude/plugins" "$fake_bin"

cat > "$fake_bin/claude" <<'EOF'
#!/usr/bin/env bash
# Records calls; always succeeds.
echo "$*" >> "$FAKE_CLAUDE_CALLS"
EOF
chmod +x "$fake_bin/claude"

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

write_state() {
  # $1 = settings.json, $2 = known_marketplaces.json, $3 = installed_plugins.json
  printf '%s' "$1" > "$fake_home/.claude/settings.json"
  printf '%s' "$2" > "$fake_home/.claude/plugins/known_marketplaces.json"
  printf '%s' "$3" > "$fake_home/.claude/plugins/installed_plugins.json"
}

echo "==> in sync: enabled plugins installed, marketplaces known, no CLI calls"
write_state \
  '{"enabledPlugins": {"superpowers@claude-plugins-official": true}}' \
  '{"claude-plugins-official": {}}' \
  '{"plugins": {"superpowers@claude-plugins-official": {}}}'
if ! out="$(run_hook 2>&1)"; then
  echo "FAIL: hook exited non-zero unexpectedly:"; echo "$out"; exit 1
fi
if [ -s "$fixture/calls" ]; then
  echo "FAIL: expected no claude CLI calls (already in sync), got:"; cat "$fixture/calls"; exit 1
fi
echo "  PASS"

echo "==> install path: enabled plugin with source in extraKnownMarketplaces, not yet known/installed"
write_state \
  '{"enabledPlugins": {"codex@openai-codex": true}, "extraKnownMarketplaces": {"openai-codex": {"source": {"source": "github", "repo": "openai/codex-plugin-cc"}}}}' \
  '{}' \
  '{"plugins": {}}'
if ! out="$(run_hook 2>&1)"; then
  echo "FAIL: hook exited non-zero unexpectedly:"; echo "$out"; exit 1
fi
if ! grep -qxF "plugin marketplace add openai/codex-plugin-cc" "$fixture/calls"; then
  echo "FAIL: expected marketplace add for openai/codex-plugin-cc, got:"; cat "$fixture/calls"; exit 1
fi
if ! grep -qxF "plugin install codex@openai-codex" "$fixture/calls"; then
  echo "FAIL: expected install of codex@openai-codex, got:"; cat "$fixture/calls"; exit 1
fi
echo "  PASS"

echo "==> trust built-in: enabled plugin whose marketplace has no source and isn't known"
write_state \
  '{"enabledPlugins": {"superpowers@claude-plugins-official": true}}' \
  '{}' \
  '{"plugins": {}}'
if ! out="$(run_hook 2>&1)"; then
  echo "FAIL: hook should not error on a missing built-in marketplace source:"; echo "$out"; exit 1
fi
if grep -q "marketplace add" "$fixture/calls"; then
  echo "FAIL: should not add a sourceless (built-in) marketplace, got:"; cat "$fixture/calls"; exit 1
fi
if ! grep -qxF "plugin install superpowers@claude-plugins-official" "$fixture/calls"; then
  echo "FAIL: expected install of superpowers@claude-plugins-official, got:"; cat "$fixture/calls"; exit 1
fi
echo "  PASS"

echo "==> uninstall path: installed plugin absent from settings is removed; false-valued plugin is kept"
write_state \
  '{"enabledPlugins": {"superpowers@claude-plugins-official": true, "keep@claude-plugins-official": false}}' \
  '{"claude-plugins-official": {}}' \
  '{"plugins": {"superpowers@claude-plugins-official": {}, "keep@claude-plugins-official": {}, "stale@claude-plugins-official": {}}}'
if ! out="$(run_hook 2>&1)"; then
  echo "FAIL: hook exited non-zero unexpectedly:"; echo "$out"; exit 1
fi
if ! grep -qxF "plugin uninstall stale@claude-plugins-official" "$fixture/calls"; then
  echo "FAIL: expected uninstall of stale@claude-plugins-official, got:"; cat "$fixture/calls"; exit 1
fi
if grep -q "uninstall keep@claude-plugins-official" "$fixture/calls"; then
  echo "FAIL: false-valued plugin should be kept, not uninstalled, got:"; cat "$fixture/calls"; exit 1
fi
echo "  PASS"

echo "claude-plugins hook test: OK"
