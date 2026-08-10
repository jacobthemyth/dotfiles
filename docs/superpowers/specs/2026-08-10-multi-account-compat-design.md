# Multi-account compatibility on a Fast-User-Switching Mac

**Status:** Design approved (pending user review of this document)
**Date:** 2026-08-10

## Goal

This Mac has two macOS accounts (`jacob`, `testdouble`) kept logged in
simultaneously via Fast User Switching (FUS). `jacob` owns the machine's
single shared Homebrew install at `/opt/homebrew` (confirmed: `drwxr-xr-x
jacob staff`, not group-writable). Running `rcup` from `testdouble` today
either fails or silently misbehaves wherever a hook assumes it can write to
that shared, foreign-owned resource. Make every hook safe to run from either
account, without requiring `testdouble` to ever gain write access to
`jacob`'s Homebrew install.

## Scope

**Actionable fixes (this spec):**

1. `hooks/mac/pre-up/homebrew` — detect write access at runtime; owner
   account behaves as today, other accounts get a read-only presence check
   and a warning instead of a permission error.
2. `zsh/configs/completion.zsh` — stop `compinit` from hitting an
   interactive (and, in non-interactive contexts, unanswerable) prompt about
   Homebrew's foreign-owned zsh completions.
3. `script/setup` — replace the hardcoded `/tmp/rcm-1.3.6*` paths with a
   unique temp directory, so two accounts' concurrent first-time setups
   can't collide.
4. `hooks/mac/pre-up/filelimit` — fix a pre-existing bug where the
   `launchctl load` calls are nested under the wrong `if` block (found
   during this investigation; not multi-account-specific, but in scope per
   request).

**Investigated, confirmed already safe — no code change:**

- **yabai scripting-addition load** (`tag-mac/config/yabai/yabairc:10-11`)
  — originally flagged as a race between two FUS sessions patching a
  shared resource, with a planned fix gating `--load-sa` behind a
  `--check-sa` pre-check. That flag does not exist on the installed yabai
  (v7.1.24, the `asmvik/yabai` fork — confirmed via `yabai --help` and
  `man yabai`). `man yabai` describes `--load-sa` itself as installing and
  updating the scripting-addition bundle at
  `/Library/ScriptingAdditions/yabai.osax` "when necessary," and it's
  designed to be invoked repeatedly (that's the whole point of wiring it to
  the `dock_did_restart` signal) — i.e. idempotency is already yabai's own
  responsibility, not something this repo's config should try to
  second-guess with a nonexistent flag. Left unchanged. A narrow residual
  risk remains — two sessions' Dock.app processes both triggering the
  install path at the exact same moment, before the addition has ever been
  installed once — but that's a TOCTOU race inside yabai's own
  implementation that no dotfiles-level config change can fix, and the
  window for it is vanishingly small (only matters on the very first
  install, with sub-second timing overlap between two sessions coming up
  simultaneously).
- **skhd global hotkeys** (`tag-mac/skhdrc`) — macOS isolates FUS sessions
  at the kernel level: a backgrounded session receives no keyboard/mouse
  input at all ("as if the display had gone to sleep" for that session).
  `skhd`'s `CGEventTap` is session-scoped, so a backgrounded account's skhd
  simply never sees a keypress. No two-account contention is possible.
- **git-crypt** (`hooks/shared/post-up/git-crypt`) — each account has its
  own `$HOME/.dotfiles` clone and its own 1Password sign-in; the unlock
  check is already idempotent (`git-crypt status | grep unlocked`).
- **`hooks/mac/post-up/preferences`** — nearly everything is a per-user
  `defaults write` (stored in that account's own
  `~/Library/Preferences/`, including `NSGlobalDomain`, which despite the
  name is per-user). The one genuinely machine-wide line (`sudo nvram
  SystemAudioVolume`) is idempotent to re-run. The many commented-out
  machine-wide lines (`ComputerName`, timezone, `pmset`) are inert; flagged
  here as land mines if anyone uncomments them later, not fixed now.
- **SSH / 1Password / gpg agent sockets** — grepped the whole repo; no
  hardcoded agent socket paths exist.
- **tmux / direnv / rbenv / nodenv / pyenv / Doom Emacs** — all state lives
  under `$HOME`; no fixed-name sockets, PID files, or lock files that two
  accounts could collide on.
- **Hardcoded home-directory paths** — grepped the whole repo; none exist.
  Everything uses `$HOME`/`~`.

**Out of scope:**

- Any change to Homebrew's own permission model (no `chgrp`/`chmod` sharing
  hacks — see Architecture §1 for why).
- A sudo-impersonation proxy that would let `testdouble` actually install
  packages through `jacob`'s Homebrew. Not needed for the stated goal
  (read-only fallback), and the architecture below doesn't preclude adding
  it later.
- yabai's one-time `--install-sa` (SIP-adjacent) setup — that's a manual,
  whole-machine, one-time step already done outside of `rcup`; not
  triggered by any hook in this repo.

## Architecture

### 1. Homebrew: write-access detection + read-only fallback

`hooks/mac/pre-up/homebrew` currently has three mutating commands
(`brew update`, `brew bundle`, `brew cleanup`) commented out as a stopgap.
Replace the stopgap with a runtime branch:

```bash
#!/usr/bin/env bash

set -eo pipefail

if [[ "$(arch)" == "arm64" ]]; then
  brew_path="/opt/homebrew/bin/brew"
else
  brew_path="/usr/local/bin/brew"
fi

if ! command -v "$brew_path" >/dev/null; then
  echo "Installing Homebrew ..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/master/install.sh)"
fi

eval "$($brew_path shellenv)"

brew_prefix="$($brew_path --prefix)"

if [ -w "$brew_prefix" ]; then
  echo "Updating Homebrew formulae ..."
  brew update
  brew bundle --file="$HOME/.dotfiles/tag-mac/Brewfile"

  echo "Cleaning up old Homebrew formulae ..."
  brew cleanup
else
  owner="$(stat -f "%Su" "$brew_prefix")"
  if ! missing="$(brew bundle check --no-upgrade --verbose --file="$HOME/.dotfiles/tag-mac/Brewfile" 2>&1)"; then
    echo "⚠ Homebrew at $brew_prefix is owned by $owner; this account has no write access." >&2
    echo "  Missing from the Brewfile (ask $owner to run rcup or 'brew bundle'):" >&2
    echo "  ${missing//$'\n'/$'\n  '}" >&2
  fi
fi
```

Why runtime detection instead of a hardcoded owner: it self-adjusts if
Homebrew is ever reinstalled under a different account, and it needs no new
config file. The write-access test checks the prefix root only — confirmed
on this machine that the whole `/opt/homebrew` tree is uniformly owned by
one user, so the root is representative. (If that assumption ever proves
wrong — e.g. a partial `chown` — upgrade to checking `Cellar`/`Caskroom`
directly.)

**Why not grant `testdouble` write access instead?** Researched and
rejected: Homebrew's own FAQ states an install is meant for a single
non-root user, and the common `chgrp admin && chmod -R g+w` workaround is
documented to rot over time — `brew`'s default umask doesn't preserve
group-write on newly installed files, so each `brew install` silently
narrows what the other account can touch again ([Renuo: How the Homebrew
Multi-User Rabbit Hole Bricked My
Mac](https://www.renuo.ch/blog/homebrew-multi-user); [CodeJam: Using
Homebrew on a multi-user system
(don't)](https://www.codejam.info/2021/11/homebrew-multi-user.html)).
Read-only fallback is the community- and vendor-recommended path when one
account is the de facto owner.

**Known limitation, not fixed:** the fallback account's warning can only
ever reflect the *presence* of Brewfile entries (`brew bundle check`), not
whether installed versions are current — `brew outdated` needs a fresh
`brew update`, which needs write access `testdouble` doesn't have. A
"stale version" warning from `testdouble` would only ever reflect
`jacob`'s last `brew update`, which isn't actionable information beyond
"ask jacob to update" — the same message the presence check already gives.

### 2. zsh: stop prompting about Homebrew's foreign-owned completions

Confirmed root cause: `compaudit` flags every file under
`/opt/homebrew/share/zsh/site-functions` because they're owned by `jacob`
(not `testdouble`, not root) — this is a pure ownership check, unrelated to
actual write permission.

Confirmed exact bug, from `compinit`'s own source
(`/usr/share/zsh/5.9/functions/compinit:67-72`):

> The `-C` flag bypasses both the check for rebuilding the dump file and
> the usual call to `compaudit`; the `-i` flag causes insecure directories
> found by `compaudit` to be ignored... Otherwise the user is queried...
> which means compinit should not be called from non-interactive shells.

`zsh/configs/completion.zsh` attaches `-i` to `autoload` (line 6), where it
does nothing — `compinit -C` (the cache-hit path, line 10) is already
unaffected since `-C` skips `compaudit` entirely, but the cache-miss path
(`compinit -d $HOME/.zcompdump`, line 8) runs the full check with no `-i`,
hitting the exact unanswerable prompt reported. Fix:

```bash
# load our own completion functions
fpath=(~/.zsh/completion /usr/share/zsh/site-functions /usr/local/share/zsh/site-functions $fpath)
command -v brew >/dev/null && fpath=("$(brew --prefix)/share/zsh/site-functions" $fpath)

# completion; use cache if updated within 24h
autoload -Uz compinit
if [[ -n $HOME/.zcompdump(#qN.mh+24) ]]; then
  compinit -d $HOME/.zcompdump -i;
else
  compinit -C;
fi;

# disable zsh bundled function mtools command mcd
# which causes a conflict.
compdef -d mcd
```

Trusting `jacob`'s completions from `testdouble` is a deliberate,
documented trade-off — both accounts belong to the same person, so the
"insecure" ownership mismatch compaudit is protecting against doesn't
apply here.

### 3. `script/setup`: race-free temp directory

`script/setup` downloads and builds rcm at the hardcoded paths
`/tmp/rcm-1.3.6.tar.gz` and `/tmp/rcm-1.3.6/`. Two accounts' first-ever
`./script/setup` run (before rcm is installed) could race on this shared,
non-namespaced path. Fix:

```bash
rcm_tmp="$(mktemp -d)"
trap 'rm -rf "$rcm_tmp"' EXIT

curl --output-dir "$rcm_tmp" --remote-name -L "https://thoughtbot.github.io/rcm/dist/rcm-$rcm_version.tar.gz"
...
tar -C "$rcm_tmp" -xvf "$rcm_tmp/rcm-$rcm_version.tar.gz"
cd "$rcm_tmp/rcm-$rcm_version"
```

### 4. `filelimit`: fix `launchctl load` scoping

Currently both `sudo launchctl load` calls (lines 65-66) live inside the
`maxproc` block, not their respective `maxfiles`/`maxproc` blocks. Two
concrete bugs, independent of multi-account: (a) if only `maxfiles` needs
raising, its plist is written but never loaded until next reboot; (b) if
only `maxproc` needs raising and `maxfiles.plist` doesn't exist yet
(because `maxfiles` was already fine), `launchctl load` on a missing file
fails and — under `set -eo pipefail` — aborts the whole hook, failing
`rcup`. Fix: move each `launchctl load` into its own block, right after
that block creates its plist:

```bash
if [[ "$maxfiles" -lt 200000 ]]; then
  echo "Increasing open file limit (requires sudo)..."
  if [ ! -f "/Library/LaunchDaemons/limit.maxfiles.plist" ]; then
    cat <<EOS | sudo tee /Library/LaunchDaemons/limit.maxfiles.plist >/dev/null
...
EOS
  fi
  sudo launchctl load /Library/LaunchDaemons/limit.maxfiles.plist
fi

if [[ "$maxproc" -lt 2048 ]]; then
  echo "Increasing max process limit (requires sudo)..."
  if [ ! -f "/Library/LaunchDaemons/limit.maxproc.plist" ]; then
    cat <<EOS | sudo tee /Library/LaunchDaemons/limit.maxproc.plist >/dev/null
...
EOS
  fi
  sudo launchctl load /Library/LaunchDaemons/limit.maxproc.plist
fi
```

Because these are true kernel/system-wide limits (not per-user), once
either account raises them, the other account's hook run sees the limit
already satisfied and skips the block entirely — no second `sudo` prompt,
no double-load.

## Testing

- `bash -n` and `shellcheck` already run over all hook scripts via
  `script/test` — no changes needed there, new code lives in the same
  files.
- Add a fixture-based unit test, `test/homebrew_hook_test.sh` (mirroring
  `test/dispatch_test.sh`'s style): stub a fake `brew` on `PATH` that
  simulates `--prefix`, `bundle check`, `update`, `bundle`, `cleanup`; run
  the hook against a writable and a non-writable fixture prefix directory;
  assert the owner path still calls update/bundle/cleanup, the fallback
  path never does, and both exit 0.
- Manual verification on the real machine once implemented: run `rcup`
  from both `jacob` and `testdouble`, confirm the owner path is unchanged,
  the fallback path warns without failing, and no `compinit` prompt appears
  in a fresh `testdouble` shell.

## Risks & failure modes

| Risk | Mitigation |
|---|---|
| Write-access test passes at the prefix root but a deeper subdir isn't writable | Documented simplifying assumption (confirmed uniform ownership today); upgrade to per-subdir check if ever seen in practice |
| `brew bundle check` false-negative if Homebrew's local tap metadata is very stale | Acceptable — presence checking doesn't require fresh metadata; version-staleness detection is explicitly out of scope (see §1) |
| Fallback branch accidentally exits non-zero under `set -eo pipefail`, aborting `rcup` | Explicit `if ! missing="$(brew bundle check ...)"; then ...; fi` guard (assignment form, verified this doesn't trip `errexit`); branch always falls through to exit 0 |
| Owner account is ever renamed/recreated | Detection is dynamic (`stat` at runtime) — no hardcoded username to go stale |
| Two FUS sessions both trigger yabai's first-ever SA install at the same instant | Accepted, not mitigated — TOCTOU race lives inside yabai's own `--load-sa` implementation, no config-level fix available (see Scope) |

## What "done" looks like

- `testdouble`'s `rcup` run completes with no permission errors and no
  attempted Homebrew mutation; prints a warning only if Brewfile entries
  are actually missing.
- `jacob`'s `rcup` behavior is unchanged from before the WIP stopgap
  (update/bundle/cleanup run normally).
- A fresh `testdouble` shell starts with no `compinit` "insecure
  directories" prompt.
- Two accounts running `./script/setup` for the first time concurrently
  don't corrupt each other's rcm bootstrap.
- `./script/test` passes, including the new `homebrew_hook_test.sh`.

## Open questions (decide during implementation, not blocking design)

- Whether `test/homebrew_hook_test.sh`'s fake-`brew` stub should live in
  `test/fixtures/` or inline in the test script — lean toward inline,
  matching `dispatch_test.sh`'s existing style.

## Amendments during implementation

- **yabai fix dropped.** `--check-sa` does not exist on the installed
  yabai (v7.1.24, `asmvik/yabai` fork). `man yabai` documents `--load-sa`
  as already idempotent ("installs and updates... when necessary"), so
  `tag-mac/config/yabai/yabairc` was left unchanged rather than gated
  behind a flag that doesn't exist. See the Scope section's "Investigated,
  confirmed already safe" list for the full explanation.
- **`brew bundle check` warning formatting** uses bash parameter
  substitution (`${missing//$'\n'/$'\n  '}`) instead of piping through
  `sed 's/^/  /'`, per `shellcheck` (SC2001).
- **`hooks/shared/post-up/claude-plugins` crashed on real-world `./script/setup`.**
  `declare -A` needs bash >= 4, but macOS permanently ships 3.2 at
  `/bin/bash`, and this hook's `env bash` shebang depended on ambient PATH
  ordering to find a newer one — which only holds in a fully sourced
  interactive zsh session (`zshenv.local` prepends `/opt/homebrew/bin`
  there), not in other invocation contexts. Fixed at the correct layer:
  `hooks/dispatch.sh` now normalizes PATH once (prepending Homebrew's bin
  dirs when `os == mac`, via a `DOTFILES_BREW_DIRS_OVERRIDE` hook for
  testing) before dispatching *any* hook, rather than duplicating a
  bash-version guard into every hook that happens to need one. Verified
  live by reproducing the original PATH ordering and confirming the crash
  no longer occurs. `test/dispatch_test.sh` covers the PATH-prepend
  behavior (present on mac, absent on linux, no empty-PATH-component bug
  when no candidate dirs exist).
- **`claude-plugins` then silently uninstalled two active plugins**
  (`codex@openai-codex`, `document-skills@anthropic-agent-skills`) on the
  same run, once it could finally execute for the first time on this
  account — the manifest at `~/.dotfiles/claude-plugins` never declared
  them, even though `claude/settings.json`'s `enabledPlugins` had both set
  to `true`. Investigated whether `enabledPlugins` could just replace the
  manifest outright (verified with Claude Code's own docs): it can't —
  `enabledPlugins: false` only disables an already-installed plugin, it
  can't express "must not be installed," so it's structurally incapable of
  being a full install/uninstall source of truth. Also confirmed there is
  no user-level `~/.claude/settings.local.json` (only project-level
  `.claude/settings.local.json` exists), so per-machine plugin overrides
  can't work that way either. Fix: restored both entries to the manifest
  (with sources from `extraKnownMarketplaces`) and reinstalled them, then
  added a non-destructive drift check to the hook — if `enabledPlugins`
  ever again declares a plugin `true` that's absent from the manifest, it
  now warns loudly before the existing uninstall logic would otherwise
  remove it silently. Covered by the new `test/claude_plugins_hook_test.sh`.
- **Stop hook error resolved as a side effect.** A separate, live symptom
  — Claude Code's `openai-codex` plugin Stop hook failing with
  `/bin/sh: node: command not found` — traced back to the same root cause:
  `hooks/shared/post-up/node` had never successfully run for `testdouble`,
  because the old unguarded `hooks/mac/pre-up/homebrew` used to crash
  under `set -eo pipefail` on permission-denied, aborting all of `rcup`
  (including every post-up hook) before the WIP stopgap existed. Fixed by
  manually running `hooks/shared/post-up/node` once by hand; no code
  change was needed beyond this spec's Homebrew fix, which prevents the
  same class of failure going forward.
