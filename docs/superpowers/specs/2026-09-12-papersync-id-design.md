# papersync-id: stable Obsidian refs

**Status:** approved, not yet implemented
**Amends:** `docs/superpowers/specs/2026-09-12-papersync-obsidian-design.md`

## Problem

The Obsidian integration puts the note path in the QR code. The path is not
stable. A rename or a move breaks the link from a printed sheet back to its
note, and the failure is silent until a scan reports an unknown item.

The path also has no length bound. Percent-encoded, a deep vault path pushes
the QR to a version that a 300 dpi scan cannot decode. The current code
handles this with a version cap that raises `QrCapacityError`, which turns a
silent failure into a loud one but still refuses to print the note.

Obsidian has no built-in note id. The path is the identity. A front matter
property is the idiomatic substitute, and it is queryable:
`obsidian search query='["papersync-id":"<value>"]' format=json` returns the
path of the note that carries the value.

## Solution

papersync mints a `papersync-id` property on every Obsidian note it exports
or prints, and uses that id as the ref in the QR code. Paths never appear in
a payload again.

## Identity

`papersync-id` is a 12 character string over the lowercase Crockford base32
alphabet `0123456789abcdefghjkmnpqrstvwxyz`. Crockford omits `i`, `l`, `o`
and `u`, so a hand-transcribed id cannot be confused between `1` and `l` or
between `0` and `o`.

Twelve characters carry 60 bits. The values come from `secrets.choice`, not
`random`. Collision is negligible at any personal vault size, and the mint
step checks for one anyway.

The property type is `text`. The value is opaque: it encodes no timestamp,
no path, and no ordering. The ledger already records when a sheet was
printed, so a sortable id would buy nothing.

### Payload size

The ref is now fixed length, so every Obsidian payload is about 72
characters:

```
papersync:///v1/obsidian/k7m2q9xr4tb8?size=letter&boxes=1&page=2&pages=3
```

That is QR version 5 at error level M. `QR_VERSION_CAP` stays at 12 as a
guard for other sources, but no Obsidian print can approach it.

## Item gains a locator

`Item` today carries one address, `ref`, which serves as both the durable
identity and the handle used to read and write the item. For Obsidian those
two roles split: the id is the identity, the path is the handle.

```python
class Item(BaseModel):
    source: str
    ref: str
    title: str
    notes: str = ""
    meta: dict[str, Any] = Field(default_factory=dict)
    locator: str = ""

    @property
    def address(self) -> str:
        """Where to read and write this item. Falls back to ref."""
        return self.locator or self.ref
```

Obsidian sets `ref` to the id and `locator` to the note path, including the
`.md` extension. Things leaves `locator` empty, because a Things uuid is
both identity and handle.

Consumers divide cleanly:

| Consumer | Field | Why |
| --- | --- | --- |
| `Payload.ref` | `ref` | must survive a rename |
| `LedgerEntry.ref` | `ref` | must match a scanned payload |
| `build_spec` `path` | `locator` | the bridge opens a file |
| `mark_printed` | `address` | `property:set` needs a path |
| manifest `ref` / `path` | both | a human reads the directory |

`_tag_printed` in `cli.py` changes from collecting `item.ref` to collecting
`item.address`. Things is unaffected, because `address` returns `ref` when
`locator` is empty.

## Minting

`ObsidianSource._item` mints when the note has no `papersync-id`:

1. Read the note's properties. If `papersync-id` is present and non-empty,
   use it and write nothing.
2. Otherwise generate a candidate.
3. Search for the candidate. If any note already carries it, generate
   another. Give up after 5 attempts and raise.
4. `property:set name=papersync-id value=<id> type=text path=<path>`.
5. Read the property back. If it does not match, raise.

The read-back matters because the Obsidian CLI signals failure on stdout and
has exited 0 in the past for operations that did nothing.

A note whose mint fails is appended to `source.errors` and skipped. It is
never printed with a substitute ref, because a sheet with a fragile ref is
worse than a sheet that was not printed.

### Which commands mint

Both `papersync obsidian export` and `papersync obsidian print`.

`export` is a read-only inspection command today, and minting makes it write
to the vault. That is the one surprising consequence of this design, and it
is accepted so that an id means the same thing everywhere. The `export`
help text states it:

> Exports notes as JSON. Mints a papersync-id property on any note that
> lacks one, so the vault is modified.

### Interaction with --no-tag

`--no-tag` suppresses only `papersync-printed`. It does not suppress
minting.

The id is identity, not state. `--no-tag` exists so a note stays
reprintable, and an id does not affect that. Making `--no-tag` also skip
minting would produce sheets whose refs are of a different and worse kind,
which is exactly the failure this design removes. The `print` help text
states the narrower meaning:

> --no-tag  do not set papersync-printed. A papersync-id is still minted.

## Lookup

`ObsidianSource.lookup(refs)` resolves each id:

```
obsidian search query='["papersync-id":"<id>"]' format=json
```

- One path: read it and return the `Item`.
- No paths: append `unknown papersync-id <id>` to `self.errors`. The ref is
  omitted from the returned dict, and `recognize_pages` already turns a
  missing ref into an "unknown item" page error.
- Two or more paths: append
  `papersync-id <id> is on more than one note: <a>, <b>` and omit the ref.
  This happens when a note is duplicated inside Obsidian, which copies the
  front matter. The scan must not guess which copy the sheet came from.

`lookup` no longer constructs `f"{ref}.md"`.

## Sink

`ObsidianSink.mark_printed` already takes a list and calls `property:set`
with `path=f"{ref}.md"`. It now receives paths and passes them through
unchanged. The `.md` suffix comes from the locator, not from the sink.

`ObsidianSink` gains nothing else. `apply` and `verify` still raise
`NotImplementedError`, because the importer does not exist.

## No migration

Nothing durable has been printed. The path ref form is deleted outright
rather than kept as a fallback, so there is exactly one kind of Obsidian ref
in the system.

The stale `render` entry in the ledger from the earlier live test is dropped
with `papersync status --forget`.

## Vault hygiene

The vault must end this work with no `papersync-printed` and no
`papersync-id` property on any note. It is currently clean: a
`properties counts` scan finds neither.

Live verification therefore never touches an existing note. It creates its
own note, uses it, and deletes it permanently:

```
obsidian create path="papersync-live-test.md" content="..."
obsidian rename path="papersync-live-test.md" name="papersync-live-renamed"
obsidian delete path="papersync-live-renamed.md" permanent
```

The final step of the work is a `properties counts` scan confirming that
neither property appears in the vault.

## Errors

| Condition | Message |
| --- | --- |
| Mint cannot find a free id | `could not mint a unique papersync-id for <path> after 5 attempts` |
| `property:set` did not stick | `set papersync-id on <path> but read back <value>` |
| Lookup finds nothing | `unknown papersync-id <id>` |
| Lookup finds several | `papersync-id <id> is on more than one note: <paths>` |

Each is a per-note error on `source.errors`, not a crash. A run prints every
note it can and reports the rest.

## Testing

Unit tests, all with a fake `ObsidianCli`:

- a minted id is 12 characters, all from the Crockford alphabet
- 1000 minted ids are distinct
- a note that already has `papersync-id` is not written to
- a first candidate that collides causes a second candidate to be written
- five collisions raise
- a `property:set` that does not stick raises
- a mint failure skips the note and records an error, and other notes in the
  same selector still export
- `Item.address` returns `locator` when set and `ref` when not
- `build_spec` puts the locator in `path`
- `write_documents` records both `ref` and `path` in the manifest
- `lookup` returns the item for one hit
- `lookup` records an error and omits the ref for zero hits
- `lookup` records an error naming both paths for two hits
- `_tag_printed` sends addresses, so Obsidian receives paths

Acceptance test, live, on a disposable note:

1. Create `papersync-live-test.md` with front matter and a few paragraphs.
2. `papersync obsidian print path:papersync-live-test`.
3. Confirm the note now carries a `papersync-id` and the QR decodes to it.
4. Rename the note.
5. Rasterize the PDF, distort and blur it, and scan it.
6. Confirm the scan resolves to the renamed path with no errors. This is the
   test the old design could not pass.
7. Delete the note permanently and confirm the vault is clean.

## Trade-offs accepted

- `papersync obsidian export` writes to the vault. Consistency of the id is
  worth more than the purity of one inspection command.
- papersync adds a property to notes it prints. The user already accepted
  `papersync-printed`; this is a second property of the same kind.
- An id is opaque, so `papersync status` shows a meaningless ref for Obsidian
  rows. The entry's `title` carries the meaning, and it is already displayed.
- Lookup costs one search per ref. Scanning is not implemented yet and the
  cost is small when it is.
