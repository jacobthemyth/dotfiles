#!/usr/bin/env bash
# Unit tests for local/bin/mdprint.

set -eo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dotfiles_root="$(cd "$script_dir/.." && pwd)"
mdprint="$dotfiles_root/local/bin/mdprint"

fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

fake_bin="$fixture/bin"
notes_dir="$fixture/notes with spaces"
mkdir -p "$fake_bin" "$notes_dir"

cat > "$fake_bin/typst" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$fake_bin/pandoc" <<'EOF'
#!/usr/bin/env bash
set -eo pipefail

if [ -n "${MDPRINT_CAPTURE:-}" ]; then
  printf 'cwd=%s\n' "$PWD" > "$MDPRINT_CAPTURE"
  printf 'arg=%s\n' "$@" >> "$MDPRINT_CAPTURE"
fi

if [ -n "${MDPRINT_INPUT_CAPTURE:-}" ]; then
  if [ "$1" = "-" ]; then
    cat > "$MDPRINT_INPUT_CAPTURE"
  else
    cp "$1" "$MDPRINT_INPUT_CAPTURE"
  fi
fi

output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      output="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

[ -n "$output" ] || { echo "fake pandoc: missing -o" >&2; exit 2; }
printf 'fake pdf\n' > "$output"
EOF

chmod +x "$fake_bin/typst" "$fake_bin/pandoc"

echo "==> invalid arguments print usage"
usage_log="$fixture/usage.log"
if PATH="$fake_bin:$PATH" "$mdprint" > /dev/null 2> "$usage_log"; then
  echo "FAIL: invocation without an input unexpectedly succeeded"
  exit 1
fi
grep -Fqx 'Usage: mdprint INPUT.md [OUTPUT.pdf]' "$usage_log" || {
  echo "FAIL: usage text is missing or unclear"
  cat "$usage_log"
  exit 1
}
echo "  PASS"

echo "==> input-only invocation writes a sibling PDF"
input="$notes_dir/meeting notes.md"
output="$notes_dir/meeting notes.pdf"
printf '# Meeting notes\n' > "$input"

PATH="$fake_bin:$PATH" "$mdprint" "$input"

if [ ! -f "$output" ]; then
  echo "FAIL: expected $output"
  exit 1
fi
echo "  PASS"

echo "==> invocation uses absolute profile paths and the input resource directory"
capture="$fixture/pandoc.args"
explicit_output="$fixture/rendered result.pdf"
caller_dir="$(pwd -P)"

MDPRINT_CAPTURE="$capture" PATH="$fake_bin:$PATH" \
  "$mdprint" "$input" "$explicit_output"

if [ ! -f "$explicit_output" ]; then
  echo "FAIL: expected $explicit_output"
  exit 1
fi

expected_support="$dotfiles_root/local/share/mdprint"
expected_resource="$(cd "$notes_dir" && pwd -P)"
grep -Fqx "cwd=$caller_dir" "$capture" || {
  echo "FAIL: mdprint changed Pandoc's working directory"
  exit 1
}
grep -Fqx "arg=--defaults=$expected_support/print.yaml" "$capture" || {
  echo "FAIL: mdprint did not load print.yaml"
  exit 1
}
grep -Fqx "arg=--lua-filter=$expected_support/responsive-tables.lua" "$capture" || {
  echo "FAIL: mdprint did not load the responsive-table filter"
  exit 1
}
grep -Fqx "arg=--lua-filter=$expected_support/diff-blocks.lua" "$capture" || {
  echo "FAIL: mdprint did not load the diff-blocks filter"
  exit 1
}
grep -Fqx "arg=--include-in-header=$expected_support/print.typ" "$capture" || {
  echo "FAIL: mdprint did not load the Typst header"
  exit 1
}
grep -Fqx "arg=--include-before-body=$expected_support/print-body.typ" "$capture" || {
  echo "FAIL: mdprint did not load the Typst body setup"
  exit 1
}
grep -Fqx "arg=--resource-path=$expected_resource" "$capture" || {
  echo "FAIL: mdprint did not use the input directory as the resource path"
  exit 1
}
echo "  PASS"

echo "==> leading frontmatter renders as a property table"
frontmatter_input="$notes_dir/frontmatter.md"
frontmatter_output="$fixture/frontmatter.pdf"
frontmatter_capture="$fixture/frontmatter.rendered.md"
frontmatter_expected="$fixture/frontmatter.expected.md"

cat > "$frontmatter_input" <<'EOF'
---
name: fifty-centify
description: Use when editing prose: keep this | that
---
# Body

Before

---

After
EOF

cat > "$frontmatter_expected" <<'EOF'
| Property | Value |
| --- | --- |
| name | fifty-centify |
| description | Use when editing prose: keep this \| that |

# Body

Before

---

After
EOF

MDPRINT_INPUT_CAPTURE="$frontmatter_capture" PATH="$fake_bin:$PATH" \
  "$mdprint" "$frontmatter_input" "$frontmatter_output"

if ! diff -u "$frontmatter_expected" "$frontmatter_capture"; then
  echo "FAIL: leading frontmatter was not converted to a property table"
  exit 1
fi
echo "  PASS"

echo "==> missing input reports a clear error"
missing_log="$fixture/missing.log"
if PATH="$fake_bin:$PATH" "$mdprint" "$notes_dir/not here.md" > /dev/null 2> "$missing_log"; then
  echo "FAIL: missing input unexpectedly succeeded"
  exit 1
fi
grep -Fq 'mdprint: input file not found:' "$missing_log" || {
  echo "FAIL: missing-input error was unclear"
  cat "$missing_log"
  exit 1
}
echo "  PASS"

if command -v pandoc >/dev/null 2>&1 \
  && command -v typst >/dev/null 2>&1 \
  && command -v pdftotext >/dev/null 2>&1 \
  && command -v pdfinfo >/dev/null 2>&1; then
  echo "==> unresolved internal links warn instead of failing the render"
  broken_anchor_input="$fixture/broken-anchor.md"
  broken_anchor_output="$fixture/broken-anchor.pdf"
  broken_anchor_text="$fixture/broken-anchor.txt"
  broken_anchor_log="$fixture/broken-anchor.log"

  cat > "$broken_anchor_input" <<'EOF'
# Anchor fixture

Jump to [section 2](#a-heading-that-does-not-exist).

## 2. Control census
EOF

  if ! "$mdprint" "$broken_anchor_input" "$broken_anchor_output" \
    2> "$broken_anchor_log"; then
    echo "FAIL: an unresolved internal link prevented PDF rendering"
    cat "$broken_anchor_log"
    exit 1
  fi
  pdftotext -layout "$broken_anchor_output" "$broken_anchor_text"
  grep -Fq 'Jump to section 2.' "$broken_anchor_text" || {
    echo "FAIL: unresolved-link text is missing from the rendered PDF"
    exit 1
  }
  grep -Fq \
    'mdprint: warning: unresolved internal link #a-heading-that-does-not-exist; rendering its text without a hyperlink' \
    "$broken_anchor_log" || {
    echo "FAIL: unresolved internal link did not produce a clear warning"
    cat "$broken_anchor_log"
    exit 1
  }
  echo "  PASS"

  echo "==> diff-blocks filter scopes a diff-line show rule around language-fenced blocks"
  diff_input="$fixture/diff-blocks.md"
  diff_typst="$fixture/diff-blocks.typ"
  cat > "$diff_input" <<'EOF'
Plain language block:

```ts
const a = 1;
```

Plain diff block:

```diff
-old
+new
```

Combined block:

```{.ts .diff}
@@ -1 +1 @@
-const timeout = 1000;
+const timeout = 5000;
```

Combined block whose body contains a fence:

```{.md .diff}
+```sh
+echo hi
+```
```

Whole-file blocks:

```{.ts .diff-added}
export const added = true;
```

```{.diff-deleted}
plain text, no language
```
EOF
  pandoc "$diff_input" -t typst \
    --lua-filter="$dotfiles_root/local/share/mdprint/diff-blocks.lua" > "$diff_typst"
  [ "$(grep -c '#show raw.line: diff-line' "$diff_typst")" -eq 2 ] || {
    echo "FAIL: expected exactly the two combined blocks to get the diff-line show rule"
    cat "$diff_typst"
    exit 1
  }
  if ! grep -Fq 'const a = 1;' "$diff_typst" || grep -B2 -F 'const a = 1;' "$diff_typst" | grep -Fq 'diff-line'; then
    echo "FAIL: the plain ts block was altered"
    cat "$diff_typst"
    exit 1
  fi
  grep -Fqx '```ts' "$diff_typst" || {
    echo "FAIL: combined block is not fenced with its language for Typst"
    cat "$diff_typst"
    exit 1
  }
  grep -Fqx '````md' "$diff_typst" || {
    echo "FAIL: combined block containing a fence was not given a longer fence"
    cat "$diff_typst"
    exit 1
  }
  grep -Fqx '#diff-file("added")[' "$diff_typst" || {
    echo "FAIL: a diff-added block did not get the added-file wrapper"
    cat "$diff_typst"
    exit 1
  }
  grep -A1 -Fx '#diff-file("added")[' "$diff_typst" | grep -Fqx '```ts' || {
    echo "FAIL: a diff-added block lost its language fence"
    cat "$diff_typst"
    exit 1
  }
  grep -A1 -Fx '#diff-file("deleted")[' "$diff_typst" | grep -Fqx '```' || {
    echo "FAIL: a diff-deleted block without a language did not get a bare fence"
    cat "$diff_typst"
    exit 1
  }
  echo "  PASS"

  echo "==> real render of a combined diff block keeps every line"
  diff_output="$fixture/diff-blocks.pdf"
  diff_text="$fixture/diff-blocks.txt"
  diff_log="$fixture/diff-blocks.log"
  "$mdprint" "$diff_input" "$diff_output" 2> "$diff_log" || {
    echo "FAIL: a combined diff block broke the render"
    cat "$diff_log"
    exit 1
  }
  pdftotext -layout "$diff_output" "$diff_text"
  for needle in '@@ -1 +1 @@' '-const timeout = 1000;' '+const timeout = 5000;' '+echo hi' '-old' 'const a = 1;' \
    'Added file' 'export const added = true;' 'Deleted file' 'plain text, no language'; do
    grep -Fq -- "$needle" "$diff_text" || {
      echo "FAIL: rendered PDF is missing: $needle"
      cat "$diff_text"
      exit 1
    }
  done
  echo "  PASS"

  echo "==> a whole-file block longer than a page breaks across pages instead of clipping"
  long_input="$fixture/long-added.md"
  long_output="$fixture/long-added.pdf"
  long_text="$fixture/long-added.txt"
  {
    printf '# Long added file\n\n### src/long.ts\n\n```{.ts .diff-added}\n'
    line_number=1
    while [ "$line_number" -le 150 ]; do
      printf 'export const line%d = %d;\n' "$line_number" "$line_number"
      line_number=$((line_number + 1))
    done
    printf 'export const LAST_LINE_MARKER = true;\n```\n'
  } > "$long_input"
  "$mdprint" "$long_input" "$long_output"
  pdftotext -layout "$long_output" "$long_text"
  grep -Fq 'LAST_LINE_MARKER' "$long_text" || {
    echo "FAIL: the end of a long whole-file block was clipped off the page"
    exit 1
  }
  [ "$(pdfinfo "$long_output" | awk '/^Pages:/{print $2}')" -ge 2 ] || {
    echo "FAIL: a 150-line file should span at least two pages"
    exit 1
  }
  # The heading must share a page with the start of the file, not sit alone.
  first_page="$(pdftotext -layout -f 1 -l 1 "$long_output" -)"
  printf '%s' "$first_page" | grep -Fq 'src/long.ts' || {
    echo "FAIL: file heading is missing from page 1"
    exit 1
  }
  printf '%s' "$first_page" | grep -Fq 'export const line1 = 1;' || {
    echo "FAIL: the file heading was orphaned on a page without the file"
    exit 1
  }
  echo "  PASS"


  render_input="$fixture/responsive.md"
  render_image="$fixture/wide-image.svg"
  render_output="$fixture/responsive.pdf"
  render_text="$fixture/responsive.txt"

  cat > "$render_image" <<'EOF'
<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="300" viewBox="0 0 1800 300">
  <rect width="1800" height="300" fill="#edf3f7"/>
  <text x="900" y="175" text-anchor="middle" font-size="72">wide image</text>
</svg>
EOF

  cat > "$render_input" <<'EOF'
# Print fixture

This includes inline math, $x^2 + y^2 = z^2$, to keep occasional formulas working.

| Environment | Region | State |
|---|---|---|
| Production | us-east-1 | Healthy |

| Issue | Subject | Status | Owner | Impact | Evidence | Action | Due |
|---|---|---|---|---|---|---|---|
| PLA-4302 | Certificate rotation | Investigating | Platform | Deploys can fail | Expiry alert fired | Rotate certificate and verify consumers | Friday |

| Key | Value |
|---|---|
| Forced | This compact table is intentionally stacked |

: {.stack-table}

------- -------
12      12
123     123
------- -------

: {.stack-table}

![An oversized image that must fit the page](wide-image.svg)
EOF

  long_cell=""
  word_number=1
  while [ "$word_number" -le 800 ]; do
    long_cell="$long_cell word$word_number"
    word_number=$((word_number + 1))
  done
  {
    printf '\n| Record | Detail | C3 | C4 | C5 | C6 | C7 | C8 |\n'
    printf '|---|---|---|---|---|---|---|---|\n'
    printf '| Long |%s | x | x | x | x | x | x |\n' "$long_cell"
  } >> "$render_input"

  long_token=""
  character_number=1
  while [ "$character_number" -le 200 ]; do
    long_token="${long_token}W"
    character_number=$((character_number + 1))
  done
  {
    printf '\n| Key | Value |\n'
    printf '|---|---|\n'
    printf '| Token | %sTOKEN_TAIL_MARKER |\n' "$long_token"
    printf '| Code | %s%s%s |\n' '`' "${long_token}CODE_TAIL_MARKER" '`'
  } >> "$render_input"

  "$mdprint" "$render_input" "$render_output"
  pdftotext -layout "$render_output" "$render_text"

  grep -Fq 'Production' "$render_text" || {
    echo "FAIL: compact table content is missing"
    exit 1
  }
  grep -Fq 'Issue: PLA-4302' "$render_text" || {
    echo "FAIL: wide table was not rendered as labeled records"
    exit 1
  }
  grep -Fq 'Subject: Certificate rotation' "$render_text" || {
    echo "FAIL: stacked table labels or values are missing"
    exit 1
  }
  grep -Fq 'Key: Forced' "$render_text" || {
    echo "FAIL: stack-table did not force the vertical layout"
    exit 1
  }
  grep -Fq 'Column 1: 12' "$render_text" || {
    echo "FAIL: a headerless stack-table did not get synthetic labels"
    exit 1
  }
  grep -Fq 'word800' "$render_text" || {
    echo "FAIL: a long stacked-table record was clipped"
    exit 1
  }
  grep -Fq 'TOKEN_TAIL_MARKER' "$render_text" || {
    echo "FAIL: an unbroken table token was clipped"
    exit 1
  }
  grep -Fq 'CODE_TAIL_MARKER' "$render_text" || {
    echo "FAIL: an unbroken code token was clipped"
    exit 1
  }
  echo "  PASS"
else
  echo "SKIP: real render requires pandoc, typst, pdftotext, and pdfinfo"
fi

echo "mdprint test: OK"
