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
