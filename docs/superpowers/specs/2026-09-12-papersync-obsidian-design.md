# papersync Obsidian integration — Design Spec

**Status:** Draft
**Date:** 2026-09-12
**Owner:** jacob@smithjs.org
**Extends:** `2026-09-07-papersync-design.md`

## Goal

Add a second source to papersync that prints Obsidian notes as paper documents.
The selector accepts arbitrary Obsidian queries. Each note becomes one PDF in an
output directory, so a duplex printer starts every document on a fresh sheet and
puts continuation pages on the backs.

Obsidian renders the page body with its own renderer, through a small companion
plugin. papersync draws the machine-readable chrome onto the finished PDF with
pymupdf. This split gives exact mark geometry and full Obsidian fidelity at the
same time.

This spec covers export and print only. The scan and apply path for Obsidian is
a later project. The export writes everything that a later importer needs.

## Non-goals

- An importer. `ObsidianSink.apply` and `verify` raise `NotImplementedError`.
- Scannable inline task checkboxes. A `- [ ]` in the body prints as an inert
  glyph. Only the labelled meta boxes at the page foot are scannable.
- A primary done box. An Obsidian note is a document, not a task.
- Print spooling. papersync writes files. The user prints them.
- Index card sizes for documents. Documents print on letter.
- Moving the Things card renderer off Typst.

## Terms

- Document: one printed PDF for one Obsidian note, of one or more pages.
- Bridge: the companion Obsidian plugin that papersync installs into the vault.
- Chrome: the fiducials, QR code, title bar, footer and meta boxes that
  papersync stamps onto a rendered PDF.
- Spec file: the JSON request that papersync writes for one bridge call.

## Why a bridge plugin

Three routes to an Obsidian-rendered PDF were tested against a live vault on
2026-09-12.

`obsidian dev:cdp method=Page.printToPDF` fails. Electron does not expose the
`Page` domain to the renderer-attached debugger. The command returns
`'Page.printToPDF' wasn't found`.

`obsidian eval` reaches `require("electron").remote`. A call to
`remote.getCurrentWebContents().printToPDF({pageSize:"Letter"})` wrote a real
PDF. `remote.BrowserWindow` is constructible from the same scope. So the
Electron print path works.

`require("obsidian")` fails from `eval` scope with `Cannot find module
'obsidian'`. Obsidian injects that module only into plugin sandboxes. Therefore
`MarkdownRenderer` and `Component` are not reachable from `eval` alone, and a
plugin is necessary.

The installed `print` community plugin confirms the working pattern. It calls
`MarkdownRenderer.render(app, markdown, div, path, new Component())` into a
detached div, then loads `div.outerHTML` into a `remote.BrowserWindow` as a
`data:text/html` URL.

## Why chrome goes on in post-processing

Recognition depends on the fiducials, the QR code and the boxes sitting at the
exact millimeter coordinates that `layout.py` computes.
`geometry.refine_with_fiducials` builds a homography from the QR corners and the
four corner squares, then looks up every box rectangle in millimeters.

If Chromium draws those marks, their accuracy depends on the CSS pixel
definition, the `scale` option, `preferCSSPageSize`, margin box handling and
device pixel rounding. Every one of those must be correct, and any of them can
change between Electron versions without warning.

If pymupdf draws them after Chromium finishes, they land in PDF user space at
the coordinates `layout.py` already produces. Chromium scaling stops mattering.
One invariant remains: the page MediaBox must equal the expected page size. The
stamping code asserts that and fails loudly.

The overlay is also more accurate than the current Typst path. papersync draws
the QR modules as filled rectangles straight from the segno matrix, so no SVG
embedding and no rasterization sit between the payload and the paper.

## Project layout

```
local/lib/papersync/src/papersync/
├── model.py                            # Item gains `meta`
├── payload.py                          # ref is percent-encoded
├── config.py                           # ObsidianConfig
├── render/
│   ├── chrome.py                       # NEW: pymupdf chrome overlay
│   └── qr.py                           # gains qr_matrix()
├── recognize/
│   └── assemble.py                     # primary box becomes optional
└── integrations/obsidian/
    ├── __init__.py
    ├── cli.py                          # obsidian CLI wrapper
    ├── source.py                       # ObsidianSource
    ├── sink.py                         # ObsidianSink (mark_printed, check)
    ├── documents.py                    # spec building, output directory
    └── bridge/                         # copied into the vault
        ├── manifest.json
        ├── main.js
        └── page.css
```

`pyproject.toml` adds `**/*.js`, `**/*.json` and `**/*.css` to the wheel
artifacts, so the bridge ships inside the package.

The integration adds no new Python dependencies. Obsidian renders the markdown,
and `obsidian properties` returns the front matter already parsed as JSON, so
papersync needs neither a markdown parser nor a YAML parser.

## Selectors

`ObsidianSource.export(selector)` accepts four prefixed forms.

| Selector | Command |
|---|---|
| `search:<query>` | `obsidian search query=<query> format=json` |
| `base:<file>` or `base:<file>#<view>` | `obsidian base:query file=<file> view=<view> format=json` |
| `path:<path>` | direct read of that one note |
| `folder:<path>` | `obsidian files folder=<path> ext=md` |

`search:` passes the query through unchanged, so the full Obsidian search
grammar works: `tag:`, `path:`, `file:`, `line:` and `[property]`.

Every call carries `vault=<name>` from the `[obsidian] vault` configuration key.

Each resolved path is then fetched with two calls. `obsidian read path=<path>`
returns the file text, and `obsidian properties path=<path> format=json` returns
the parsed front matter. papersync removes the leading `---` block from the file
text by scanning for the delimiters. It never parses YAML itself.

A selector without a known prefix is an error that names the four valid forms.

## Ref format

The ref is the vault-relative path without the `.md` extension, for example
`Notes/Projects/Alpha`.

A ref contains slashes. `Payload.parse` splits the URL path into exactly three
segments, so `Payload.to_url` must percent-encode the ref and `Payload.parse`
must decode it. Things UUIDs contain no characters that quoting changes, so this
is backward compatible with every card already printed.

A rename breaks a ref. The manifest records the path and the modification time,
so a stale card produces a clear diagnostic instead of a wrong match.

## Core model

`Item` gains one field:

```python
meta: dict[str, Any] = {}
```

Things leaves it empty. Obsidian fills it from `obsidian properties`. `notes`
holds the body with the front matter block removed. Nothing else in the core
model changes.

`Item.meta` is the single source of truth for front matter. The spec file carries
it to the bridge, so the printed table and the exported items JSON always agree.

## Print state

`ObsidianSink.mark_printed(refs)` runs one command per note:

```
obsidian property:set name=papersync-printed value=<today> type=date path=<ref>.md
```

`export(skip_printed=True)` drops any note whose front matter already carries
that key. The property is visible in Obsidian, queryable with
`[papersync-printed]`, and it syncs across machines.

`_do_render` in `cli.py` currently calls the Things sink directly. It becomes a
dispatch over a `{source: sink}` mapping, so a mixed render tags each item in
the correct system.

## The bridge plugin

The bridge is plain CommonJS with no build step, so this repository needs no npm
toolchain. `papersync obsidian install-bridge` copies the three files to
`<vault>/.obsidian/plugins/papersync-bridge/` and runs
`obsidian plugin:enable id=papersync-bridge`.

Installation is always explicit. `papersync obsidian print` never writes to the
vault on its own. If the bridge is missing or its version does not match the
package version, `print` fails and names the install command.

The bridge exposes one entry point:

```js
window.papersync = { version: "<package version>", renderFile: async (specPath) => {...} }
```

papersync writes a spec file to a temporary directory and calls
`obsidian eval code='window.papersync.renderFile("/tmp/.../spec.json")'`.
Passing a file path avoids every `key=value` quoting problem in the Obsidian
CLI. The bridge writes the PDF to a path named in the spec and returns
`{"ok": true, "pages": <n>, "bytes": <n>}`, so no large payload crosses stdout.

### Spec file

```json
{
  "papersync_spec": 1,
  "path": "Notes/Projects/Alpha.md",
  "out": "/tmp/papersync-xxxx/001.pdf",
  "page": {"width_mm": 215.9, "height_mm": 279.4},
  "margins_mm": {"top": 22.0, "right": 12.0, "bottom": 27.0, "left": 12.0},
  "frontmatter": [["title", "Alpha"], ["tags", ["project", "active"]]]
}
```

The margins repeat `L.TOP_MM`, `L.MARGIN_MM` and `L.BOTTOM_MM`. `documents.py`
reads them from `layout.py` rather than restating the numbers, so the reserved
band and the chrome can never drift apart.

### What the bridge does per note

1. Read the file with `app.vault.cachedRead`.
2. Render the body with `MarkdownRenderer.render(app, body, div, path, new Component())`.
3. Build a front matter table from the spec's `frontmatter` pairs.
4. Wrap the table and the body in `page.css`.
5. Load the HTML into a hidden `remote.BrowserWindow`.
6. Call `printToPDF({preferCSSPageSize: true, printBackground: true, scale: 1})`.
7. Write the bytes to the spec's `out` path and destroy the window.

Step 2 is what buys the fidelity. Wikilinks, embeds, block references,
transclusions, callouts, highlights, footnotes, LaTeX math and plugin-rendered
content all resolve, because Obsidian renders them.

### page.css

```css
@page { size: 215.9mm 279.4mm; margin: 22mm 12mm 27mm 12mm; }
```

`preferCSSPageSize: true` makes Chromium honor this rule. The body therefore
cannot enter the band that the chrome occupies.

The front matter table renders as a two-column table at the top of the first
page. Scalar values print as text. List values print as a nested list. The order
of the rows follows the spec's `frontmatter` pairs, which the source builds in
file order minus the keys in `frontmatter_skip`.

## Chrome overlay

`render/chrome.py` exposes one function:

```python
def stamp(pdf: bytes, size: L.PageSize, labels: list[str],
          title: str, footer: str, payloads: list[Payload]) -> bytes
```

It first asserts that every page MediaBox equals `size` within a 0.1 mm
tolerance. A mismatch raises, because a mismatch means the recognizer would read
the wrong coordinates.

On every page it draws the four fiducials from `L.fiducials(size)`, the QR code
in `L.qr_rect(size)`, and the rotated footer in `L.footer_rect(size)` carrying
the date and `n/total`.

On the first page it draws the title bar from `L.title_bar(size)` and the meta
boxes from `L.meta_box(size, i)` with their labels. On later pages it draws the
continuation bar with `<title> (cont.)`.

It never draws a primary done box. That is the one visible difference from a
Things card.

`render/qr.py` gains `qr_matrix(text) -> list[list[bool]]` from segno. The
overlay draws each module as a filled rectangle, including the quiet zone. Title
and label text use the New Computer Modern Sans OTF already in the template
directory, loaded with `page.insert_font`.

Page totals are known before stamping. The bridge prints once and pymupdf counts
the pages, so the QR carries the correct `pages` value without the two-pass
compile that the Typst path needs.

## Recognition changes

These changes are small, and this spec makes them now so that pages printed
today stay scannable when the importer arrives.

`L.geometry` gains a `primary_box: bool` key. `assemble._score_boxes` takes a
`primary: bool` argument and skips the `done` box when it is false.
`recognize_pages` sets it from `payload.source == "things"`. For a source
without a primary box, `Change.complete` stays `False`.

The homography, the fiducial refinement and the box scoring do not change.

## Output

```
out/papersync-<stamp>/
├── 001-project-alpha.pdf
├── 002-reading-queue.pdf
└── manifest.json
```

The slug is the note basename, lowercased, with runs of non-alphanumeric
characters collapsed to `-` and the result capped at 60 characters. The index
prefix keeps two notes with the same slug apart.

`manifest.json`:

```json
{
  "papersync_manifest": 1,
  "created": "2026-09-12T10:15:00",
  "vault": "Notes",
  "source": "obsidian",
  "documents": [
    {"index": 1, "file": "001-project-alpha.pdf",
     "ref": "Notes/Projects/Alpha", "path": "Notes/Projects/Alpha.md",
     "title": "Alpha", "pages": 3, "size": "letter",
     "boxes": 2, "labels": ["A", "B", "C", "D"],
     "mtime": "2026-09-11T18:02:11"}
  ]
}
```

The ledger records one `render` entry per document, with the per-document file
path, so `papersync status` works the same way it does for cards.

papersync does not spool. The README documents the print loop:

```
for f in out/papersync-*/*.pdf; do lpr -o sides=two-sided-long-edge "$f"; done
```

Separate print jobs mean a duplex printer starts each document on a sheet front
without any blank-page padding.

## CLI

```
papersync obsidian export <selector>          # items JSON on stdout
papersync obsidian print <selector>           # export, render, stamp, write
papersync obsidian install-bridge             # copy and enable the plugin
```

The group mirrors `papersync things`. `--skip-printed` and the render options
behave as they do today, with two differences. `--size` defaults to `letter` and
rejects `auto`, because size selection is meaningless for a multi-page document.
Overflow is always `paginate`.

`papersync doctor` gains four checks: `obsidian` on PATH, the app running via
`obsidian vault info=name`, the bridge installed and enabled, and the bridge
version matching the package version.

## Configuration

```toml
[obsidian]
vault = "Notes"
frontmatter_skip = ["papersync-printed"]
```

## Error handling

| Condition | Behavior |
|---|---|
| Obsidian is not running | `ClickException` that tells the user to open Obsidian. |
| Bridge missing or stale | `ClickException` naming `papersync obsidian install-bridge`. |
| Restricted mode is on | Report the failed `plugin:enable` and name restricted mode. |
| Unknown selector prefix | Error listing the four valid prefixes. |
| Note not found | Error naming the path. Other notes in the run still print. |
| MediaBox mismatch | `stamp` raises. The document is not written. |
| `property:set` fails | Warn per ref, the same way the Things sink reports untagged refs. |

## Testing

The dimensional fidelity question gets a direct test rather than an argument.

A round-trip test stamps a synthetic body PDF, rasterizes it with the existing
`raster.iter_pages`, and runs the real recognizer over the result. It asserts
that the QR decodes to the expected payload, and that
`geometry.refine_with_fiducials` places every meta box where `layout.py` says it
is. This proves the geometry end to end without a printer.

A second test opens a stamped PDF and compares the drawn rectangle positions to
`L.fiducials()` and `L.meta_box()` within 0.1 mm.

A third test asserts that the Typst renderer and the pymupdf overlay place their
marks at identical coordinates. Two chrome implementations now exist, one per
source, and this test stops them from drifting.

Selector parsing and spec construction are pure functions, tested against
recorded `obsidian` CLI JSON fixtures. No test in the default suite calls
Obsidian.

`script/test` runs `node --check` on `bridge/main.js` when node is installed.

A live integration test runs behind `PAPERSYNC_REAL_OBSIDIAN=1`, mirroring
`PAPERSYNC_REAL_OCR=1`. It installs the bridge into a throwaway vault, prints one
note and asserts the page count.

## Open trade-offs

Two chrome implementations exist after this change. Things stays on Typst,
because that recognition path works today and a rewrite risks it. The third test
above holds the two in agreement. Moving Things onto the overlay later is
possible, and both renderers already read their geometry from the same
`layout.py`.

The Obsidian path needs the app running. That is acceptable, because the fidelity
it buys is the reason to choose it. The Things path stays headless.
