#!/usr/bin/env bash
# Unit tests for local/bin/git-cleanup.

set -eo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dotfiles_root="$(cd "$script_dir/.." && pwd)"

fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
# Resolve symlinks (macOS /var -> /private/var) so paths match what git prints.
fixture="$(cd "$fixture" && pwd -P)"

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export PATH="$dotfiles_root/local/bin:$PATH"

repo="$fixture/repo"
out="$fixture/out.txt"
err="$fixture/err.txt"

fail() {
  echo "FAIL: $1"
  [ ! -f "$out" ] || cat "$out"
  exit 1
}

# Build $repo with the branches and worktrees every test plans against.
mk_repo() {
  rm -rf "$repo" "$fixture/origin.git"
  git init -q -b main "$repo"
  git init -q --bare -b main "$fixture/origin.git"
  git -C "$repo" remote add origin "$fixture/origin.git"
  git -C "$repo" commit -q --allow-empty -m init
  git -C "$repo" push -q origin main
  git -C "$repo" remote set-head origin main
  echo .worktrees >> "$repo/.git/info/exclude"

  git -C "$repo" branch merged-ancestry
  git -C "$repo" branch merged-squash
  git -C "$repo" branch unmerged
  git -C "$repo" branch dirty-merged
  local b
  for b in merged-ancestry merged-squash dirty-merged; do
    git -C "$repo" worktree add -q "$repo/.worktrees/$b" "$b"
  done

  echo ancestry > "$repo/.worktrees/merged-ancestry/ancestry.txt"
  git -C "$repo/.worktrees/merged-ancestry" add ancestry.txt
  git -C "$repo/.worktrees/merged-ancestry" commit -q -m ancestry
  echo squash > "$repo/.worktrees/merged-squash/a.txt"
  git -C "$repo/.worktrees/merged-squash" add a.txt
  git -C "$repo/.worktrees/merged-squash" commit -q -m squash
  git -C "$repo" checkout -q unmerged
  echo unmerged > "$repo/unmerged.txt"
  git -C "$repo" add unmerged.txt
  git -C "$repo" commit -q -m unmerged
  git -C "$repo" checkout -q main
  echo dirty > "$repo/.worktrees/dirty-merged/dirty.txt"
  git -C "$repo/.worktrees/dirty-merged" add dirty.txt
  git -C "$repo/.worktrees/dirty-merged" commit -q -m dirty

  git -C "$repo" merge -q --no-ff -m "merge ancestry" merged-ancestry
  git -C "$repo" merge -q --no-ff -m "merge dirty" dirty-merged
  git -C "$repo" merge -q --squash merged-squash > /dev/null 2>&1
  git -C "$repo" commit -q -m "squash merged-squash"
  echo untracked > "$repo/.worktrees/dirty-merged/untracked.txt"

  # Branches with no commits of their own sit at main's tip.
  git -C "$repo" branch zero-ahead
  git -C "$repo" branch elsewhere
  git -C "$repo" branch gone-dir
  git -C "$repo" worktree add -q "$repo/.worktrees/zero-ahead" zero-ahead
  git -C "$repo" worktree add -q "$repo/.worktrees/elsewhere" elsewhere
  git -C "$repo" worktree add -q "$repo/.worktrees/gone-dir" gone-dir
  git -C "$repo" worktree add -q --detach "$repo/.worktrees/detached" main
  rm -rf "$repo/.worktrees/gone-dir"
}

# assert_line DISPOSITION BRANCH REASON-SUBSTRING
assert_line() {
  awk -F'\t' -v d="$1" -v b="$2" -v r="$3" \
    '$1 == d && $2 == b && index($4, r) { found = 1 } END { exit !found }' \
    "$out" || fail "expected '$1 $2' with reason containing '$3'"
}

assert_absent() {
  if awk -F'\t' -v b="$1" '$2 == b { found = 1 } END { exit !found }' "$out"; then
    fail "branch $1 should not be listed"
  fi
}

assert_branch() {
  git -C "$repo" show-ref --verify -q "refs/heads/$1" || fail "branch $1 should exist"
}

assert_no_branch() {
  if git -C "$repo" show-ref --verify -q "refs/heads/$1"; then
    fail "branch $1 should be gone"
  fi
}

assert_dir() {
  [ -d "$repo/.worktrees/$1" ] || fail "worktree dir $1 should exist"
}

assert_no_dir() {
  [ ! -e "$repo/.worktrees/$1" ] || fail "worktree dir $1 should be gone"
}

test_dry_run_plans_from_main() {
  mk_repo
  git -C "$repo" cleanup > "$out"

  [ "$(sed -n 1p "$out")" = "repo: $repo  default: main" ] || fail "header line 1"
  [ "$(sed -n 2p "$out")" = "gh not available: PR state unknown" ] || fail "header line 2"
  assert_line delete merged-ancestry "ancestry-merged"
  assert_line delete merged-squash "squash-merged"
  assert_line delete zero-ahead "zero commits ahead"
  assert_line delete elsewhere "zero commits ahead"
  assert_line skip unmerged "unmerged work"
  assert_line skip dirty-merged "dirty, 1 file"
  assert_absent main
  if grep -q detached "$out"; then fail "detached worktree should not be listed"; fi
  grep -Fq "Removing worktrees/gone-dir" "$out" || fail "missing prune dry-run output"

  local b
  for b in merged-ancestry merged-squash zero-ahead elsewhere unmerged dirty-merged gone-dir; do
    assert_branch "$b"
  done
  for b in merged-ancestry merged-squash zero-ahead elsewhere dirty-merged detached; do
    assert_dir "$b"
  done
}

test_dry_run_skips_current_and_main_checkout() {
  mk_repo
  git -C "$repo" checkout -q -b main-feature
  git -C "$repo/.worktrees/zero-ahead" cleanup > "$out"

  assert_line skip zero-ahead "current"
  assert_line skip main-feature "checked out in $repo"
  assert_line delete merged-ancestry "ancestry-merged"
  git -C "$repo" checkout -q main
}

test_yes_executes_plan() {
  mk_repo
  git -C "$repo" cleanup --yes > "$out" || fail "cleanup --yes exited non-zero"

  local b
  for b in merged-ancestry merged-squash zero-ahead elsewhere; do
    assert_no_branch "$b"
    assert_no_dir "$b"
  done
  assert_branch unmerged
  assert_branch dirty-merged
  assert_dir dirty-merged
  [ -f "$repo/.worktrees/dirty-merged/untracked.txt" ] || fail "dirty worktree lost its file"
  if git -C "$repo" worktree list | grep -q gone-dir; then
    fail "gone-dir worktree should be pruned"
  fi
  assert_no_branch gone-dir
}

test_usage_error() {
  mk_repo
  local status=0
  git -C "$repo" cleanup --bogus > "$out" 2> "$err" || status=$?
  [ "$status" -eq 2 ] || fail "expected exit 2, got $status"
  grep -Fq "usage:" "$err" || fail "usage text missing on stderr"
}

test_old_scripts_removed() {
  ! [ -e "$dotfiles_root/local/bin/git-delete-squashed" ] || fail "git-delete-squashed should be removed"
  ! [ -e "$dotfiles_root/local/bin/git-list-squashed" ] || fail "git-list-squashed should be removed"
}

for t in test_dry_run_plans_from_main \
  test_dry_run_skips_current_and_main_checkout \
  test_yes_executes_plan \
  test_usage_error \
  test_old_scripts_removed; do
  echo "==> $t"
  "$t"
  echo "  PASS"
done

echo "git-cleanup test: OK"
