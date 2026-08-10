#!/usr/bin/env bash
# Unit test for hooks/dispatch.sh.
# Builds a fixture hooks tree, sources the dispatcher with DOTFILES_OS_OVERRIDE,
# and asserts the right scripts run in the right order.

set -eo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dotfiles_root="$(cd "$script_dir/.." && pwd)"
dispatcher="$dotfiles_root/hooks/dispatch.sh"

if [ ! -f "$dispatcher" ]; then
  echo "FAIL: $dispatcher does not exist"
  exit 1
fi

fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

mkdir -p "$fixture/hooks/pre-up" "$fixture/hooks/post-up"
mkdir -p "$fixture/hooks/shared/pre-up" "$fixture/hooks/shared/post-up"
mkdir -p "$fixture/hooks/mac/pre-up"
mkdir -p "$fixture/hooks/linux/pre-up"

cat > "$fixture/hooks/shared/pre-up/10-shared" <<'EOF'
#!/usr/bin/env bash
echo "ran:shared/pre-up/10-shared"
EOF
cat > "$fixture/hooks/mac/pre-up/20-mac" <<'EOF'
#!/usr/bin/env bash
echo "ran:mac/pre-up/20-mac"
EOF
cat > "$fixture/hooks/linux/pre-up/20-linux" <<'EOF'
#!/usr/bin/env bash
echo "ran:linux/pre-up/20-linux"
EOF
chmod +x "$fixture/hooks/shared/pre-up/10-shared" \
         "$fixture/hooks/mac/pre-up/20-mac" \
         "$fixture/hooks/linux/pre-up/20-linux"

# Copy the dispatcher into the fixture so DOTFILES_ROOT resolution works
cp "$dispatcher" "$fixture/hooks/dispatch.sh"

cat > "$fixture/hooks/pre-up/dispatch" <<'EOF'
#!/usr/bin/env bash
source "$(dirname "$(realpath "$0")")/../dispatch.sh"
EOF
chmod +x "$fixture/hooks/pre-up/dispatch"

assert_runs() {
  local override="$1"
  local expected="$2"
  local actual
  actual="$(DOTFILES_OS_OVERRIDE="$override" "$fixture/hooks/pre-up/dispatch" 2>&1 | grep '^ran:' | tr '\n' '|')"
  if [ "$actual" != "$expected" ]; then
    echo "FAIL: override=$override"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    return 1
  fi
  echo "  PASS: override=$override"
}

echo "==> dispatcher selects mac scripts when OS=mac"
assert_runs mac "ran:shared/pre-up/10-shared|ran:mac/pre-up/20-mac|" || exit 1

echo "==> dispatcher selects linux scripts when OS=linux"
assert_runs linux "ran:shared/pre-up/10-shared|ran:linux/pre-up/20-linux|" || exit 1

echo "==> dispatcher runs shared even when OS-specific dir is empty"
DOTFILES_OS_OVERRIDE=linux rm -rf "$fixture/hooks/linux/pre-up"
assert_runs linux "ran:shared/pre-up/10-shared|" || exit 1

cat > "$fixture/hooks/shared/pre-up/30-path-snapshot" <<'EOF'
#!/usr/bin/env bash
echo "PATH_SNAPSHOT:$PATH"
EOF
chmod +x "$fixture/hooks/shared/pre-up/30-path-snapshot"

path_snapshot() {
  local os_override="$1"
  local brew_dirs="$2"
  DOTFILES_OS_OVERRIDE="$os_override" DOTFILES_BREW_DIRS_OVERRIDE="$brew_dirs" \
    "$fixture/hooks/pre-up/dispatch" 2>&1 | grep '^PATH_SNAPSHOT:' | cut -d: -f2-
}

original_path="$PATH"
brewbin="$fixture/brewbin"
mkdir -p "$brewbin"
missingbin="$fixture/does-not-exist"

echo "==> dispatcher prepends existing brew dirs to PATH on mac, skips missing ones"
result="$(path_snapshot mac "$brewbin $missingbin")"
if [ "$result" != "$brewbin:$original_path" ]; then
  echo "FAIL: expected PATH $brewbin:\$PATH, got: $result"
  exit 1
fi
echo "  PASS"

echo "==> dispatcher leaves PATH untouched on linux regardless of brew dirs override"
result="$(path_snapshot linux "$brewbin")"
if [ "$result" != "$original_path" ]; then
  echo "FAIL: linux PATH should be unchanged, got: $result"
  exit 1
fi
echo "  PASS"

echo "==> dispatcher never introduces an empty PATH component when no brew dirs exist"
result="$(path_snapshot mac "$missingbin")"
if [ "$result" != "$original_path" ]; then
  echo "FAIL: PATH should be unchanged when no override dirs exist, got: $result"
  exit 1
fi
case "$result" in
  :*|*::*) echo "FAIL: PATH contains an empty component: $result"; exit 1 ;;
esac
echo "  PASS"

echo "dispatcher test: OK"
