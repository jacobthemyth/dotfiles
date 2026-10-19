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
# fake_bin goes first on PATH for every test; no_gh/use_gh decide which gh it holds,
# so a real gh on the machine never leaks into a test.
fake_bin="$fixture/fake_bin"
mkdir -p "$fake_bin"
export PATH="$fake_bin:$dotfiles_root/local/bin:$PATH"
export FAKE_GH_QUERY_LOG="$fixture/query.log"
export FAKE_GH_REPO="$fixture/repo"

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

  # One commit each, not merged: only PR state can say what became of them.
  for b in pr-merged pr-closed pr-open; do
    git -C "$repo" worktree add -q -b "$b" "$repo/.worktrees/$b" main
    echo "$b" > "$repo/.worktrees/$b/$b.txt"
    git -C "$repo/.worktrees/$b" add "$b.txt"
    git -C "$repo/.worktrees/$b" commit -q -m "$b"
  done
  # Awkward name for the JSON escaping check, plus enough branches to force two batches.
  git -C "$repo" branch 'weird/na.me-"q"'
  local n
  for n in $(seq 0 54); do
    git -C "$repo" branch "bulk-$n"
  done
}

# gh that is installed but cannot authenticate, standing in for "no gh".
no_gh() {
  printf '#!/bin/sh\nexit 1\n' > "$fake_bin/gh"
  chmod +x "$fake_bin/gh"
}

# gh that answers `auth status` and a batched pullRequests GraphQL query. The PR
# table is FAKE_GH_PRS="branch=STATE:number[:oid] ..."; unlisted branches have no
# PR, and a missing oid means the branch's current local tip.
use_gh() {
  cat > "$fake_bin/gh" <<'FAKE'
#!/usr/bin/env bash
case "$1 $2" in
  "auth status") exit "${FAKE_GH_AUTH_EXIT:-0}" ;;
  "api graphql") ;;
  *) exit 1 ;;
esac
[ "${FAKE_GH_FAIL:-0}" != 1 ] || exit 1
q=""
for a in "$@"; do
  case "$a" in query=*) q="${a#query=}" ;; esac
done
printf '%s\n' "$q" >> "$FAKE_GH_QUERY_LOG"
resp='{"data":{"repository":{'
sep=""
while IFS= read -r m; do
  alias="${m%%:*}"
  name="$(printf '%s' "${m#*headRefName: }" | jq -r .)"
  nodes="[]"
  for w in $FAKE_GH_PRS; do
    if [ "${w%%=*}" = "$name" ]; then
      rest="${w#*=}"
      num="${rest#*:}"
      oid=""
      case "$num" in *:*) oid="${num#*:}"; num="${num%%:*}" ;; esac
      [ -n "$oid" ] || oid="$(git -C "$FAKE_GH_REPO" rev-parse "refs/heads/$name")"
      nodes="[{\"number\":$num,\"state\":\"${rest%%:*}\",\"headRefOid\":\"$oid\"}]"
    fi
  done
  resp="$resp$sep\"$alias\":{\"nodes\":$nodes}"
  sep=","
done < <(printf '%s' "$q" | grep -oE 'b[0-9]+: pullRequests\(headRefName: "([^"\\]|\\.)*"')
printf '%s\n' "$resp}}}"
FAKE
  chmod +x "$fake_bin/gh"
}

# mk_repo with an origin that looks like GitHub: the configured URL is the GitHub
# one (what origin_slug reads) and insteadOf sends fetches and pushes to the bare repo.
mk_gh_repo() {
  mk_repo
  git -C "$repo" remote set-url origin git@github.com:acme/repo.git
  git -C "$repo" config "url.$fixture/origin.git.insteadOf" git@github.com:acme/repo.git
  use_gh
  rm -f "$FAKE_GH_QUERY_LOG"
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

export_prs="pr-merged=MERGED:11 pr-closed=CLOSED:12 pr-open=OPEN:13"

test_gh_header_when_available() {
  mk_gh_repo
  git -C "$repo" cleanup > "$out"
  [ "$(sed -n 2p "$out")" = "gh: acme/repo" ] || fail "header line 2"
}

test_gh_states() {
  mk_gh_repo
  FAKE_GH_PRS="$export_prs" git -C "$repo" cleanup > "$out"
  assert_line delete pr-merged "PR #11 merged"
  assert_line worktree pr-closed "closed PR #12, branch kept"
  assert_line skip pr-open "open PR #13"
  assert_line delete zero-ahead "zero commits ahead"
  assert_line skip dirty-merged "dirty"
}

test_gh_closed_flag() {
  mk_gh_repo
  FAKE_GH_PRS="$export_prs" git -C "$repo" cleanup --closed > "$out"
  assert_line delete pr-closed "closed PR #12"
}

test_gh_closed_without_worktree_is_skipped() {
  mk_gh_repo
  git -C "$repo" worktree remove "$repo/.worktrees/pr-closed"
  FAKE_GH_PRS="$export_prs" git -C "$repo" cleanup > "$out"
  assert_line skip pr-closed "closed PR #12, branch kept"
}

test_gh_yes_closed_keeps_branch() {
  mk_gh_repo
  FAKE_GH_PRS="$export_prs" git -C "$repo" cleanup --yes > "$out" || fail "cleanup --yes exited non-zero"
  assert_no_dir pr-closed
  assert_branch pr-closed
  assert_no_branch pr-merged
  assert_branch pr-open
  assert_dir pr-open
}

test_gh_escapes_and_batches() {
  mk_gh_repo
  FAKE_GH_PRS="$export_prs weird/na.me-\"q\"=OPEN:14" git -C "$repo" cleanup > "$out"
  [ "$(wc -l < "$FAKE_GH_QUERY_LOG" | tr -d ' ')" -eq 2 ] || fail "expected two GraphQL requests"
  local first second
  first="$(sed -n 1p "$FAKE_GH_QUERY_LOG")"
  second="$(sed -n 2p "$FAKE_GH_QUERY_LOG")"
  case "$first" in *'b0: '*'b49: '*) ;; *) fail "first request should hold b0..b49" ;; esac
  case "$first" in *'b50: '*) fail "first request has more than 50 aliases" ;; esac
  case "$second" in *'b0: '*'b15: '*) ;; *) fail "second request should restart at b0" ;; esac
  case "$second" in *'b16: '*) fail "second request has too many aliases" ;; esac
  grep -Fq '\"q\"' "$FAKE_GH_QUERY_LOG" || fail "quotes in branch name not escaped"
  assert_line skip 'weird/na.me-"q"' "open PR #14"
  assert_line delete pr-merged "PR #11 merged"
  assert_line skip pr-open "open PR #13"
}

# Add <branch> with one commit per remaining argument (worktree under .worktrees).
add_commits() {
  local b="$1" c
  shift
  git -C "$repo" worktree add -q -b "$b" "$repo/.worktrees/$b" main
  for c in "$@"; do
    echo "$c" > "$repo/.worktrees/$b/$c.txt"
    git -C "$repo/.worktrees/$b" add "$c.txt"
    git -C "$repo/.worktrees/$b" commit -q -m "$c"
  done
}

test_gh_merged_reused_branch_is_kept() {
  mk_gh_repo
  add_commits pr-reused first second
  local first
  first="$(git -C "$repo" rev-parse pr-reused~1)"
  FAKE_GH_PRS="pr-reused=MERGED:21:$first" git -C "$repo" cleanup > "$out"
  assert_line skip pr-reused "unmerged work"
  FAKE_GH_PRS="pr-reused=MERGED:21:$first" git -C "$repo" cleanup --yes > "$out" || fail "cleanup --yes exited non-zero"
  assert_branch pr-reused
  assert_dir pr-reused
}

test_gh_closed_reused_branch_is_kept() {
  mk_gh_repo
  add_commits pr-closed-reused first second
  local first
  first="$(git -C "$repo" rev-parse pr-closed-reused~1)"
  FAKE_GH_PRS="pr-closed-reused=CLOSED:25:$first" git -C "$repo" cleanup --closed --yes > "$out" || fail "cleanup --yes exited non-zero"
  assert_line skip pr-closed-reused "unmerged work"
  assert_branch pr-closed-reused
  assert_dir pr-closed-reused
}

test_gh_merged_behind_head_is_deleted() {
  mk_gh_repo
  add_commits pr-behind first
  local first second
  first="$(git -C "$repo" rev-parse pr-behind)"
  second="$(git -C "$repo" commit-tree "$first^{tree}" -p "$first" -m second)"
  FAKE_GH_PRS="pr-behind=MERGED:22:$second" git -C "$repo" cleanup > "$out"
  assert_line delete pr-behind "PR #22 merged"
}

test_gh_merged_behind_head_fetches_and_deletes() {
  mk_gh_repo
  add_commits pr-behind2 first
  local a b
  a="$(git -C "$repo" rev-parse pr-behind2)"
  b="$(git -C "$repo" commit-tree "$a^{tree}" -p "$a" -m second)"
  git -C "$repo" push -q origin "$b:refs/pull/24/head"
  git -C "$repo" prune --expire=now
  ! git -C "$repo" cat-file -e "$b^{commit}" 2> /dev/null || fail "head commit should not be a local object"
  FAKE_GH_PRS="pr-behind2=MERGED:24:$b" git -C "$repo" cleanup > "$out"
  assert_line delete pr-behind2 "PR #24 merged"
  [ -z "$(git -C "$repo" for-each-ref refs/pull)" ] || fail "fetch must not create refs/pull refs"
}

test_gh_merged_unknown_oid_falls_through() {
  mk_gh_repo
  add_commits pr-unknown first
  FAKE_GH_PRS="pr-unknown=MERGED:23:0123456789abcdef0123456789abcdef01234567" git -C "$repo" cleanup > "$out"
  assert_line skip pr-unknown "unmerged work"
  [ -z "$(git -C "$repo" for-each-ref refs/pull)" ] || fail "no refs/pull refs expected"
}

test_gh_api_failure_falls_back() {
  mk_gh_repo
  FAKE_GH_FAIL=1 git -C "$repo" cleanup > "$out" || fail "should exit 0 when the gh query fails"
  [ "$(sed -n 2p "$out")" = "gh query failed: PR state unknown" ] || fail "header line 2"
  assert_line delete merged-ancestry "ancestry-merged"
}

test_gh_unauthenticated_falls_back() {
  mk_gh_repo
  FAKE_GH_AUTH_EXIT=1 git -C "$repo" cleanup > "$out" || fail "should exit 0 when gh is unauthenticated"
  [ "$(sed -n 2p "$out")" = "gh not available: PR state unknown" ] || fail "header line 2"
  assert_line delete merged-ancestry "ancestry-merged"
}

run_tests() {
  local t
  for t in "$@"; do
    echo "==> $t"
    no_gh
    "$t"
    echo "  PASS"
  done
}

test_dirty_ignores_user_config() {
  mk_repo
  git -C "$repo" config status.showUntrackedFiles no
  git -C "$repo" cleanup > "$out"
  git -C "$repo" config --unset status.showUntrackedFiles
  assert_line skip dirty-merged "dirty, 1 file"
}

test_default_branch_unresolvable_exits_2() {
  local scratch="$fixture/scratch" status=0
  rm -rf "$scratch"
  git init -q -b trunk "$scratch"
  git -C "$scratch" commit -q --allow-empty -m init
  git -C "$scratch" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master
  git -C "$scratch" cleanup > "$out" 2> "$err" || status=$?
  [ "$status" -eq 2 ] || fail "expected exit 2, got $status"
  grep -Fq "git cleanup: cannot determine the default branch (set origin/HEAD or init.defaultBranch)" "$err" ||
    fail "default branch message missing"
  if grep -q trunk "$out"; then fail "nothing should be planned"; fi
}

test_default_branch_dangling_origin_head_uses_main() {
  mk_repo
  git -C "$repo" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master
  git -C "$repo" cleanup > "$out"
  [ "$(sed -n 1p "$out")" = "repo: $repo  default: main" ] || fail "header should name main"
}

test_locked_worktree_is_skipped() {
  mk_repo
  git -C "$repo" worktree lock "$repo/.worktrees/merged-ancestry"
  git -C "$repo" cleanup > "$out"
  assert_line skip merged-ancestry "locked"
  git -C "$repo" cleanup --yes > "$out" || fail "cleanup --yes exited non-zero"
  assert_branch merged-ancestry
  assert_dir merged-ancestry
  assert_no_branch zero-ahead
}

test_yes_continues_past_failure_and_exits_1() {
  mk_repo
  # aaa-fail sorts before zzz-ok; its worktree sits in a read-only directory so
  # removal fails.
  mkdir "$fixture/ro"
  git -C "$repo" worktree add -q -b aaa-fail "$fixture/ro/aaa-fail" main
  git -C "$repo" worktree add -q -b zzz-ok "$repo/.worktrees/zzz-ok" main
  chmod 555 "$fixture/ro"
  local status=0
  git -C "$repo" cleanup --yes > "$out" 2>&1 || status=$?
  chmod 755 "$fixture/ro"
  [ "$status" -eq 1 ] || fail "expected exit 1, got $status"
  assert_branch aaa-fail
  assert_no_branch zzz-ok
  assert_no_dir zzz-ok
  assert_no_branch merged-ancestry
}

# chmod 000 on the worktree makes git worktree prune treat it as gone, so the
# failure is forced with a corrupt index instead.
test_unreadable_worktree_is_skipped() {
  mk_repo
  echo garbage > "$repo/.git/worktrees/merged-ancestry/index"
  ! git -C "$repo/.worktrees/merged-ancestry" status > /dev/null 2>&1 || fail "status should fail on a corrupt index"
  git -C "$repo" cleanup > "$out"
  assert_line skip merged-ancestry "status failed"
  git -C "$repo" cleanup --yes > "$out" || fail "cleanup --yes exited non-zero"
  assert_branch merged-ancestry
  assert_dir merged-ancestry
}

test_help() {
  mk_repo
  (cd "$repo" && git-cleanup --help) > "$out"
  local n
  n="$(wc -l < "$out" | tr -d ' ')"
  [ "$n" -ge 4 ] && [ "$n" -le 6 ] || fail "help should be 4-6 lines, got $n"
  grep -Fq -- "--closed" "$out" || fail "help should mention --closed"
}

run_tests test_dry_run_plans_from_main \
  test_dry_run_skips_current_and_main_checkout \
  test_dirty_ignores_user_config \
  test_default_branch_unresolvable_exits_2 \
  test_default_branch_dangling_origin_head_uses_main \
  test_locked_worktree_is_skipped \
  test_yes_continues_past_failure_and_exits_1 \
  test_unreadable_worktree_is_skipped \
  test_help \
  test_yes_executes_plan \
  test_usage_error \
  test_old_scripts_removed

if command -v jq > /dev/null; then
  run_tests test_gh_header_when_available \
    test_gh_states \
    test_gh_closed_flag \
    test_gh_closed_without_worktree_is_skipped \
    test_gh_yes_closed_keeps_branch \
    test_gh_escapes_and_batches \
    test_gh_merged_reused_branch_is_kept \
    test_gh_closed_reused_branch_is_kept \
    test_gh_merged_behind_head_is_deleted \
    test_gh_merged_behind_head_fetches_and_deletes \
    test_gh_merged_unknown_oid_falls_through \
    test_gh_api_failure_falls_back \
    test_gh_unauthenticated_falls_back
else
  echo "SKIP: jq not installed, gh tests not run"
fi

echo "git-cleanup test: OK"
