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
`scan` tags each recognized item `papersync:scanned` once its changes apply.
Both tags mark state. Neither one controls what papersync selects or renders.

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
