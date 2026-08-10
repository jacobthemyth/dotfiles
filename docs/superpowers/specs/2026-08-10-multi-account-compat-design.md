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
3. `tag-mac/config/yabai/yabairc` — make the scripting-addition load
   idempotent so two FUS sessions don't race on patching the single shared
   WindowServer process.
4. `script/setup` — replace the hardcoded `/tmp/rcm-1.3.6*` paths with a
   unique temp directory, so two accounts' concurrent first-time setups
   can't collide.
5. `hooks/mac/pre-up/filelimit` — fix a pre-existing bug where the
   `launchctl load` calls are nested under the wrong `if` block (found
   during this investigation; not multi-account-specific, but in scope per
   request).

**Investigated, confirmed already safe — no code change:**

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
    echo "$missing" | sed 's/^/  /' >&2
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

### 3. yabai: idempotent scripting-addition load

`tag-mac/config/yabai/yabairc:10-11` unconditionally calls `sudo yabai
--load-sa` on load and on every `dock_did_restart` signal, patching the one
shared WindowServer process. Unlike hotkeys, this isn't session-isolated —
it's a real race if both FUS sessions' yabairc fire it concurrently. Fix by
gating on yabai's own idempotency check:

```
yabai -m signal --add event=dock_did_restart action="yabai --check-sa >/dev/null 2>&1 || sudo yabai --load-sa"
yabai --check-sa >/dev/null 2>&1 || sudo yabai --load-sa
```

No "owner account" concept is needed here — whichever session gets there
first loads it, the other's check sees it's already loaded and no-ops. This
also means a non-admin second account no longer hits a `sudo` password
prompt in the common case where the SA is already loaded.

*(Implementation note: verify `yabai --check-sa`'s exact exit-code
semantics against the installed yabai version — confirm it exits non-zero
when not loaded and zero when loaded, since the design above depends on
that.)*

### 4. `script/setup`: race-free temp directory

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

### 5. `filelimit`: fix `launchctl load` scoping

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
  the fallback path warns without failing, no `compinit` prompt appears in
  a fresh `testdouble` shell, and yabai's `--load-sa` only actually fires
  once across both sessions (check via `yabai --check-sa` after both have
  loaded).

## Risks & failure modes

| Risk | Mitigation |
|---|---|
| Write-access test passes at the prefix root but a deeper subdir isn't writable | Documented simplifying assumption (confirmed uniform ownership today); upgrade to per-subdir check if ever seen in practice |
| `brew bundle check` false-negative if Homebrew's local tap metadata is very stale | Acceptable — presence checking doesn't require fresh metadata; version-staleness detection is explicitly out of scope (see §1) |
| Fallback branch accidentally exits non-zero under `set -eo pipefail`, aborting `rcup` | Explicit `if ! brew bundle check; then ...; fi` guard; branch always falls through to exit 0 |
| `yabai --check-sa` exit-code semantics differ from assumed | Verify against installed yabai version during implementation before relying on it |
| Owner account is ever renamed/recreated | Detection is dynamic (`stat` at runtime) — no hardcoded username to go stale |

## What "done" looks like

- `testdouble`'s `rcup` run completes with no permission errors and no
  attempted Homebrew mutation; prints a warning only if Brewfile entries
  are actually missing.
- `jacob`'s `rcup` behavior is unchanged from before the WIP stopgap
  (update/bundle/cleanup run normally).
- A fresh `testdouble` shell starts with no `compinit` "insecure
  directories" prompt.
- Both accounts logged in simultaneously via FUS never produce duplicate
  `sudo yabai --load-sa` attempts once the SA is loaded.
- Two accounts running `./script/setup` for the first time concurrently
  don't corrupt each other's rcm bootstrap.
- `./script/test` passes, including the new `homebrew_hook_test.sh`.

## Open questions (decide during implementation, not blocking design)

- Exact `yabai --check-sa` exit-code contract (verify against installed
  version).
- Whether `test/homebrew_hook_test.sh`'s fake-`brew` stub should live in
  `test/fixtures/` or inline in the test script — lean toward inline,
  matching `dispatch_test.sh`'s existing style.
