# Arch Declarative Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the rcm-based dotfiles repo to support Arch Linux declaratively, while keeping mac working and replacing scattered `[[ darwin ]] || exit` guards with a single OS dispatcher.

**Architecture:** Three lanes: rcm for `~/` symlinks (unchanged); aconfmgr for declarative Arch package state; a thin hooks dispatcher that sources `hooks/dispatch.sh` and runs OS-scoped scripts from `hooks/{shared,mac,linux}/<phase>/`. The dispatcher exports `$DOTFILES_ROOT` so every hook is OS-pure (no inline guards).

**Tech Stack:** Bash, rcm 1.3.6, aconfmgr-git (AUR), Hyprland (Wayland) config files, systemd user units. Test runner is plain bash + optional shellcheck.

**Spec:** `docs/superpowers/specs/2026-05-12-arch-declarative-config-design.md`

---

## File map

**Create:**
- `script/test` — bash test runner (shellcheck + bash -n + assertions)
- `test/dispatch_test.sh` — fixture-based dispatcher unit test
- `hooks/dispatch.sh` — dispatcher logic, sourced by shims
- `hooks/pre-up/dispatch` — pre-up shim (rcm-visible)
- `hooks/post-up/dispatch` — post-up shim (rcm-visible)
- `hooks/shared/pre-up/submodules` — moved from `hooks/pre-up/submodules`
- `hooks/shared/post-up/claude-plugins` — moved
- `hooks/shared/post-up/git-crypt` — moved + install-hint generalized
- `hooks/shared/post-up/node` — moved
- `hooks/shared/post-up/pipx` — moved
- `hooks/shared/post-up/ruby` — moved
- `hooks/shared/post-up/vim` — moved
- `hooks/shared/post-up/zsh` — moved
- `hooks/mac/pre-up/homebrew` — moved from `00-mac-homebrew`, guard dropped
- `hooks/mac/pre-up/filelimit` — moved from `mac-filelimit`, guard dropped
- `hooks/mac/post-up/fonts` — moved from `mac-fonts`, guard dropped
- `hooks/mac/post-up/preferences` — moved from `mac-preferences`, guard dropped
- `hooks/linux/pre-up/aconfmgr-bootstrap` — new
- `hooks/linux/pre-up/aconfmgr-apply` — new
- `hooks/linux/post-up/fonts` — new (`fc-cache -f`)
- `hooks/linux/post-up/user-services` — new
- `hooks/linux/user-services.list` — empty, header comment only
- `tag-linux/config/aconfmgr/00-packages.sh` — stub
- `tag-linux/config/aconfmgr/10-files.sh` — empty stub
- `tag-linux/config/hypr/.gitkeep` — placeholder for Hyprland configs
- `docs/superpowers/specs/2026-05-12-arch-aconfmgr-seeding.md` — seeding procedure (one-off, not in code)

**Delete (after moves are committed):**
- `hooks/pre-up/00-mac-homebrew`, `hooks/pre-up/mac-filelimit`, `hooks/pre-up/submodules`
- `hooks/post-up/{claude-plugins,git-crypt,mac-fonts,mac-preferences,node,pipx,ruby,vim,zsh}`

**Modify:**
- `CLAUDE.md` — replace the hook-section description with the new layout
- `script/setup` — no logic change; verify still works (existing `case "$OSTYPE"` block is fine)

---

## Conventions used in this plan

- **Commits** include the existing `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` footer, matching the repo's recent pattern. The implementer's local `user.email`/`user.name` may not be set globally — use `-c user.email=jacob@jacobsmith.io -c user.name="Jacob Smith"` per command, matching the repo's existing commit author.
- **Hook scripts** start with `#!/usr/bin/env bash` and `set -eo pipefail`, and are made executable with `chmod +x`.
- **Test runs** are non-destructive: `script/test` does not invoke `rcup` and does not install packages. Running `./script/setup` on the live machine is the user's manual step, after seeding.

---

## Task 1: Add the test runner skeleton

**Files:**
- Create: `script/test`

- [ ] **Step 1: Create `script/test` with shellcheck + bash -n sweep**

```bash
#!/usr/bin/env bash
# Run lint + unit tests for the dotfiles repo.
# Non-destructive: does not symlink, install, or modify the system.

set -eo pipefail

dotfiles_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
cd "$dotfiles_root"

fail=0

echo "==> bash -n syntax check on all hook scripts"
while IFS= read -r -d '' f; do
  bash -n "$f" || { echo "  FAIL: $f"; fail=1; }
done < <(find hooks -type f \( -perm -u+x -o -name "*.sh" \) -print0 2>/dev/null)

if command -v shellcheck >/dev/null 2>&1; then
  echo "==> shellcheck on all hook scripts"
  while IFS= read -r -d '' f; do
    shellcheck -x "$f" || fail=1
  done < <(find hooks -type f \( -perm -u+x -o -name "*.sh" \) -print0 2>/dev/null)
else
  echo "==> shellcheck not installed, skipping"
fi

echo "==> no leftover OS guards in hooks (will fail until dispatcher refactor lands)"
if grep -RnE 'OSTYPE.*darwin|uname.*[Dd]arwin' hooks/ 2>/dev/null | grep -vE '^hooks/dispatch\.sh:|^hooks/(pre|post)-up/dispatch:'; then
  echo "  FAIL: inline OS guards found above"
  fail=1
fi

echo "==> dispatcher unit test"
if [ -x test/dispatch_test.sh ]; then
  test/dispatch_test.sh || fail=1
else
  echo "  SKIP: test/dispatch_test.sh not present yet"
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "FAIL"
  exit 1
fi
echo
echo "OK"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x script/test`

- [ ] **Step 3: Run it to establish a baseline**

Run: `./script/test`
Expected: `bash -n` passes (existing scripts are valid bash); `shellcheck` may flag pre-existing issues — note them but do not fix in this task; the "no leftover OS guards" check FAILS (this is the assertion we'll satisfy by the dispatcher migration); dispatcher unit test is SKIP.

- [ ] **Step 4: Commit**

```bash
git add script/test
git -c user.email=jacob@jacobsmith.io -c user.name="Jacob Smith" -c commit.gpgsign=false commit -m "$(cat <<'EOF'
Add script/test for hook lint + assertions

Non-destructive test runner: bash -n, shellcheck (optional), and a
guard assertion that fails until the dispatcher refactor removes the
inline darwin checks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Write the dispatcher unit test (failing)

**Files:**
- Create: `test/dispatch_test.sh`

- [ ] **Step 1: Create the test file**

```bash
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

echo "dispatcher test: OK"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x test/dispatch_test.sh`

- [ ] **Step 3: Run the test to see it fail meaningfully**

Run: `./test/dispatch_test.sh`
Expected: FAIL with `FAIL: /home/jacob/.dotfiles/hooks/dispatch.sh does not exist` (the dispatcher hasn't been written yet).

- [ ] **Step 4: Run `./script/test`**

Expected: dispatcher unit test runs and FAILs as above; other checks unchanged from Task 1.

- [ ] **Step 5: Commit**

```bash
git add test/dispatch_test.sh
git -c user.email=jacob@jacobsmith.io -c user.name="Jacob Smith" -c commit.gpgsign=false commit -m "$(cat <<'EOF'
Add failing dispatcher unit test

Fixture-based test for hooks/dispatch.sh, asserting OS selection
(mac vs linux) and graceful handling of missing OS-specific dirs.
Fails until dispatch.sh exists.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Implement `hooks/dispatch.sh` and the rcm-visible shims

**Files:**
- Create: `hooks/dispatch.sh`
- Create: `hooks/pre-up/dispatch`, `hooks/post-up/dispatch`

- [ ] **Step 1: Write `hooks/dispatch.sh`**

```bash
# hooks/dispatch.sh — sourced by hooks/{pre,post}-up/dispatch.
# Dispatches to OS-scoped hook scripts under hooks/{shared,mac,linux}/<phase>/.
# Exports DOTFILES_ROOT for use by downstream hooks.
# Test override: DOTFILES_OS_OVERRIDE={mac,linux} bypasses uname detection.

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
```

- [ ] **Step 2: Write the pre-up shim**

`hooks/pre-up/dispatch`:

```bash
#!/usr/bin/env bash
source "$(dirname "$(realpath "$0")")/../dispatch.sh"
```

- [ ] **Step 3: Write the post-up shim**

`hooks/post-up/dispatch` (identical content):

```bash
#!/usr/bin/env bash
source "$(dirname "$(realpath "$0")")/../dispatch.sh"
```

- [ ] **Step 4: Make shims executable**

Run: `chmod +x hooks/pre-up/dispatch hooks/post-up/dispatch`

- [ ] **Step 5: Run the dispatcher unit test**

Run: `./test/dispatch_test.sh`
Expected: all three assertions PASS, final line `dispatcher test: OK`.

- [ ] **Step 6: Run `./script/test`**

Run: `./script/test`
Expected: dispatcher test PASSES; "no leftover OS guards" still FAILS (old hooks still in place); bash -n / shellcheck unchanged.

- [ ] **Step 7: Commit**

```bash
git add hooks/dispatch.sh hooks/pre-up/dispatch hooks/post-up/dispatch
git -c user.email=jacob@jacobsmith.io -c user.name="Jacob Smith" -c commit.gpgsign=false commit -m "$(cat <<'EOF'
Add hooks dispatcher

Single dispatch.sh sourced by hooks/{pre,post}-up/dispatch. Selects
mac/linux scripts under hooks/<os>/<phase>/ and runs shared/<phase>/
unconditionally. Exports DOTFILES_ROOT. Honors DOTFILES_OS_OVERRIDE
for test injection.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Move shared hooks (no behavior change)

These hooks have no darwin guards today — they just move into `hooks/shared/`.

**Files:**
- Move: `hooks/pre-up/submodules` → `hooks/shared/pre-up/submodules`
- Move: `hooks/post-up/{claude-plugins,node,pipx,ruby,vim,zsh}` → `hooks/shared/post-up/<same>`

> Note: `git-crypt` is moved in Task 5 because it also gets a content edit.

- [ ] **Step 1: Create target directories**

```bash
mkdir -p hooks/shared/pre-up hooks/shared/post-up
```

- [ ] **Step 2: Move with git so history is preserved**

```bash
git mv hooks/pre-up/submodules hooks/shared/pre-up/submodules
git mv hooks/post-up/claude-plugins hooks/shared/post-up/claude-plugins
git mv hooks/post-up/node hooks/shared/post-up/node
git mv hooks/post-up/pipx hooks/shared/post-up/pipx
git mv hooks/post-up/ruby hooks/shared/post-up/ruby
git mv hooks/post-up/vim hooks/shared/post-up/vim
git mv hooks/post-up/zsh hooks/shared/post-up/zsh
```

- [ ] **Step 3: Verify executability survived the move**

Run: `ls -l hooks/shared/pre-up/ hooks/shared/post-up/`
Expected: every file has `x` permission for owner.

- [ ] **Step 4: Run `./script/test`**

Run: `./script/test`
Expected: dispatcher test PASS; bash -n PASS; "no leftover OS guards" still FAILs (mac hooks not yet moved).

- [ ] **Step 5: Commit**

```bash
git -c user.email=jacob@jacobsmith.io -c user.name="Jacob Smith" -c commit.gpgsign=false commit -m "$(cat <<'EOF'
Move shared hooks under hooks/shared/

No behavior change. Hooks that were already cross-platform move out of
hooks/pre-up/ and hooks/post-up/ to clear the way for the dispatcher
to be the only file rcm sees.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Move and generalize the `git-crypt` hook

The existing hook prints `brew install git-crypt` and `brew install 1password-cli` in error paths. Generalize the hint for non-mac systems.

**Files:**
- Move + modify: `hooks/post-up/git-crypt` → `hooks/shared/post-up/git-crypt`

- [ ] **Step 1: git mv first to preserve history**

```bash
git mv hooks/post-up/git-crypt hooks/shared/post-up/git-crypt
```

- [ ] **Step 2: Edit the install-hint lines**

Open `hooks/shared/post-up/git-crypt` and replace the two `brew install ...` error messages with a portable hint.

Old line:
```bash
  echo "git-crypt not found. Install it with: brew install git-crypt"
```
New line:
```bash
  echo "git-crypt not found. Install via your OS package manager (brew install git-crypt on macOS, pacman -S git-crypt on Arch)."
```

Old line:
```bash
    echo "1Password CLI not found. Install it with: brew install 1password-cli"
```
New line:
```bash
    echo "1Password CLI not found. Install via your OS package manager (brew install 1password-cli on macOS, paru -S 1password-cli on Arch)."
```

- [ ] **Step 3: Sanity-check the edit**

Run: `grep -n 'brew install' hooks/shared/post-up/git-crypt`
Expected: lines appear only inside the new combined hint strings, not as standalone instructions.

Run: `bash -n hooks/shared/post-up/git-crypt`
Expected: exits 0 (valid syntax).

- [ ] **Step 4: Run `./script/test`**

Run: `./script/test`
Expected: same as Task 4 — guards assertion still fails until mac hooks move.

- [ ] **Step 5: Commit**

```bash
git add hooks/shared/post-up/git-crypt
git -c user.email=jacob@jacobsmith.io -c user.name="Jacob Smith" -c commit.gpgsign=false commit -m "$(cat <<'EOF'
Move git-crypt hook into hooks/shared/, generalize install hints

The two "brew install …" error messages now mention both mac and Arch
package names, so the hook reads correctly on Linux.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Move mac pre-up hooks and drop darwin guards

**Files:**
- Move + modify: `hooks/pre-up/00-mac-homebrew` → `hooks/mac/pre-up/homebrew`
- Move + modify: `hooks/pre-up/mac-filelimit` → `hooks/mac/pre-up/filelimit`

- [ ] **Step 1: Create target directory and move**

```bash
mkdir -p hooks/mac/pre-up
git mv hooks/pre-up/00-mac-homebrew hooks/mac/pre-up/homebrew
git mv hooks/pre-up/mac-filelimit   hooks/mac/pre-up/filelimit
```

- [ ] **Step 2: Drop the darwin guard in `hooks/mac/pre-up/homebrew`**

Remove these two lines (keep the surrounding code unchanged):

```bash
# TODO: replace with tag hooks
[[ "$OSTYPE" == "darwin"* ]] || exit
```

- [ ] **Step 3: Drop the darwin guard in `hooks/mac/pre-up/filelimit`**

Same edit — remove:

```bash
# TODO: replace with tag hooks
[[ "$OSTYPE" == "darwin"* ]] || exit
```

- [ ] **Step 4: Syntax-check**

Run: `bash -n hooks/mac/pre-up/homebrew hooks/mac/pre-up/filelimit`
Expected: both exit 0.

- [ ] **Step 5: Run `./script/test`**

Run: `./script/test`
Expected: progressing — fewer darwin guards remain; mac post-up hooks still flagged.

- [ ] **Step 6: Commit**

```bash
git add hooks/mac/pre-up/homebrew hooks/mac/pre-up/filelimit
git -c user.email=jacob@jacobsmith.io -c user.name="Jacob Smith" -c commit.gpgsign=false commit -m "$(cat <<'EOF'
Move mac pre-up hooks under hooks/mac/, drop inline OS guards

The dispatcher gates OS selection now, so the [[ darwin ]] || exit
guards are no longer needed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Move mac post-up hooks and drop darwin guards

**Files:**
- Move + modify: `hooks/post-up/mac-fonts` → `hooks/mac/post-up/fonts`
- Move + modify: `hooks/post-up/mac-preferences` → `hooks/mac/post-up/preferences`

- [ ] **Step 1: Create target directory and move**

```bash
mkdir -p hooks/mac/post-up
git mv hooks/post-up/mac-fonts       hooks/mac/post-up/fonts
git mv hooks/post-up/mac-preferences hooks/mac/post-up/preferences
```

- [ ] **Step 2: Drop the darwin guard in `hooks/mac/post-up/fonts`**

Remove:

```bash
[[ "$OSTYPE" == "darwin"* ]] || exit
```

- [ ] **Step 3: Drop the darwin guard in `hooks/mac/post-up/preferences`**

Remove:

```bash
# TODO: replace with tag hooks
[[ "$OSTYPE" == "darwin"* ]] || exit
```

- [ ] **Step 4: Syntax-check**

Run: `bash -n hooks/mac/post-up/fonts hooks/mac/post-up/preferences`
Expected: both exit 0.

- [ ] **Step 5: Run `./script/test`**

Run: `./script/test`
Expected: **all checks PASS**, including "no leftover OS guards". This is the moment the refactor goal is reached.

- [ ] **Step 6: Commit**

```bash
git add hooks/mac/post-up/fonts hooks/mac/post-up/preferences
git -c user.email=jacob@jacobsmith.io -c user.name="Jacob Smith" -c commit.gpgsign=false commit -m "$(cat <<'EOF'
Move mac post-up hooks under hooks/mac/, drop inline OS guards

Completes the darwin-guard removal: hooks/ has no inline OS checks
remaining; dispatcher is the sole arbiter.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Create aconfmgr config skeleton

**Files:**
- Create: `tag-linux/config/aconfmgr/00-packages.sh`
- Create: `tag-linux/config/aconfmgr/10-files.sh`
- Create: `tag-linux/config/hypr/.gitkeep`

- [ ] **Step 1: Make directories**

```bash
mkdir -p tag-linux/config/aconfmgr tag-linux/config/hypr
```

- [ ] **Step 2: Write `tag-linux/config/aconfmgr/00-packages.sh`**

```bash
# aconfmgr package manifest for Arch Linux.
#
# Populate via the seeding procedure in
# docs/superpowers/specs/2026-05-12-arch-aconfmgr-seeding.md.
#
# Until this file declares packages, hooks/linux/pre-up/aconfmgr-apply
# is a no-op (it only runs when the file is non-empty after stripping
# comments).
#
# Examples:
#   AddPackage base-devel
#   AddPackage git
#   AddPackage paru                # AUR helper, optional but useful
#   AddPackage aconfmgr-git        # this tool itself
#   AddPackageGroup base
```

- [ ] **Step 3: Write `tag-linux/config/aconfmgr/10-files.sh`**

```bash
# aconfmgr file manifest. Empty in v1 — /etc declarative state is out
# of scope per the design doc. Stub kept so aconfmgr -c <dir> picks it
# up without warning.
```

- [ ] **Step 4: Drop a `.gitkeep` so the Hyprland config dir is tracked**

`tag-linux/config/hypr/.gitkeep` — empty file.

```bash
touch tag-linux/config/hypr/.gitkeep
```

- [ ] **Step 5: Run `./script/test`**

Run: `./script/test`
Expected: all checks still PASS.

- [ ] **Step 6: Commit**

```bash
git add tag-linux/config/aconfmgr tag-linux/config/hypr/.gitkeep
git -c user.email=jacob@jacobsmith.io -c user.name="Jacob Smith" -c commit.gpgsign=false commit -m "$(cat <<'EOF'
Scaffold tag-linux/config: aconfmgr stubs + hypr placeholder

00-packages.sh is empty (comments only) so apply hook no-ops until the
manifest is seeded. 10-files.sh stub for aconfmgr's expected layout.
hypr/.gitkeep marks the home of forthcoming Hyprland configs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Implement `hooks/linux/pre-up/aconfmgr-bootstrap`

Idempotent: installs `base-devel`, `git`, and `aconfmgr-git` from AUR if missing.

**Files:**
- Create: `hooks/linux/pre-up/aconfmgr-bootstrap`

- [ ] **Step 1: Write the hook**

```bash
#!/usr/bin/env bash
#
# Ensure base-devel, git, and aconfmgr-git are installed.
# Idempotent: skips work if packages already present.
# Builds aconfmgr-git from AUR via makepkg (no AUR helper required).

set -eo pipefail

if ! pacman -Q base-devel >/dev/null 2>&1 || ! pacman -Q git >/dev/null 2>&1; then
  echo "Installing base-devel and git (sudo required)..."
  sudo pacman -S --needed --noconfirm base-devel git
fi

if pacman -Q aconfmgr-git >/dev/null 2>&1 || pacman -Q aconfmgr >/dev/null 2>&1; then
  exit 0
fi

echo "Building aconfmgr-git from AUR..."
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
git clone --depth=1 https://aur.archlinux.org/aconfmgr-git.git "$build_dir/aconfmgr-git"
(cd "$build_dir/aconfmgr-git" && makepkg -si --noconfirm)
```

- [ ] **Step 2: Make executable**

```bash
mkdir -p hooks/linux/pre-up
chmod +x hooks/linux/pre-up/aconfmgr-bootstrap
```

Note: if the file didn't exist before, write it under `hooks/linux/pre-up/aconfmgr-bootstrap` directly.

- [ ] **Step 3: Syntax + lint**

Run: `bash -n hooks/linux/pre-up/aconfmgr-bootstrap`
Expected: exit 0.

If `shellcheck` is installed: `shellcheck hooks/linux/pre-up/aconfmgr-bootstrap`
Expected: no errors (SC2155 and similar style warnings on `local` declarations are fine; this hook has none).

- [ ] **Step 4: Run `./script/test`**

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add hooks/linux/pre-up/aconfmgr-bootstrap
git -c user.email=jacob@jacobsmith.io -c user.name="Jacob Smith" -c commit.gpgsign=false commit -m "$(cat <<'EOF'
Add aconfmgr-bootstrap hook for Arch

Idempotent installer for base-devel, git, and aconfmgr-git (from AUR
via makepkg). Runs in pre-up so packages are available to subsequent
shared hooks (node, ruby, git-crypt, pipx).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Implement `hooks/linux/pre-up/aconfmgr-apply`

Runs `aconfmgr apply` with explicit `-c` path (rcm hasn't symlinked yet at pre-up time). No-ops when the manifest is empty.

**Files:**
- Create: `hooks/linux/pre-up/aconfmgr-apply`

- [ ] **Step 1: Write the hook**

```bash
#!/usr/bin/env bash
#
# Apply the aconfmgr declarative manifest.
# DOTFILES_ROOT is exported by hooks/dispatch.sh.

set -eo pipefail

config_dir="$DOTFILES_ROOT/tag-linux/config/aconfmgr"

# No-op until the manifest has at least one non-comment, non-blank line.
if [ ! -f "$config_dir/00-packages.sh" ] \
   || ! grep -qE '^[[:space:]]*[^#[:space:]]' "$config_dir/00-packages.sh"; then
  echo "aconfmgr: 00-packages.sh is empty (no declarations); skipping apply."
  exit 0
fi

if ! command -v aconfmgr >/dev/null 2>&1; then
  echo "aconfmgr binary not found; did aconfmgr-bootstrap run?" >&2
  exit 1
fi

aconfmgr -c "$config_dir" apply -y
```

- [ ] **Step 2: Make executable**

```bash
chmod +x hooks/linux/pre-up/aconfmgr-apply
```

- [ ] **Step 3: Sanity-test the no-op path**

The hook should print the skip message and exit 0 because `00-packages.sh` is still empty.

Run: `DOTFILES_ROOT="$PWD" bash hooks/linux/pre-up/aconfmgr-apply`
Expected: `aconfmgr: 00-packages.sh is empty (no declarations); skipping apply.` and exit 0.

- [ ] **Step 4: Run `./script/test`**

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add hooks/linux/pre-up/aconfmgr-apply
git -c user.email=jacob@jacobsmith.io -c user.name="Jacob Smith" -c commit.gpgsign=false commit -m "$(cat <<'EOF'
Add aconfmgr-apply hook for Arch

Runs aconfmgr -c <repo>/tag-linux/config/aconfmgr apply -y. Uses
explicit -c because pre-up runs before rcm has symlinked
~/.config/aconfmgr. No-ops on an empty manifest so the bootstrap
sequence works on a fresh repo before seeding.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Implement `hooks/linux/post-up/fonts`

**Files:**
- Create: `hooks/linux/post-up/fonts`

- [ ] **Step 1: Write the hook**

```bash
#!/usr/bin/env bash
#
# Refresh the system font cache after rcm-managed font submodules and
# any aconfmgr-installed font packages have landed in ~/.local/share/fonts
# or /usr/share/fonts.

set -eo pipefail

if command -v fc-cache >/dev/null 2>&1; then
  echo "Refreshing font cache..."
  fc-cache -f
fi
```

- [ ] **Step 2: Make executable**

```bash
mkdir -p hooks/linux/post-up
chmod +x hooks/linux/post-up/fonts
```

- [ ] **Step 3: Syntax check + run `./script/test`**

```bash
bash -n hooks/linux/post-up/fonts
./script/test
```
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add hooks/linux/post-up/fonts
git -c user.email=jacob@jacobsmith.io -c user.name="Jacob Smith" -c commit.gpgsign=false commit -m "$(cat <<'EOF'
Add linux post-up fonts hook (fc-cache)

Linux analog of hooks/mac/post-up/fonts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Implement `hooks/linux/post-up/user-services`

**Files:**
- Create: `hooks/linux/post-up/user-services`
- Create: `hooks/linux/user-services.list`

- [ ] **Step 1: Write the hook**

```bash
#!/usr/bin/env bash
#
# Enable systemd --user services declared in user-services.list.
# One unit per line; '#' starts a comment; blank lines ignored.
# Removing a line does NOT auto-disable: run `systemctl --user disable
# <unit>` manually if you want to retire a service.

set -eo pipefail

list="$DOTFILES_ROOT/hooks/linux/user-services.list"
[ -f "$list" ] || exit 0

while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -z "$line" ] && continue
  echo "Enabling user service: $line"
  systemctl --user enable --now "$line"
done < "$list"
```

- [ ] **Step 2: Make executable**

```bash
chmod +x hooks/linux/post-up/user-services
```

- [ ] **Step 3: Create the empty list file with header**

`hooks/linux/user-services.list`:

```
# systemd --user units to enable on rcup, one per line.
# Lines starting with '#' are comments; blank lines are ignored.
# Example:
#   ssh-agent.service
```

- [ ] **Step 4: Syntax check + run `./script/test`**

```bash
bash -n hooks/linux/post-up/user-services
./script/test
```
Expected: both succeed. The empty list means the hook is a no-op when run live.

- [ ] **Step 5: Sanity-run the hook against the empty list**

```bash
DOTFILES_ROOT="$PWD" bash hooks/linux/post-up/user-services
```
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add hooks/linux/post-up/user-services hooks/linux/user-services.list
git -c user.email=jacob@jacobsmith.io -c user.name="Jacob Smith" -c commit.gpgsign=false commit -m "$(cat <<'EOF'
Add linux post-up user-services hook + empty manifest

Reads hooks/linux/user-services.list and runs systemctl --user enable
--now per declared unit. Empty manifest = no-op. Disable is manual.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Document the aconfmgr seeding procedure

This is a one-off operation, not in code; document so it's reproducible.

**Files:**
- Create: `docs/superpowers/specs/2026-05-12-arch-aconfmgr-seeding.md`

- [ ] **Step 1: Write the document**

```markdown
# Seeding `tag-linux/config/aconfmgr/00-packages.sh`

**Status:** Manual one-off procedure.
**Prerequisite:** `hooks/linux/pre-up/aconfmgr-bootstrap` has run at
least once (i.e. `aconfmgr` is installed).

## Procedure

1. **Snapshot the current Arch system.**

   ```bash
   aconfmgr -c ~/.dotfiles/tag-linux/config/aconfmgr save
   ```

   This overwrites `00-packages.sh` (and possibly `10-files.sh`,
   `99-unknown.sh`) with `AddPackage` / `AddPackageGroup` lines for
   every explicitly-installed package on the current system, plus an
   `IgnorePath` block for filesystem state aconfmgr couldn't classify.

2. **Inspect the diff against the empty seed.**

   ```bash
   git diff tag-linux/config/aconfmgr/
   ```

   Look for noise: experiments, abandoned tools, packages installed by
   another tool that shouldn't be tracked here. Remove their
   `AddPackage` lines.

3. **Cross-reference the macOS Brewfile.**

   ```bash
   grep -E '^(brew|cask)' tag-mac/Brewfile | awk '{print $2}' | tr -d '"'
   ```

   For each line, decide:

   - It has an Arch equivalent (often same name, sometimes prefixed
     with a category like `python-`, `ttf-`, etc.) **and** isn't yet in
     `00-packages.sh`: add `AddPackage <arch-name>` (or the AUR name).
   - It's macOS-only (`alfred`, `kaleidoscope`, `1password` GUI app,
     yabai/skhd casks, etc.): skip — `tag-mac/Brewfile` keeps owning it.
   - It exists on Arch but you don't actually use it: skip.

4. **Hand-organize the file.**

   Group by category with comments, e.g.:

   ```bash
   # Build tools
   AddPackage base-devel
   AddPackage git

   # Shells & terminals
   AddPackage zsh
   AddPackage starship

   # AUR
   AddPackage aconfmgr-git
   AddPackage 1password-cli
   ```

5. **Verify aconfmgr is satisfied.**

   ```bash
   aconfmgr -c ~/.dotfiles/tag-linux/config/aconfmgr check
   ```

   Reports `System state matches configuration` if no drift.

6. **Commit.**

   ```bash
   git add tag-linux/config/aconfmgr/
   git commit -m "Seed aconfmgr manifest from current Arch state + Brewfile review"
   ```

## After seeding

- `./script/setup` runs `aconfmgr apply -y` non-trivially.
- New packages: edit `00-packages.sh` and re-run `./script/setup` (or
  `aconfmgr -c ~/.dotfiles/tag-linux/config/aconfmgr apply -y`).
- Drift between system and manifest: `aconfmgr check`; reconcile via
  `aconfmgr save` (capture the new state) or `aconfmgr apply -y`
  (force system to match manifest).
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-05-12-arch-aconfmgr-seeding.md
git -c user.email=jacob@jacobsmith.io -c user.name="Jacob Smith" -c commit.gpgsign=false commit -m "$(cat <<'EOF'
Document aconfmgr seeding procedure

One-off manual steps to populate tag-linux/config/aconfmgr/00-packages.sh
from the current Arch state plus Brewfile cross-reference.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Update `CLAUDE.md` to reflect new hook layout

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Replace the hooks paragraph**

Locate the existing line in `CLAUDE.md`:

```markdown
- `hooks/pre-up/` and `hooks/post-up/` run during `rcup` — these handle Homebrew, Ruby, Node, Vim plugins, git-crypt, fonts, and macOS preferences
```

Replace with:

```markdown
- `hooks/pre-up/dispatch` and `hooks/post-up/dispatch` are the only rcm-visible hooks. They source `hooks/dispatch.sh`, which detects the OS (`mac` or `linux`) and runs scripts from `hooks/shared/<phase>/*` then `hooks/<os>/<phase>/*`. Individual hook scripts are OS-pure — no inline guards. Override OS detection in tests with `DOTFILES_OS_OVERRIDE={mac,linux}`. Arch package state is declared in `tag-linux/config/aconfmgr/` and applied by `hooks/linux/pre-up/aconfmgr-apply`.
```

- [ ] **Step 2: Add an Arch-specific section under "Structure"**

Add the following bullet to the `Structure` list (after the `tag-mac/` bullet):

```markdown
- `tag-linux/` — Linux-only (Arch). `config/aconfmgr/` declares pacman+AUR state; `config/hypr/` (and siblings) hold Hyprland-stack configs symlinked to `~/.config/`. See `docs/superpowers/specs/2026-05-12-arch-aconfmgr-seeding.md` for how to seed the package manifest.
```

- [ ] **Step 3: Add a Key Commands entry**

Under `Key Commands`, append:

```markdown
- **Run tests/lint**: `./script/test` — bash -n, shellcheck (if installed), guard assertion, dispatcher unit test. Non-destructive.
```

- [ ] **Step 4: Run `./script/test` one more time**

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git -c user.email=jacob@jacobsmith.io -c user.name="Jacob Smith" -c commit.gpgsign=false commit -m "$(cat <<'EOF'
Update CLAUDE.md for new hook layout + Arch tag

Documents the dispatcher, tag-linux/ scaffolding, and script/test
entrypoint so future sessions pick up the convention.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Post-implementation: user-driven steps (NOT in this plan)

These are out of scope for the engineer executing the plan and remain the user's manual call:

1. **Seed `00-packages.sh`** per the seeding doc.
2. **Run `./script/setup`** on the live Arch machine to apply.
3. **Populate `tag-linux/config/hypr/`** with the actual Hyprland config.
4. **Add user services** to `hooks/linux/user-services.list` as needs arise.
5. **Re-verify on a mac** (if available) that `./script/setup` and `rcup` still behave identically.

---

## Self-review notes

Spec coverage walk-through:

- **Architecture / 3 lanes** → Tasks 3 (dispatcher), 8–10 (aconfmgr), 4–7 (hooks migration) ✓
- **Hook dispatch / guards refactor** → Tasks 1–7 ✓
- **`tag-linux/config/aconfmgr/`** → Tasks 8, 10, 13 ✓
- **Hyprland & user services** → Tasks 8 (hypr/ placeholder), 12 (user-services) ✓
- **rcrc changes** → Spec calls these "no change needed" given the new layout; verified by Task 7 still passing with the existing rcrc. No explicit task needed.
- **script/setup changes** → Spec calls these "no further changes"; verified by `./script/test` and the rcrc still gating tags. No explicit task needed.
- **Bootstrap path** → Implicit in the hook ordering; documented in CLAUDE.md (Task 14).
- **Seeding procedure** → Task 13 ✓
- **Risks & failure modes** → Addressed in implementation (no-op on empty manifest in Task 10; aconfmgr-apply guards against missing binary; git-crypt install hint generalized in Task 5).
- **Out-of-scope items** → respected: no /etc state, no auto-disable, no cross-distro work.
