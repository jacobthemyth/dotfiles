# Declarative Arch Linux config in the dotfiles repo

**Status:** Design approved (pending user review of this document)
**Date:** 2026-05-12

## Goal

Extend the existing rcm-based dotfiles repo so the same `script/setup` can
bring a fresh Arch Linux machine to a fully-configured state, with package
state managed declaratively. Mac support must continue to work unchanged.

## Scope

In scope:

- Pacman + AUR packages, declared and reconciled (drift-detecting).
- Dotfile symlinks to `~/` and `~/.config/` (via rcm, as today).
- User-level systemd services: `systemctl --user enable --now` from a
  manifest list.
- Hyprland (Wayland) and its stack of companion configs (waybar, mako,
  hypridle/hyprlock, etc.) as plain config files under `~/.config/`.
- Font cache refresh after install.
- Refactoring the existing `[[ "$OSTYPE" == "darwin"* ]] || exit` guards
  in mac-only hooks into a clean OS dispatch mechanism.

Out of scope (v1):

- `/etc/` declarative state via aconfmgr's `CopyFile`/`CreateFile`.
- Auto-disabling systemd user units removed from the manifest.
- Cross-distro Linux support — `linux` tag is implicitly Arch.
- Migration to home-manager / Nix.
- Multi-host (rcm `host-*`) variations.

## Architecture

Three responsibility lanes, each with one focused tool:

| Concern | Tool | Source of truth |
|---|---|---|
| Symlink dotfiles to `~/` | rcm (unchanged) | top-level files, `config/`, `tag-mac/`, `tag-linux/` |
| Arch package state | aconfmgr | `tag-linux/config/aconfmgr/*.sh` |
| Bootstrap glue | shell hooks | `hooks/<phase>/dispatch` + `hooks/{shared,mac,linux}/<phase>/*` |

### Hook dispatch (the guards refactor)

rcm 1.3.6 only iterates `hooks/pre-up/` and `hooks/post-up/`, and only by
exact path — no tag interpolation. Hook execution is unconditional; tags
only filter file symlinking. (Confirmed in `share/rcm.sh.in:130`.)

We exploit a different fact: rcm treats `hooks/` as meta — it neither
symlinks the directory nor scans its non-pre-up/post-up children. So
subdirectories like `hooks/shared/`, `hooks/mac/`, `hooks/linux/` are
invisible to rcm and free for our own use.

New layout:

```
hooks/
  pre-up/dispatch              # the only file rcm sees
  post-up/dispatch
  shared/
    pre-up/submodules
    post-up/{claude-plugins,git-crypt,node,pipx,ruby,vim,zsh}
  mac/
    pre-up/{homebrew,filelimit}
    post-up/{fonts,preferences}
  linux/
    pre-up/{aconfmgr-bootstrap,aconfmgr-apply}
    post-up/{fonts,user-services}
    user-services.list         # data file read by post-up/user-services
```

The dispatcher (single script, symlinked or copied as both `pre-up/dispatch`
and `post-up/dispatch`):

```bash
#!/usr/bin/env bash
set -eo pipefail
phase="$(basename "$(dirname "$(realpath "$0")")")"   # pre-up | post-up
root="$(cd "$(dirname "$(realpath "$0")")/../.." && pwd)"

case "$(uname -s)" in
  Darwin) os=mac ;;
  Linux)  os=linux ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

run_dir() {
  local d="$1"
  [ -d "$d" ] || return 0
  for h in "$d"/*; do
    [ -f "$h" ] && [ -x "$h" ] || continue
    echo "▶ $phase/$(basename "$(dirname "$d")")/$(basename "$h")"
    "$h"
  done
}

run_dir "$root/hooks/shared/$phase"
run_dir "$root/hooks/$os/$phase"
```

Every individual hook becomes OS-pure: no more `[[ darwin ]] || exit`
guards anywhere. The OS choice is made once, in `dispatch`.

Migration table:

| Old path | New path | Notes |
|---|---|---|
| `hooks/pre-up/00-mac-homebrew` | `hooks/mac/pre-up/homebrew` | drop guard, drop `00-` prefix |
| `hooks/pre-up/mac-filelimit` | `hooks/mac/pre-up/filelimit` | drop guard, drop `mac-` prefix |
| `hooks/pre-up/submodules` | `hooks/shared/pre-up/submodules` | unchanged |
| `hooks/post-up/mac-fonts` | `hooks/mac/post-up/fonts` | drop guard, drop `mac-` prefix |
| `hooks/post-up/mac-preferences` | `hooks/mac/post-up/preferences` | drop guard, drop `mac-` prefix |
| `hooks/post-up/{claude-plugins,git-crypt,node,pipx,ruby,vim,zsh}` | `hooks/shared/post-up/<same>` | already cross-platform; one-line message tweak in `git-crypt` to not hard-code `brew install` |
| *(new)* | `hooks/linux/pre-up/aconfmgr-bootstrap` | install base-devel, git, aconfmgr-git from AUR |
| *(new)* | `hooks/linux/pre-up/aconfmgr-apply` | `aconfmgr -c <repo>/tag-linux/config/aconfmgr apply -y` |
| *(new)* | `hooks/linux/post-up/fonts` | `fc-cache -f` |
| *(new)* | `hooks/linux/post-up/user-services` | read `user-services.list`, enable each |

### Arch package & system lane (aconfmgr)

`tag-linux/config/aconfmgr/` is rcm-symlinked to `~/.config/aconfmgr/`
(aconfmgr's default config location, no extra flags needed for ad-hoc use):

```
tag-linux/config/aconfmgr/
  00-packages.sh        # AddPackage / AddPackageGroup / IgnorePackage
  10-files.sh           # CopyFile / CreateLink — stub for future use
```

Two new linux pre-up hooks do the work:

- **`aconfmgr-bootstrap`** — idempotent. Ensures `base-devel`, `git`, and
  `aconfmgr-git` are installed. Clones `aconfmgr-git` AUR repo into a
  temp dir on first run and builds via `makepkg -si --noconfirm`. Skips
  on subsequent runs (`pacman -Q aconfmgr` check). No AUR helper required
  for the bootstrap.
- **`aconfmgr-apply`** — runs
  `aconfmgr -c "$DOTFILES_ROOT/tag-linux/config/aconfmgr" apply -y`. The
  explicit `-c` path is required because `aconfmgr-apply` runs in
  *pre-up*, before rcm has had a chance to create the
  `~/.config/aconfmgr` symlink.

Why pre-up: many shared post-up hooks (`node`, `ruby`, `git-crypt`, `pipx`)
depend on packages being available (nodenv, rbenv, 1Password CLI, pipx).
Packages must be installed before those hooks run.

### Seeding the package manifest (one-off, not part of rcup)

On the current Arch machine:

1. `aconfmgr -c ~/.dotfiles/tag-linux/config/aconfmgr save` — captures the
   current installed package set into `00-packages.sh`.
2. Walk `tag-mac/Brewfile` and for each entry decide:
   - If it has an Arch equivalent and is *not* already in `00-packages.sh`,
     append it (with the correct Arch package name, possibly AUR).
   - If it has no Arch equivalent (mac-only casks like `1password`,
     `alfred`, `kaleidoscope`), skip — `tag-mac` still owns those.
3. Hand-review the diff: prune anything noisy the `save` picked up
   (experiments, throwaways, kernel-tied modules), then commit.

This step is documented in the implementation plan; the design simply
asserts the resulting `00-packages.sh` is the committed source of truth.

### Hyprland & user services

- Hyprland and stack configs live at `tag-linux/config/<name>/`:
  - `tag-linux/config/hypr/hyprland.conf` (and any included files)
  - `tag-linux/config/waybar/` if used
  - `tag-linux/config/mako/` if used
  - `tag-linux/config/hypr/hyprlock.conf`, `hypridle.conf` if used
- These rcm-symlink to `~/.config/<name>/` only when the `linux` tag is
  active. Mac never sees them.
- `tag-mac/skhdrc` and `tag-mac/config/yabai/` are unchanged — their
  Hyprland counterparts are the files above.
- `hooks/linux/post-up/user-services` reads
  `hooks/linux/user-services.list` (one systemd user unit per line, `#`
  comments allowed) and runs `systemctl --user enable --now <unit>` for
  each. Initially empty; grows over time. Removing a line does *not*
  auto-disable — disabling is manual via `systemctl --user disable`. This
  is intentional: keeps blast radius small in v1.
- `hooks/linux/post-up/fonts` runs `fc-cache -f`. Fonts come from the
  existing `~/.local/share/fonts` (already populated by the
  `tinted-theming` submodule or via aconfmgr-installed font packages).

### rcrc changes

Current `rcrc` already sets `RCM_OS_TAG=linux` on linux-gnu — no change.
Two tidy-ups:

- Drop `UNDOTTED="Library"` from the linux branch (Library is mac-only).
- No new `EXCLUDES` entries needed: everything non-symlinkable lives
  inside `hooks/`, which rcm already ignores entirely.

### script/setup changes

The existing `script/setup` already detects OS via `$OSTYPE` to set
`RCM_OS_TAG`. After this change:

- The `RCM_OS_TAG` derivation stays (it gates symlinking via `TAGS`).
- The `UNDOTTED="Library"` export moves under the darwin branch only
  (it's already there — confirm).
- No further changes; `rcup` invocation is unchanged.

## Bootstrap path for a fresh Arch box

User prereqs (manual): base Arch install, working network, user account
with `sudo`, ssh key registered with the dotfiles repo host.

```bash
git clone <repo-url> ~/.dotfiles
cd ~/.dotfiles
./script/setup
#   → installs rcm if missing
#   → rcup -t linux
#       → hooks/pre-up/dispatch
#         → shared/pre-up/submodules
#         → linux/pre-up/aconfmgr-bootstrap   # base-devel, git, aconfmgr-git
#         → linux/pre-up/aconfmgr-apply       # all packages
#       → symlink stage (rcm core)
#         → ~/.zshrc, ~/.config/hypr/*, ~/.config/aconfmgr/*, ...
#       → hooks/post-up/dispatch
#         → shared/post-up/{claude-plugins,git-crypt,node,pipx,ruby,vim,zsh}
#         → linux/post-up/{fonts,user-services}
```

On second and subsequent `rcup` runs everything is idempotent: aconfmgr
detects no drift, language toolchains report already-installed, font
cache is a no-op, user services already enabled.

## Risks & failure modes

| Risk | Mitigation |
|---|---|
| First-time aconfmgr build is slow (compiles from AUR) | One-time cost, well-documented in setup output |
| `aconfmgr save` captures cruft on the seed run | Hand-review + Brewfile cross-reference before first commit |
| Existing files on the Arch box conflict with rcup symlinks | rcup's default `-i` prompts per file; user resolves case-by-case |
| 1Password CLI not yet installed when `git-crypt` hook runs | `1password-cli` declared in `00-packages.sh`, installed before post-up; existing hook error message generalized away from `brew install` |
| aconfmgr deletes packages someone installed for valid ad-hoc reasons | `aconfmgr apply` prompts before destructive operations by default; `-y` only auto-confirms additions, not removals (verify behavior in implementation) |
| `paru`/`yay` not strictly required but useful for ad-hoc | Declared in `00-packages.sh` so it's installed by aconfmgr |

## What "done" looks like

- Fresh Arch VM → clone repo → `./script/setup` → reboot → log into
  Hyprland → all expected packages present, all configs symlinked, all
  user services running.
- `rcup` re-run on either mac or arch produces no unexpected output.
- No `[[ darwin ]] || exit` guards anywhere in `hooks/`.
- `aconfmgr -c <path> check` (drift check) reports clean.

## Open questions (decide during implementation, not blocking design)

- Whether to mirror the same `hooks/{shared,mac,linux}` convention by
  moving `tag-mac/Brewfile` into `hooks/mac/data/Brewfile` for symmetry,
  or leave it where it is. Lean toward "leave it" — current setup
  isn't broken.
- Whether `aconfmgr-apply` should be wrapped to gracefully no-op when
  `00-packages.sh` is empty during the very first commit. Lean yes.
- Concrete initial contents of `user-services.list` (likely just
  `pipewire`-related if anything; Hyprland starts most things via
  `exec-once`).
