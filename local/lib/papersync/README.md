# papersync

papersync prints [Things](https://culturedcode.com/things/) items to index
cards for offline use. It scans the cards back in later, to update or
complete the corresponding Things items.

This is a [uv](https://docs.astral.sh/uv/)-managed project. Run it directly
with `uv run --project ~/.local/lib/papersync papersync`, or use the
`~/.local/bin/papersync` shim installed by this dotfiles repo.

## Round trip

The round trip is four commands:

1. `papersync print <selector>` exports Things items and renders cards.
2. Mark the cards by hand: check boxes, write notes, fill fields.
3. `papersync scan <files>` recognizes the marks and applies changes.
4. `papersync status` lists cards that were printed but never scanned back.

`print` tags each exported item `papersync:printed` in Things by default.
`print` and `things export` skip items that already carry that tag. Pass `--no-skip-printed` to include them.
`scan` tags each recognized item `papersync:scanned` once its changes apply.
Both tags mark state. Neither one controls what papersync selects or renders.

## Obsidian documents

papersync also prints Obsidian notes. A note is a document, not a task, so
it prints without a primary checkbox. Each note becomes its own PDF.

Set the vault in `~/.config/papersync/config.toml`:

```toml
[obsidian]
vault = "Notes"
```

Install the bridge plugin once. papersync never writes to the vault on its
own:

```
papersync obsidian install-bridge
```

Then print. The selector takes four forms:

```
papersync obsidian print 'search:tag:#project -path:Archive'
papersync obsidian print 'base:Reading.base#Queue'
papersync obsidian print 'path:Notes/Projects/Alpha.md'
papersync obsidian print 'folder:Notes/Projects'
```

The `search:` form passes the query straight to Obsidian, so the whole
Obsidian search grammar works. This includes `tag:`, `path:`, `file:`,
`line:`, and `[property]`.

The output is one directory of PDFs, plus a manifest, per run:

```
papersync-20260912-101500/
├── 001-project-alpha.pdf
├── 002-reading-queue.pdf
└── manifest.json
```

Pass `-o <dir>` to write the run to another directory instead.

Print them duplex. Separate print jobs make duplex work. Each document
starts on a sheet front, so continuation pages land on the backs and
nothing is padded.

```
for f in papersync-*/*.pdf; do lpr -o sides=two-sided-long-edge "$f"; done
```

Obsidian renders the body with its own renderer, so wikilinks, embeds,
block references, callouts, and maths print as they appear on screen.
papersync draws the corner squares, the QR code, and the checkboxes onto
the finished PDF. The marks sit at exact millimetre positions, whatever
Obsidian did with pagination.

`print` marks each note with a `papersync-printed` date property, and
skips notes that already carry it. Pass `--no-skip-printed` to include
them.

Scanning documents back in is not implemented.

### Live test

`tests/test_obsidian_real.py` drives a running Obsidian. It is skipped
unless you set both variables:

```
PAPERSYNC_REAL_OBSIDIAN=1 PAPERSYNC_REAL_VAULT=Notes uv run pytest tests/test_obsidian_real.py -q
```

Running it installs the papersync bridge plugin into the named real vault.
It marks nothing else.

## Configuration

papersync reads `~/.config/papersync/config.toml`. In this repo that path
is a symlink to `config/papersync/`, so the file is versioned. The file
sets render defaults. Under `[things.actions]` it also names actions.
When `scan` sees a marked box, it applies the matching named action. See
`config/papersync/config.toml` for the documented defaults and one example.

## Where things live

- The Things URL-scheme auth token lives in the macOS keychain, under the
  service `papersync`. `papersync doctor` reports whether it is set.
- The print ledger lives at `~/.local/state/papersync/prints.jsonl`.
- The box set registry lives at `~/.config/papersync/boxsets.toml`. It is
  versioned the same way as `config.toml`, and it grows as new box
  layouts print.

## Real OCR test

`tests/test_ocr_real.py` calls the real on-device Apple Vision backend
instead of a fake. It is skipped unless you set `PAPERSYNC_REAL_OCR=1`.
Run it with:

```
PAPERSYNC_REAL_OCR=1 uv run pytest tests/test_ocr_real.py -q
```
