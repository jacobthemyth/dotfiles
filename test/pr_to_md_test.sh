#!/usr/bin/env bash
# Unit tests for local/bin/pr-to-md.

set -eo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dotfiles_root="$(cd "$script_dir/.." && pwd)"
pr_to_md="$dotfiles_root/local/bin/pr-to-md"
mdprint="$dotfiles_root/local/bin/mdprint"

fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

fake_bin="$fixture/bin"
work="$fixture/work"
mkdir -p "$fake_bin" "$work"

fail() {
  echo "FAIL: $1"
  shift
  for f in "$@"; do [ ! -f "$f" ] || cat "$f"; done
  exit 1
}

# gh that answers `pr view --json ...` and `pr diff` for one fixed PR.
cat > "$fake_bin/gh" <<'FAKE'
#!/usr/bin/env bash
set -eo pipefail
printf '%s\n' "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "pr view")
    cat <<'JSON'
{"title":"Retry foo with a longer timeout","author":{"login":"octocat"},"state":"OPEN","number":123,
 "url":"https://github.com/acme/widgets/pull/123",
 "body":"Bumps the timeout.\r\n\r\n- adds `retries`\r\n- documents it",
 "labels":[{"name":"bug"},{"name":"backend"}],"createdAt":"2026-10-01T10:00:00Z","updatedAt":"2026-10-02T11:00:00Z",
 "reviewDecision":"APPROVED","additions":5,"deletions":2,"changedFiles":4}
JSON
    ;;
  "pr diff")
    cat "$FAKE_GH_DIFF"
    ;;
  *)
    echo "fake gh: unexpected: $*" >&2
    exit 2
    ;;
esac
FAKE
chmod +x "$fake_bin/gh"

export FAKE_GH_LOG="$fixture/gh.log"
export FAKE_GH_DIFF="$fixture/pr.diff"

cat > "$FAKE_GH_DIFF" <<'DIFF'
diff --git a/src/index.ts b/src/index.ts
index 1234567..89abcde 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,4 +1,5 @@
 import { foo } from "./foo";
-const timeout = 1000;
+const timeout = 5000;
+const retries = 3;
 export {};
diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,6 @@
 # Widgets
+
+```ts
+foo(timeout, { retries });
+```
diff --git a/deploy/main.tf b/deploy/main.tf
index 3333333..4444444 100644
--- a/deploy/main.tf
+++ b/deploy/main.tf
@@ -1,2 +1,2 @@
-timeout = 1000
+timeout = 5000
diff --git a/LICENSE b/LICENSE
index 5555555..6666666 100644
--- a/LICENSE
+++ b/LICENSE
@@ -1 +1 @@
-Copyright 2025
+Copyright 2026
diff --git a/src/retry.ts b/src/retry.ts
new file mode 100644
index 0000000..7777777
--- /dev/null
+++ b/src/retry.ts
@@ -0,0 +1,3 @@
+export const retries = 3;
+
+export function backoff(n: number): number { return 2 ** n; }
\ No newline at end of file
diff --git a/old/legacy.js b/old/legacy.js
deleted file mode 100644
index 8888888..0000000
--- a/old/legacy.js
+++ /dev/null
@@ -1,2 +0,0 @@
-// legacy
-module.exports = {};
DIFF

echo "==> invalid arguments print usage"
usage_log="$fixture/usage.log"
if PATH="$fake_bin:$PATH" "$pr_to_md" > /dev/null 2> "$usage_log"; then
  fail "invocation without a PR unexpectedly succeeded"
fi
grep -Fq 'Usage: pr-to-md' "$usage_log" || fail "usage text is missing" "$usage_log"
if PATH="$fake_bin:$PATH" "$pr_to_md" 'https://example.com/not-a-pr' > /dev/null 2> "$usage_log"; then
  fail "a non-PR URL unexpectedly succeeded"
fi
echo "  PASS"

echo "==> a PR URL writes <repo>-<number>.md in the current directory"
output="$work/widgets-123.md"
(cd "$work" && PATH="$fake_bin:$PATH" "$pr_to_md" https://github.com/acme/widgets/pull/123 > /dev/null)
[ -f "$output" ] || fail "expected $output"
grep -Fq 'pr view https://github.com/acme/widgets/pull/123 --json' "$FAKE_GH_LOG" || fail "gh pr view was not called with the URL" "$FAKE_GH_LOG"
grep -Fqx 'pr diff https://github.com/acme/widgets/pull/123' "$FAKE_GH_LOG" || fail "gh pr diff was not called with the URL" "$FAKE_GH_LOG"
echo "  PASS"

echo "==> header carries the PR metadata and description"
grep -Fqx '# Retry foo with a longer timeout' "$output" || fail "title heading missing" "$output"
grep -Fq 'acme/widgets' "$output" || fail "repository missing" "$output"
grep -Fq '#123' "$output" || fail "PR number missing" "$output"
grep -Fq '@octocat' "$output" || fail "author missing" "$output"
grep -Fq 'APPROVED' "$output" || fail "review decision missing" "$output"
grep -Fq 'bug, backend' "$output" || fail "labels missing" "$output"
grep -Fqx 'Bumps the timeout.' "$output" || fail "description missing or still carries CR" "$output"
grep -Fqx -- '- documents it' "$output" || fail "description list missing" "$output"
if grep -q $'\r' "$output"; then fail "carriage returns leaked into the output" ; fi
echo "  PASS"

echo "==> the diff is split into one block per file with a language fence"
# Known extensions get {.lang .diff}; unknown or missing ones fall back to plain diff.
grep -Fqx '```{.ts .diff}' "$output" || fail "index.ts block is not fenced as ts+diff" "$output"
grep -Fqx '````{.md .diff}' "$output" || fail "README.md block (whose diff contains a fence) is not fenced as md+diff with a longer fence" "$output"
grep -Fqx '```{.hcl .diff}' "$output" || fail "main.tf block is not fenced as hcl+diff" "$output"
grep -Fqx '```diff' "$output" || fail "LICENSE block did not fall back to a plain diff fence" "$output"
[ "$(grep -c '^```' "$output")" -eq 12 ] || fail "expected 6 blocks (12 fence lines), got $(grep -c '^```' "$output")" "$output"
# Each block has a heading naming the file, so a long PR is navigable.
grep -Fqx '### src/index.ts' "$output" || fail "per-file heading missing" "$output"
grep -Fqx '### old/legacy.js' "$output" || fail "deleted-file heading missing" "$output"
# Line-scoped blocks keep every diff line, in order.
awk '/^```/{inside=!inside; next} inside' "$output" > "$fixture/inside.diff"
sed -n '1,/^diff --git a\/src\/retry.ts/p' "$FAKE_GH_DIFF" | sed '$d' > "$fixture/line-scoped.diff"
sed -n '1,/^export const retries/p' "$fixture/inside.diff" | sed '$d' > "$fixture/inside.line-scoped.diff"
diff -u "$fixture/line-scoped.diff" "$fixture/inside.line-scoped.diff" || fail "diff lines inside the line-scoped fences do not match gh pr diff"
echo "  PASS"

echo "==> a file added or deleted whole is emitted as plain source, not +/- lines"
grep -Fqx '```{.ts .diff-added}' "$output" || fail "added file is not fenced as ts+diff-added" "$output"
grep -Fqx '```{.js .diff-deleted}' "$output" || fail "deleted file is not fenced as js+diff-deleted" "$output"
grep -Fqx 'export const retries = 3;' "$output" || fail "added file content was not stripped of its + marker" "$output"
grep -Fqx 'module.exports = {};' "$output" || fail "deleted file content was not stripped of its - marker" "$output"
# The diff header and hunk lines are noise for a whole file; only its contents remain.
for noise in 'new file mode' 'deleted file mode' '+++ b/src/retry.ts' '--- a/old/legacy.js' '@@ -0,0 +1,3 @@' 'No newline at end of file'; do
  if grep -Fq -- "$noise" "$output"; then fail "whole-file block still carries: $noise" "$output"; fi
done
# The blank line inside the added file survives as an empty line, and the
# three-line file is exactly three lines.
awk '/^```\{\.ts \.diff-added\}$/{inside=1; next} /^```$/{inside=0} inside' "$output" > "$fixture/added.ts"
printf 'export const retries = 3;\n\nexport function backoff(n: number): number { return 2 ** n; }\n' > "$fixture/expected-added.ts"
diff -u "$fixture/expected-added.ts" "$fixture/added.ts" || fail "added file contents are not the file verbatim"
echo "  PASS"

echo "==> a diff containing a backtick fence uses a longer fence"
cp "$FAKE_GH_DIFF" "$fixture/full.diff"
cat > "$FAKE_GH_DIFF" <<'DIFF'
diff --git a/doc.md b/doc.md
--- a/doc.md
+++ b/doc.md
@@ -1 +1,4 @@
 # Doc
+````md
+```sh
+```
+````
DIFF
(cd "$work" && PATH="$fake_bin:$PATH" "$pr_to_md" https://github.com/acme/widgets/pull/123 > /dev/null)
grep -Fqx '`````{.md .diff}' "$output" || fail "fence was not lengthened past the longest run in the diff" "$output"
grep -Fqx '`````' "$output" || fail "closing fence was not lengthened" "$output"
echo "  PASS"

echo "==> an explicit output path is honored"
(cd "$work" && PATH="$fake_bin:$PATH" "$pr_to_md" https://github.com/acme/widgets/pull/123 "$fixture/custom name.md" > /dev/null)
[ -f "$fixture/custom name.md" ] || fail "explicit output path was not written"
echo "  PASS"

if command -v pandoc >/dev/null 2>&1 \
  && command -v typst >/dev/null 2>&1 \
  && command -v pdftotext >/dev/null 2>&1; then
  echo "==> the generated Markdown renders through mdprint"
  pdf="$fixture/rendered.pdf"
  txt="$fixture/rendered.txt"
  "$mdprint" "$fixture/custom name.md" "$pdf"
  pdftotext -layout "$pdf" "$txt"
  grep -Fq 'Retry foo with a longer timeout' "$txt" || fail "title missing from PDF" "$txt"
  grep -Fq '+```sh' "$txt" || fail "diff content missing from PDF" "$txt"
  (cd "$work" && FAKE_GH_DIFF="$fixture/full.diff" PATH="$fake_bin:$PATH" "$pr_to_md" https://github.com/acme/widgets/pull/123 "$fixture/full.md" > /dev/null)
  "$mdprint" "$fixture/full.md" "$pdf"
  pdftotext -layout "$pdf" "$txt"
  grep -Fq 'Added file' "$txt" || fail "added-file header missing from PDF" "$txt"
  grep -Fq 'Deleted file' "$txt" || fail "deleted-file header missing from PDF" "$txt"
  grep -Fq 'export const retries = 3;' "$txt" || fail "added file source missing from PDF" "$txt"
  echo "  PASS"
else
  echo "SKIP: real render requires pandoc, typst, and pdftotext"
fi

echo "pr-to-md test: OK"
