# papersync — Design Spec

**Status:** Draft
**Date:** 2026-09-07
**Owner:** jacob@smithjs.org

## Goal

Replace `local/bin/things-export`, `local/bin/things-print` and `local/bin/things-pdf-matcher.py` with one Python CLI named `papersync`. The tool prints Things items onto index cards, and reads marked and annotated cards back into Things. It uses machine-readable marks (a QR code, corner squares and checkboxes) in the style of SDAPS instead of OCR and fuzzy title matching.

Things is the first integration. The core is integration-neutral so a second source or sink is one new module.

## Non-goals

- SDAPS itself as a dependency. It is not on PyPI, it needs a meson build with a C extension, and it stamps IDs onto copies of one fixed questionnaire, which does not match per-item cards.
- Linux support for the scan path. OCR uses Apple Vision, and Things runs only on macOS. The render path is pure Python and works anywhere, but only macOS is tested.
- Markdown rendering of notes on the card. Notes render as plain text with line breaks preserved.
- Interactive per-box confirmation. Uncertain marks produce warnings, and the user edits the plan JSON by hand.
- Folder watching, duplex scanning, a GUI, or a web UI.

## Terms

- Item: one Things to-do, or the neutral record the core passes around.
- Card: one printed page for one item, or one continuation page of a paginated item.
- Handwriting page: a scanned page without a papersync QR code.
- Plan: the JSON list of changes that `recognize` produces and `apply` executes.
- Template: a versioned layout (a Typst file plus Python geometry) that fixes where every mark sits.

## Project layout

XDG defines bin, share, config, state, cache and runtime directories but no library directory. systemd's file-hierarchy(7) documents `~/.local/lib` for private user libraries, and pip uses it too. The project lives there.

```
local/bin/papersync                  # shell shim (rcm -> ~/.local/bin/papersync)
local/lib/papersync/                 # uv project (rcm -> ~/.local/lib/papersync/)
├── pyproject.toml
├── uv.lock
├── src/papersync/
│   ├── cli.py                       # click entry point, subcommands
│   ├── model.py                     # Item, Plan, Change, PageResult (pydantic)
│   ├── registry.py                  # integration lookup by name
│   ├── config.py                    # ~/.config/papersync/config.toml
│   ├── ledger.py                    # ~/.local/state/papersync/prints.jsonl
│   ├── render/
│   │   ├── engine.py                # size selection, pagination, Typst compile
│   │   ├── qr.py                    # segno payload -> SVG
│   │   └── templates/v1/
│   │       ├── card.typ
│   │       └── layout.py            # geometry: page sizes, box rects, thresholds
│   ├── recognize/
│   │   ├── raster.py                # pymupdf / image loading at 300 dpi
│   │   ├── qr.py                    # zxing-cpp decode + payload parsing
│   │   ├── fiducials.py             # corner square detection, homography
│   │   ├── marks.py                 # checkbox fill scoring
│   │   ├── ocr.py                   # OcrBackend protocol, ocrmac implementation
│   │   └── review.py                # annotated debug output
│   └── integrations/
│       ├── base.py                  # Source, Sink protocols
│       └── things/
│           ├── db.py                # read-only sqlite access
│           ├── source.py            # export, lookup
│           ├── sink.py              # URL scheme writer, verify
│           └── auth.py              # keychain token
└── tests/
```

The shim is:

```sh
#!/bin/sh
exec uv run --project "$HOME/.local/lib/papersync" --frozen papersync "$@"
```

`local/lib/papersync` is added to `SYMLINK_DIRS` in `rcrc`, so the whole project is one symlink and uv's `.venv` and caches stay inside the repo directory. `.venv/` is added to `.gitignore`.

If uv is absent, the shim fails with the shell's own "command not found" error. On first use uv creates the virtual environment and installs the locked dependencies. `tag-mac/Brewfile` already lists `uv`.

`script/test` runs the papersync suite (`uv run --project local/lib/papersync ruff check`, `ruff format --check`, `ty check`, `pytest`) only when uv is on PATH, so it stays non-destructive on machines without uv.

The three `things-*` scripts are deleted.

## Dependencies

All are wheels on PyPI. No Homebrew packages beyond `uv`.

| Package | Use |
|---|---|
| click | CLI |
| pydantic | Item, Plan and config validation, including hand-edited plans |
| typst | PDF rendering, bundles New Computer Modern fonts |
| segno | QR generation as SVG |
| pymupdf | rasterize scanned PDFs |
| zxing-cpp | QR decode with corner points |
| opencv-python-headless, numpy | fiducial detection, homography, fill scoring |
| ocrmac | Apple Vision OCR |
| keyring | macOS keychain |

Dev: pytest, ruff, ty (mypy `--strict` as fallback if ty cannot type the dependencies).

## CLI

```
papersync things export <inbox|next|someday|things:///show?id=UUID>
papersync things auth                      # store or rotate the token
papersync render [ITEMS.json|-] [--size auto|3x5|4x6|letter]
                 [--overflow fail|paginate|truncate] [--boxes LABEL,...]
                 [--new N] [-o DIR] [--open] [--tag/--no-tag]
papersync print <things-selector> [render flags]     # export | render
papersync recognize SCAN... [--review annotated.pdf]
papersync apply <plan.json|-> [--auto-approve] [--no-verify]
papersync scan SCAN... [apply flags]                  # recognize | apply
papersync status [--forget REF]
papersync doctor
```

`export` writes JSON only. The selectors keep the SQL semantics of the old `things-export`: open tasks that are not trashed, ordered by creation date, for the inbox, the Next list (including tasks of Next projects), the Someday list, or one project by UUID.

`recognize` writes the plan JSON to stdout. When stderr is a terminal it also writes the diff-style display to stderr. `apply` reads the plan, shows the display, and asks for a literal `yes`. `--auto-approve` skips the question but exits nonzero if the plan contains any error entry.

Human output goes to stderr. Data goes to stdout.

### Configuration

`~/.config/papersync/config.toml` is optional and holds render defaults:

```toml
[render]
size = "auto"
overflow = "fail"
boxes = ["A", "B", "C", "D"]
output_dir = "."
open = true
tag = true

[things.actions]
today = { when = "today" }
someday = { when = "someday" }
waiting = { tags = ["waiting"] }
```

Flags override the file.

### Box labels, box sets and actions

`--boxes` (or `[render] boxes`) is a list of labels. The labels print under the meta boxes.

The QR cannot hold the labels, so it holds a box set number. papersync manages the registry at `~/.config/papersync/boxsets.toml`:

```toml
[[sets]]
id = 1
labels = ["A", "B", "C", "D"]
created = 2026-09-07T10:00:00Z
```

On render, the engine looks up the label list. If an identical list exists, it reuses that id. If not, it appends a new set with the next id. The code never edits or removes an existing set, so an old card always resolves to the labels it was printed with. The file lives in the config directory so that the dotfiles repo versions it. On recognize, an unknown id is a plan error for that page.

A checked label resolves to an action at apply time through `[things.actions]`. An action is a table with any of the Things `update` parameters `tags`, `when`, `deadline`, `list`, `completed` and `canceled`. A label with no entry adds the tag `papersync:meta:<label>`. The done box left of the title is fixed in the template and its action is always `completed`. If two checked labels set the same parameter, the last label in print order wins and the plan display carries a warning. Actions resolve from the current configuration, so a label keeps its meaning across reprints while its effect is free to change.

## Core model

```python
class Item:        source: str; ref: str; title: str; notes: str
class BoxResult:   fill: float; checked: bool; uncertain: bool
class Change:      kind: "update" | "create"; source; ref | None; title
                   complete: bool; marks: list[str]; append_notes: str | None
                   notes: str | None (create only); boxes: dict[str, BoxResult]
                   pages: list[int]
class PlanError:   page: int; message: str
class Plan:        papersync_plan: 1; created: datetime; inputs: list[str]
                   changes: list[Change]; errors: list[PlanError]
```

`ref` is opaque to the core. Only the integration interprets it. `marks` is the list of checked labels, which is what the user edits by hand. `boxes` keeps the raw scores for every box, keyed by label, with `done` for the title box.

### Integration protocols

```python
class Source(Protocol):
    name: str
    def export(self, selector: str) -> list[Item]: ...
    def lookup(self, refs: list[str]) -> dict[str, Item]: ...

class Sink(Protocol):
    name: str
    def describe(self, change: Change) -> list[str]: ...
    def apply(self, changes: list[Change]) -> None: ...
    def verify(self, changes: list[Change]) -> list[str]: ...   # unmet changes
    def mark_printed(self, refs: list[str]) -> None: ...        # state tag on render
    def check(self) -> list[str]: ...                          # for doctor
```

`registry.py` maps the name in the QR payload (`things`) to the module.

## QR payload

```
papersync:///v1/things/<uuid>?size=3x5&boxes=1
papersync:///v1/things/<uuid>?size=letter&boxes=1&page=2&pages=3
papersync:///v1/things/new?size=3x5&boxes=2
```

- `v1` is the template version. It selects the geometry for recognition. A layout that moves any box is `v2`. Old cards keep scanning.
- The Things UUID is used directly. No short-ID mapping exists.
- `size` names the layout variant. `page` and `pages` appear only on paginated items.
- `boxes` is the box set number from the registry. It maps to the printed labels.
- `new` marks a blank card for a new item.

The longest payload is 82 bytes. The template always renders QR version 5 with a 0.38 mm module, about 14 mm square plus the quiet zone, so the QR footprint is constant across payloads. Error correction is level M, which holds 84 bytes, and falls back to level L (106 bytes) for a longer payload.

## Rendering

### Size selection

With `--size auto`, the engine compiles each item at 3x5, then 4x6, then letter, and keeps the first size that yields one page. Letter always paginates. Items are grouped by chosen size and written as `papersync-<YYYYMMDD-HHMMSS>-<size>.pdf` in the output directory, one file per size actually used.

With a forced size, `--overflow` decides: `fail` exits nonzero and lists the items that do not fit, `paginate` allows multiple pages at that size, `truncate` cuts the notes at a visible marker and warns on stderr.

A paginated item compiles twice: once to learn the page count, once with `pages` in every page's QR.

### Template v1

`layout.py` is the single source of truth for geometry. The engine passes the geometry and the item to `card.typ` as JSON through `sys.inputs`, so the Typst file and the recognizer never disagree. Strings pass through Typst code mode and are never parsed as markup.

Per page:

- Four black 5 mm squares in the corners, inset 4 mm. These are the fiducials.
- The QR at bottom right, inside the fiducial frame.
- Page 1 only: a checkbox left of the title, the title in bold sans on a light grey bar (the SDAPS heading look), and the meta checkbox row at bottom left with the printed labels under the boxes. The number of boxes is the number of labels in the selected set. `render` exits nonzero if the set has more labels than fit at the chosen size (six on 3x5 with the v1 geometry).
- Notes in New Computer Modern serif, plain text, line breaks preserved.
- Continuation pages: the title bar with "(cont.)", the notes overflow, no boxes.
- A `2/3` page marker in the footer on paginated items, and the print date in the footer on every page.

New-item cards (`--new N`) use the same geometry with faint ruled lines in the title and notes areas.

### State tags in Things

Each printed item carries one live state tag in Things. `render` adds `papersync:printed` to every item it prints, `apply` swaps it for `papersync:scanned`, and a reprint swaps back. A Things filter on `papersync:printed` is therefore a live "on my desk" view. The ledger keeps the dated history.

`render` calls `Sink.mark_printed(refs)` for every source it printed items for, after the PDFs are written. `--no-tag` or `tag = false` in the configuration skips this. The Things sink swaps the state tag through the update URL's `tags` parameter, which replaces the whole tag list: it reads the item's current tags from the database, drops any `papersync:printed` or `papersync:scanned`, appends the new state tag, and sends the result. `render` and `print` therefore need the auth token and a running Things.

The Things URL scheme never creates a tag and silently ignores an unknown one. Before it writes tags, the sink reads the tag titles from the database and creates the missing ones with one AppleScript call through `osascript`:

```
tell application "Things3"
  make new tag with properties {name:"papersync:printed"}
end tell
```

This covers the state tags and the `papersync:meta:*` tags alike. No token is needed for AppleScript.

### Ledger

Every rendered item appends `{"ts", "event": "render", "source", "ref", "title", "size", "boxes": <set id>, "file"}` to `~/.local/state/papersync/prints.jsonl` (`$XDG_STATE_HOME` respected). Every applied change appends an `apply` event with the same keys. `status` lists refs with a render event and no later apply event, marks the ones Things already shows as complete, and `--forget REF` appends a `forget` event to drop one.

## Recognition

Input files are PDFs or images. PDFs rasterize at 300 dpi through pymupdf. Pages are processed in file order, then page order.

Per page:

1. Decode QR codes with zxing-cpp. If no `papersync:///` payload is present, the page is a handwriting page. A foreign QR alone does not make a page a card.
2. Parse the payload. An unknown template version or integration is a plan error.
3. Find the four corner squares with OpenCV near their expected positions for the named size. The QR position (bottom right) resolves the 180-degree ambiguity of four identical squares. Missing squares are a plan error.
4. Compute the homography from template millimeters to pixels.
5. Page 1 of an item: crop the interior of every box (border excluded), binarize, and compute the dark-pixel fill ratio. Below the low threshold is unchecked, above the high threshold is checked, between is uncertain. Thresholds live in `layout.py`. Continuation pages have no boxes.

The `boxes` number in the QR selects the box set in the registry, which gives the label for each box index. An unknown set number is a plan error for that page.

A handwriting page is OCRed through the `OcrBackend` protocol. The only implementation is ocrmac at the accurate recognition level. The text is appended to the most recent card in the batch. Several handwriting pages after one card are joined in order with a blank line. A handwriting page before any card is a plan error.

Appended text uses this block, so it reads well in Things:

```
## Scanned 2026-09-07

> first line of handwriting
> second line
```

A `new` card becomes a `create` change. The first OCR line of its own page is the title and the remaining lines, plus any following handwriting pages, are the notes. Its done box and meta boxes apply as on a normal card.

Uncertain boxes are treated as unchecked, marked `"uncertain": true` in the plan, and reported as warnings. They are not plan errors.

`--review PATH` writes the rasterized pages as a PDF with every box outlined in green (checked), red (unchecked) or amber (uncertain), the fiducials and QR outlined, and the fill ratio printed beside each box.

### Plan display

One block per change:

```
FOO  things:///show?id=UUID  (pages 1)
+ completed
+ A        tag papersync:meta:A

BAR  things:///show?id=UUID  (pages 2-3)
+ today    when=today
? waiting  fill 0.31, treated as unchecked
--- notes
+++ notes
@@ -1 +1,5 @@
 BAZ
+
+## Scanned 2026-09-07
+
+> some handwriting
```

The notes diff is a unified diff of the current notes (read from the source) against the notes after the append.

## Apply

The Things sink resolves `marks` to actions, then issues one `things:///update?id=…&auth-token=…` URL per `update` change through `open -g`, combining `completed=true`, `tags`, `when`, `deadline`, `list`, `canceled` and `append-notes=<block>` as needed. The `tags` value is the item's current tags plus the action tags, with `papersync:printed` replaced by `papersync:scanned`. A `create` change issues `things:///add?title=…&notes=…` with the same action parameters, which needs no token.

Before issuing URLs, the sink reads the database and drops parts that already hold: an item that is already complete or canceled, a tag list that would not change, a notes block already present verbatim, a deadline already set to that date, or a `when` of today, someday or anytime that the start fields already show. A `list` parameter is always sent. A second run of the same plan is a no-op apart from `list`.

The token comes from `keyring` (service `papersync`, account `things-auth-token`). If it is missing, `apply` prompts with `getpass`, stores it, and continues. `things auth` stores a new one.

The URL scheme returns nothing, so after issuing the URLs the sink waits two seconds, re-reads the database, and reports every change that did not land. Verification covers the same fields as the skip logic. `--no-verify` skips this. A verify failure exits nonzero.

## Error handling

- The Things database path is discovered under `~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*`. If it is missing, `export`, `recognize` and `apply` exit with a message that names the expected path.
- Every recognition problem becomes a plan error with the page number, never an exception. `recognize` still exits zero and writes the plan, so the user can edit it. `apply` refuses a plan with errors unless the user removes them.
- `apply` validates the plan with pydantic and reports the field path on failure.
- `doctor` checks uv, the Things database, the keychain token, that Typst can compile the template, and that ocrmac imports.

## Testing

- Round trip without a scanner: render fixture items, rasterize with pymupdf, draw synthetic marks into chosen boxes at the template coordinates, rotate by a few degrees, scale by a few percent, add a handwriting page image, then recognize with a fake OCR backend and assert the exact plan.
- Size selection and every `--overflow` mode on short, medium and long fixtures, including the two-pass page count.
- QR payload parsing, including rejection of unknown versions, integrations and box set numbers.
- Things source against a fixture sqlite built from the real schema subset. Things sink with an injected opener that captures URLs, an injected AppleScript runner that captures tag creation, and a fixture database for the skip, state-tag swap and verify logic.
- Ledger and status against a temporary state directory. Box set registry: reuse of an identical list, append of a new list, and refusal to rewrite.
- Action resolution: default tag, configured actions, and the conflict warning.
- One opt-in test that runs real ocrmac on a checked-in handwriting image, skipped unless `PAPERSYNC_REAL_OCR=1`.
- `ruff check`, `ruff format --check` and `ty check` pass with no ignores in the source tree.

## Migration

- Delete the three `things-*` scripts.
- Add `local/bin/papersync` and `local/lib/papersync/`, add the latter to `SYMLINK_DIRS` in `rcrc`, and add `.venv/` to `.gitignore`.
- Extend `script/test` as described above.
- Update `CLAUDE.md` structure notes to mention `local/lib/`.
