# papersync-id Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the path-based Obsidian ref with a minted `papersync-id` front matter property, so a printed sheet still resolves after the note is renamed or moved.

**Architecture:** A new `identity` module mints and verifies ids through the Obsidian CLI. `Item` grows a `locator` field so the note path stays available for reads and writes without entering the QR payload. `ObsidianSource` mints on export, `lookup` resolves an id through a property search, and every path consumer switches from `ref` to `locator` or `address`.

**Tech Stack:** Python 3.12, uv, pydantic, click, pymupdf, segno, pytest, ruff, ty.

**Spec:** `docs/superpowers/specs/2026-09-12-papersync-id-design.md`

## Global Constraints

- Work in `/Users/jacob/.dotfiles/local/lib/papersync`. Commit directly to `main`.
- Run `cd /Users/jacob/.dotfiles/local/lib/papersync && uv run pytest` for tests. Run `/Users/jacob/.dotfiles/script/test` before the final commit of the last task.
- ruff: line-length 100, target py312, rules `E,F,I,B,UP,N,SIM,RUF`. Run `uv run ruff check .` and `uv run ruff format .`.
- `uv run ty check` must pass. `ty` does NOT honor mypy `# type: ignore` comments.
- The id alphabet is exactly `0123456789abcdefghjkmnpqrstvwxyz` (Crockford base32, lowercase, no `i`/`l`/`o`/`u`). The id length is exactly 12. Use `secrets.choice`, never `random`.
- The property name is exactly `papersync-id`, type `text`.
- The maximum number of mint attempts is 5.
- The Obsidian CLI always exits 0 and signals failure with a line starting `Error: `. It replies `No matches found.` (not JSON, not an error) when a search matches nothing.
- Never write to an existing note in the user's vault during development. Task 7 is the only task that touches the live vault, and it creates and deletes its own note.
- Do not add a path fallback for refs. There is exactly one kind of Obsidian ref: a minted id.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_011JMUqgy2gKd6s7xL1EmqMJ
  ```

---

### Task 1: Item gains a locator

**Files:**
- Modify: `src/papersync/model.py`
- Test: `tests/test_model.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `Item.locator: str` and `Item.address -> str`. Tasks 3, 4 and 5 depend on both.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_model.py`:

```python
def test_address_prefers_the_locator_and_falls_back_to_the_ref() -> None:
    things = Item(source="things", ref="ABC-123", title="Buy milk")
    assert things.locator == ""
    assert things.address == "ABC-123"

    note = Item(
        source="obsidian",
        ref="k7m2q9xr4tb8",
        title="Alpha",
        locator="Notes/Projects/Alpha.md",
    )
    assert note.address == "Notes/Projects/Alpha.md"
```

Make sure `Item` is imported at the top of the file; add it to the existing import if it is not there.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_model.py::test_address_prefers_the_locator_and_falls_back_to_the_ref -v`
Expected: FAIL with `AttributeError` or a pydantic validation error about `locator`.

- [ ] **Step 3: Write minimal implementation**

In `src/papersync/model.py`, replace the `Item` class with:

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
        """Where to read and write this item, as opposed to what identifies it.

        For Things the uuid is both, so ``locator`` stays empty. For Obsidian
        ``ref`` is a minted papersync-id that survives a rename, while
        ``locator`` is the note path that the CLI actually needs.
        """
        return self.locator or self.ref
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_model.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/papersync/model.py tests/test_model.py
git commit -m "papersync: give Item a locator distinct from its ref"
```

---

### Task 2: The identity module

**Files:**
- Create: `src/papersync/integrations/obsidian/identity.py`
- Create: `tests/test_obsidian_identity.py`

**Interfaces:**
- Consumes: `ObsidianCli`, `ObsidianError` from `papersync.integrations.obsidian.cli`.
- Produces, all imported by Task 3:
  - `ID_PROPERTY: str` = `"papersync-id"`
  - `ALPHABET: str`, `ID_LENGTH: int` = 12, `MINT_ATTEMPTS: int` = 5
  - `IdentityError(RuntimeError)`
  - `new_id() -> str`
  - `search_paths(cli: ObsidianCli, query: str) -> list[str]`
  - `find(cli: ObsidianCli, note_id: str) -> list[str]`
  - `ensure_id(cli: ObsidianCli, path: str, meta: dict[str, Any]) -> str`

- [ ] **Step 1: Write the failing test**

Create `tests/test_obsidian_identity.py`:

```python
import json

import pytest

from papersync.integrations.obsidian import identity as I  # noqa: N812
from papersync.integrations.obsidian.cli import ObsidianCli


def _cli(runner):
    return ObsidianCli("Notes", runner=runner)


def test_new_id_has_the_right_shape() -> None:
    for _ in range(50):
        value = I.new_id()
        assert len(value) == I.ID_LENGTH
        assert set(value) <= set(I.ALPHABET)


def test_new_id_avoids_the_ambiguous_letters() -> None:
    assert set("ilou") & set(I.ALPHABET) == set()


def test_new_ids_do_not_repeat() -> None:
    assert len({I.new_id() for _ in range(1000)}) == 1000


def test_search_paths_treats_no_matches_as_an_empty_list() -> None:
    """The CLI answers a search with no hits in prose, not JSON, and not an error."""
    cli = _cli(lambda args: "No matches found.")
    assert I.search_paths(cli, 'anything') == []


def test_search_paths_returns_only_markdown_paths() -> None:
    cli = _cli(lambda args: json.dumps(["a.md", "b.canvas", {"path": "c.md"}]))
    assert I.search_paths(cli, "q") == ["a.md", "c.md"]


def test_find_queries_by_property_value() -> None:
    seen: list[list[str]] = []

    def runner(args: list[str]) -> str:
        seen.append(args)
        return json.dumps(["Notes/Alpha.md"])

    assert I.find(_cli(runner), "k7m2q9xr4tb8") == ["Notes/Alpha.md"]
    assert 'query=["papersync-id":"k7m2q9xr4tb8"]' in seen[0]
    assert "format=json" in seen[0]


def test_ensure_id_reuses_an_existing_property_without_writing() -> None:
    calls: list[list[str]] = []
    cli = _cli(lambda args: calls.append(args) or "unreachable")
    got = I.ensure_id(cli, "Notes/Alpha.md", {"papersync-id": "abcdefghjkmn"})
    assert got == "abcdefghjkmn"
    assert calls == []


def test_ensure_id_ignores_an_empty_property_and_mints() -> None:
    minted = _Minting()
    got = I.ensure_id(_cli(minted), "Notes/Alpha.md", {"papersync-id": ""})
    assert got == minted.written
    assert minted.set_calls == 1


def test_ensure_id_mints_sets_and_reads_back() -> None:
    minted = _Minting()
    got = I.ensure_id(_cli(minted), "Notes/Alpha.md", {})
    assert len(got) == I.ID_LENGTH
    assert minted.set_calls == 1
    assert minted.searched  # collision check ran before the write
    assert minted.read_back == got


def test_ensure_id_retries_when_the_first_candidate_collides() -> None:
    minted = _Minting(collide_first=1)
    got = I.ensure_id(_cli(minted), "Notes/Alpha.md", {})
    assert got == minted.written
    assert len(minted.searched) == 2
    assert minted.set_calls == 1


def test_ensure_id_gives_up_after_five_collisions() -> None:
    minted = _Minting(collide_first=I.MINT_ATTEMPTS)
    with pytest.raises(I.IdentityError, match="after 5 attempts"):
        I.ensure_id(_cli(minted), "Notes/Alpha.md", {})
    assert minted.set_calls == 0


def test_ensure_id_raises_when_the_write_does_not_stick() -> None:
    minted = _Minting(read_back_value="something-else")
    with pytest.raises(I.IdentityError, match="read back"):
        I.ensure_id(_cli(minted), "Notes/Alpha.md", {})


class _Minting:
    """A fake vault where every candidate id is free unless told otherwise."""

    def __init__(self, collide_first: int = 0, read_back_value: str | None = None) -> None:
        self.collide_first = collide_first
        self.read_back_value = read_back_value
        self.searched: list[str] = []
        self.written: str = ""
        self.set_calls = 0
        self.read_back: str = ""

    def __call__(self, args: list[str]) -> str:
        command = args[1]
        params = dict(a.split("=", 1) for a in args[2:] if "=" in a)
        if command == "search":
            self.searched.append(params["query"])
            if len(self.searched) <= self.collide_first:
                return json.dumps(["Someone/Else.md"])
            return "No matches found."
        if command == "property:set":
            self.set_calls += 1
            self.written = params["value"]
            return f"Set papersync-id: {params['value']}"
        if command == "property:read":
            self.read_back = self.read_back_value or self.written
            return self.read_back
        raise AssertionError(f"unexpected command {command}")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_obsidian_identity.py -v`
Expected: FAIL at collection with `ModuleNotFoundError: No module named 'papersync.integrations.obsidian.identity'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/papersync/integrations/obsidian/identity.py`:

```python
"""Mint and resolve the stable note id papersync writes into front matter.

Obsidian has no built-in note id: the path is the identity, so a rename
breaks every printed sheet that encodes one. papersync mints its own id as a
front matter property and puts that in the QR code instead.
"""

import json
import secrets
from typing import Any

from papersync.integrations.obsidian.cli import ObsidianCli, ObsidianError

ID_PROPERTY = "papersync-id"
# Crockford base32, lowercase. It drops i, l, o and u, so an id read off a
# printed sheet cannot be mistyped as 1/l or 0/o.
ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"
ID_LENGTH = 12
MINT_ATTEMPTS = 5
# A search that matches nothing answers in prose. It is not JSON and it does
# not carry the Error: prefix, so call_json would raise on it.
NO_MATCHES = "No matches found."


class IdentityError(RuntimeError):
    """A note's papersync-id could not be minted or confirmed."""


def new_id() -> str:
    """12 characters of Crockford base32: 60 bits from a cryptographic source."""
    return "".join(secrets.choice(ALPHABET) for _ in range(ID_LENGTH))


def search_paths(cli: ObsidianCli, query: str) -> list[str]:
    """Run a vault search and return the markdown paths it matched."""
    reply = cli.call("search", query=query, format="json")
    if reply == NO_MATCHES:
        return []
    try:
        rows: Any = json.loads(reply)
    except ValueError as exc:
        raise ObsidianError(f"search returned output that is not JSON: {reply[:120]!r}") from exc
    if isinstance(rows, dict):
        rows = rows.get("results", rows.get("files", []))
    out = []
    for row in rows:
        path = row.get("path") if isinstance(row, dict) else row
        if isinstance(path, str) and path.endswith(".md"):
            out.append(path)
    return out


def find(cli: ObsidianCli, note_id: str) -> list[str]:
    """Every note carrying ``note_id``. More than one means a duplicated note."""
    return search_paths(cli, f'["{ID_PROPERTY}":"{note_id}"]')


def ensure_id(cli: ObsidianCli, path: str, meta: dict[str, Any]) -> str:
    """Return the note's papersync-id, minting and writing one if it has none.

    The write is read back because the Obsidian CLI exits 0 whatever happens,
    so a silent no-op is otherwise indistinguishable from success.
    """
    existing = meta.get(ID_PROPERTY)
    if isinstance(existing, str) and existing:
        return existing
    for _ in range(MINT_ATTEMPTS):
        candidate = new_id()
        if find(cli, candidate):
            continue
        cli.call(
            "property:set", name=ID_PROPERTY, value=candidate, type="text", path=path
        )
        confirmed = cli.call("property:read", name=ID_PROPERTY, path=path).strip()
        if confirmed != candidate:
            raise IdentityError(
                f"set {ID_PROPERTY} on {path} but read back {confirmed!r}"
            )
        return candidate
    raise IdentityError(
        f"could not mint a unique {ID_PROPERTY} for {path} after {MINT_ATTEMPTS} attempts"
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_obsidian_identity.py -v`
Expected: PASS, 11 tests.

Then: `uv run ruff check . && uv run ruff format . && uv run ty check`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/papersync/integrations/obsidian/identity.py tests/test_obsidian_identity.py
git commit -m "papersync: mint and resolve a stable papersync-id property"
```

---

### Task 3: ObsidianSource uses ids

**Files:**
- Modify: `src/papersync/integrations/obsidian/source.py`
- Test: `tests/test_obsidian_source.py`

**Interfaces:**
- Consumes: `Item.locator` (Task 1); `identity.ID_PROPERTY`, `identity.IdentityError`, `identity.ensure_id`, `identity.find` (Task 2).
- Produces: `ObsidianSource.export` returns items with `ref` set to a minted id and `locator` set to the `.md` path. `ObsidianSource.lookup(refs)` takes ids. Tasks 4 and 5 depend on both.

**Behaviour changes to make:**

1. `export` reads a note's properties before its body, so a note being skipped as already printed is never minted into.
2. `_item` takes the already-fetched properties and calls `ensure_id`.
3. `lookup` resolves an id through `identity.find` instead of appending `.md` to the ref.
4. `IdentityError` joins `ObsidianError` in the per-note `except`, so one bad note does not abort a run.

- [ ] **Step 1: Write the failing test**

In `tests/test_obsidian_source.py`, extend `FakeVault` so it can mint. Replace the existing `FakeVault.__call__` with:

```python
    def __call__(self, args: list[str]) -> str:
        self.calls.append(args)
        command = args[1]
        params = dict(a.split("=", 1) for a in args[2:] if "=" in a)
        if command == "read":
            return self.files[params["path"]]
        if command == "properties":
            return json.dumps(self.props.get(params["path"], {}))
        if command == "search":
            query = params["query"]
            if query.startswith('["papersync-id":'):
                wanted = query.split('"')[3]
                hits = [p for p, m in self.props.items() if m.get("papersync-id") == wanted]
                return json.dumps(hits) if hits else "No matches found."
            return json.dumps(list(self.files))
        if command == "property:set":
            self.props.setdefault(params["path"], {})[params["name"]] = params["value"]
            return f"Set {params['name']}: {params['value']}"
        if command == "property:read":
            value = self.props.get(params["path"], {}).get(params["name"])
            if value is None:
                return f'Error: Property "{params["name"]}" not found.'
            return str(value)
        if command == "files":
            return "\n".join(self.files)
        if command == "base:query":
            return json.dumps([{"path": p} for p in self.files])
        raise AssertionError(f"unexpected command {command}")
```

Then replace `test_export_builds_items_with_body_and_frontmatter`, `test_lookup_returns_items_by_ref` and `test_a_missing_note_does_not_abort_the_whole_export` with the versions below, and add the rest:

```python
def test_export_builds_items_with_a_minted_id_and_a_path_locator() -> None:
    src = _source(
        {"Notes/Alpha.md": ALPHA}, {"Notes/Alpha.md": {"title": "Alpha", "tags": ["project"]}}
    )
    items = src.export("path:Notes/Alpha.md")
    assert len(items) == 1
    item = items[0]
    assert item.source == "obsidian"
    assert item.locator == "Notes/Alpha.md"
    assert len(item.ref) == 12
    assert item.title == "Alpha"
    assert item.notes.startswith("# Alpha")
    assert item.meta["title"] == "Alpha"


def test_export_reuses_an_id_the_note_already_carries() -> None:
    src = _source({"a.md": "one\n"}, {"a.md": {"papersync-id": "abcdefghjkmn"}})
    assert src.export("folder:.")[0].ref == "abcdefghjkmn"
    assert not any(c[1] == "property:set" for c in src.fake.calls)


def test_export_does_not_mint_into_a_note_it_is_skipping() -> None:
    src = _source(
        {"a.md": "one\n", "b.md": "two\n"},
        {"a.md": {"papersync-printed": "2026-09-01"}},
    )
    items = src.export("folder:.")
    assert [i.locator for i in items] == ["b.md"]
    assert src.skipped_printed == 1
    assert not any("path=a.md" in c for c in src.fake.calls if c[1] == "property:set")
    assert "papersync-id" not in src.fake.props.get("a.md", {})


def test_a_mint_failure_skips_one_note_and_lets_the_others_through() -> None:
    src = _source({"a.md": "one\n", "b.md": "two\n"})
    real = src.fake

    def runner(args: list[str]) -> str:
        if args[1] == "property:set" and "path=a.md" in args:
            return 'Error: File "a.md" is read only.'
        return real(args)

    src.cli.runner = runner
    items = src.export("folder:.")
    assert [i.locator for i in items] == ["b.md"]
    assert src.errors == ['property:set: File "a.md" is read only.']


def test_lookup_resolves_an_id_to_its_current_path() -> None:
    src = _source(
        {"Notes/Alpha.md": ALPHA},
        {"Notes/Alpha.md": {"title": "Alpha", "papersync-id": "abcdefghjkmn"}},
    )
    got = src.lookup(["abcdefghjkmn"])
    assert got["abcdefghjkmn"].title == "Alpha"
    assert got["abcdefghjkmn"].locator == "Notes/Alpha.md"


def test_lookup_reports_an_id_that_matches_nothing() -> None:
    src = _source({"a.md": "one\n"})
    assert src.lookup(["zzzzzzzzzzzz"]) == {}
    assert src.errors == ["unknown papersync-id zzzzzzzzzzzz"]


def test_lookup_refuses_to_guess_when_an_id_is_on_two_notes() -> None:
    src = _source(
        {"a.md": "one\n", "b.md": "two\n"},
        {"a.md": {"papersync-id": "abcdefghjkmn"}, "b.md": {"papersync-id": "abcdefghjkmn"}},
    )
    assert src.lookup(["abcdefghjkmn"]) == {}
    assert src.errors == [
        "papersync-id abcdefghjkmn is on more than one note: a.md, b.md"
    ]


def test_a_missing_note_does_not_abort_the_whole_export() -> None:
    src = _source({"a.md": "one\n"})
    real = src.fake

    def runner(args: list[str]) -> str:
        if args[1] == "files":
            return "a.md\nghost.md"
        if "path=ghost.md" in args:
            return 'Error: File "ghost.md" not found.'
        return real(args)

    src.cli.runner = runner
    items = src.export("folder:.")
    assert [i.locator for i in items] == ["a.md"]
    assert src.errors == ['properties: File "ghost.md" not found.']
```

The last test's expected message changes from `read:` to `properties:` because properties are now fetched first. Both commands report a missing file identically, so this is the same failure reported one call earlier.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_obsidian_source.py -v`
Expected: several FAILs, including `AssertionError` on `item.locator` and `KeyError`/`ObsidianError` in the lookup tests.

- [ ] **Step 3: Write minimal implementation**

In `src/papersync/integrations/obsidian/source.py`:

Add to the imports:

```python
from papersync.integrations.obsidian.identity import IdentityError, ensure_id, find, search_paths
```

Replace `_paths_from` with a call through to the shared helper. Delete the `_paths_from` function and change `resolve` to:

```python
    def resolve(self, selector: str) -> list[str]:
        kind, argument = parse_selector(selector)
        if kind == "path":
            return [argument]
        if kind == "folder":
            reply = self.cli.call("files", folder=argument, ext="md")
            return [line.strip() for line in reply.splitlines() if line.strip().endswith(".md")]
        if kind == "search":
            return search_paths(self.cli, argument)
        file_name, _, view = argument.partition("#")
        return _paths_in(
            self.cli.call_json("base:query", file=file_name, view=view or None, format="json")
        )
```

and add, above the class:

```python
def _paths_in(rows: Any) -> list[str]:
    """Pull the ``path`` field out of a base:query reply."""
    if isinstance(rows, dict):
        rows = rows.get("results", rows.get("files", []))
    out = []
    for row in rows:
        path = row.get("path") if isinstance(row, dict) else row
        if isinstance(path, str) and path.endswith(".md"):
            out.append(path)
    return out
```

Replace `_item`, `export` and `lookup` with:

```python
    def _item(self, path: str, meta: dict[str, Any] | None = None) -> Item:
        if meta is None:
            meta = self.cli.call_json("properties", path=path, format="json") or {}
        note_id = ensure_id(self.cli, path, meta)
        text = self.cli.call("read", path=path)
        title = str(meta.get("title") or PurePosixPath(path).stem)
        return Item(
            source=self.name,
            ref=note_id,
            title=title,
            notes=strip_frontmatter(text),
            meta=meta,
            locator=path,
        )

    def export(self, selector: str, skip_printed: bool = True) -> list[Item]:
        """Read every note the selector names, minting an id for each.

        Properties come first so a note that is skipped as already printed is
        never written to.
        """
        self.skipped_printed = 0
        self.errors = []
        items: list[Item] = []
        for path in self.resolve(selector):
            try:
                meta = self.cli.call_json("properties", path=path, format="json") or {}
                if skip_printed and PRINTED_PROPERTY in meta:
                    self.skipped_printed += 1
                    continue
                items.append(self._item(path, meta))
            except (ObsidianError, IdentityError) as exc:
                self.errors.append(str(exc))
        return items

    def lookup(self, refs: list[str]) -> dict[str, Item]:
        """Resolve minted ids to the notes that currently carry them."""
        out: dict[str, Item] = {}
        for ref in refs:
            try:
                paths = find(self.cli, ref)
            except ObsidianError as exc:
                self.errors.append(str(exc))
                continue
            if not paths:
                self.errors.append(f"unknown {ID_PROPERTY} {ref}")
                continue
            if len(paths) > 1:
                self.errors.append(
                    f"{ID_PROPERTY} {ref} is on more than one note: {', '.join(sorted(paths))}"
                )
                continue
            try:
                out[ref] = self._item(paths[0])
            except (ObsidianError, IdentityError) as exc:
                self.errors.append(str(exc))
        return out
```

Add `from papersync.integrations.obsidian.identity import ID_PROPERTY` to the identity import line so the error messages can name the property.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_obsidian_source.py -v`
Expected: PASS

Then: `uv run pytest -q`
Expected: failures only in `tests/test_cli.py` and `tests/test_obsidian_documents.py`, which Tasks 4 and 5 fix. Note which ones.

- [ ] **Step 5: Commit**

```bash
git add src/papersync/integrations/obsidian/source.py tests/test_obsidian_source.py
git commit -m "papersync: make the Obsidian ref a minted id and the locator a path"
```

---

### Task 4: Documents write the locator, not the ref

**Files:**
- Modify: `src/papersync/integrations/obsidian/documents.py`
- Test: `tests/test_obsidian_documents.py`

**Interfaces:**
- Consumes: `Item.locator` and `Item.address` (Task 1).
- Produces: nothing new. `build_spec` and `write_documents` keep their signatures.

Three places today build a path by appending `.md` to `item.ref`. All three must use `item.locator` instead: `build_spec`'s `"path"`, `write_documents`'s manifest `"path"`, and the two `DocumentRenderError` messages, which should name the locator because that is what a human can go and look at.

- [ ] **Step 1: Write the failing test**

In `tests/test_obsidian_documents.py`, change the `_item` helper to mint-shaped values:

```python
def _item(
    ref: str = "k7m2q9xr4tb8",
    title: str = "Project Alpha",
    locator: str = "Notes/Projects/Alpha.md",
) -> Item:
    return Item(
        source="obsidian",
        ref=ref,
        title=title,
        notes="# Alpha\n",
        meta={"title": title, "tags": ["a"], "papersync-printed": "2026-09-01"},
        locator=locator,
    )
```

Change the assertion in `test_build_spec_reads_its_margins_from_the_layout` from

```python
    assert spec["path"] == "Notes/Projects/Alpha.md"
```

to the same value, which now comes from the locator rather than from `ref + ".md"`, and add:

```python
def test_the_manifest_records_the_id_and_the_path_separately(tmp_path: Path) -> None:
    doc = D.RenderedDocument(_item(), chrome.blank(SIZE, 1), 1, "letter")
    target, _ = D.write_documents([doc], tmp_path, "20260912-120000", "Notes")
    manifest = json.loads((target / D.MANIFEST).read_text())
    entry = manifest["documents"][0]
    assert entry["ref"] == "k7m2q9xr4tb8"
    assert entry["path"] == "Notes/Projects/Alpha.md"


def test_the_qr_carries_the_id_and_never_the_path(tmp_path: Path) -> None:
    def fake_render(cli, spec, spec_path):
        Path(spec["out"]).write_bytes(chrome.blank(SIZE, 1))
        return 1

    docs = D.render_documents(
        cli=None,
        items=[_item()],
        size=SIZE,
        labels=["A"],
        boxes_id=1,
        skip=[],
        today=TODAY,
        workdir=tmp_path / "work",
        renderer=fake_render,
    )
    text = pymupdf.open("pdf", docs[0].pdf)[0].get_text()
    assert "Notes/Projects" not in text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_obsidian_documents.py -v`
Expected: FAIL on `spec["path"]`, which is `"k7m2q9xr4tb8.md"`.

- [ ] **Step 3: Write minimal implementation**

In `src/papersync/integrations/obsidian/documents.py`:

In `build_spec`, change

```python
        "path": f"{item.ref}.md",
```

to

```python
        "path": item.locator,
```

In `render_documents`, change both error messages from `{item.ref!r}` to `{item.locator!r}`.

In `write_documents`, change

```python
                "path": f"{doc.item.ref}.md",
```

to

```python
                "path": doc.item.locator,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_obsidian_documents.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/papersync/integrations/obsidian/documents.py tests/test_obsidian_documents.py
git commit -m "papersync: address notes by locator when rendering documents"
```

---

### Task 5: The CLI tags by address

**Files:**
- Modify: `src/papersync/cli.py`
- Test: `tests/test_cli.py`

**Interfaces:**
- Consumes: `Item.address` (Task 1), `ObsidianSource` with id refs (Task 3).
- Produces: nothing new.

Three edits, plus two help-text edits the spec requires:

1. `_do_render` collects `r.item.address` instead of `r.item.ref` into `by_source`. Things is unaffected because `address` falls back to `ref`.
2. `obsidian_print` passes `[d.item.address for d in docs]` to `_tag_printed`.
3. `_tag_printed`'s parameter is renamed from `refs_by_source` to `addresses_by_source`, and the `NOT TAGGED:` loop variable from `ref` to `address`. The ledger keeps recording `doc.item.ref`, which is the id: do not change it.
4. `obsidian_export`'s docstring gains the minting warning.
5. The `--tag/--no-tag` help string gains the narrower meaning.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_cli.py`, following the file's existing runner-fake conventions:

```python
def test_obsidian_print_tags_by_path_and_ledgers_by_id(tmp_path, monkeypatch) -> None:
    """The ledger must record the durable id; property:set needs the live path."""
    from papersync import cli as cli_mod
    from papersync.model import Item

    tagged: list[list[str]] = []

    class FakeSink:
        name = "obsidian"
        marker = "papersync-printed"
        warnings: list[str] = []

        def mark_printed(self, addresses: list[str]) -> list[str]:
            tagged.append(addresses)
            return []

    item = Item(
        source="obsidian",
        ref="k7m2q9xr4tb8",
        title="Alpha",
        locator="Notes/Alpha.md",
    )
    monkeypatch.setattr(cli_mod, "_sinks", lambda cfg: {"obsidian": FakeSink})
    cli_mod._tag_printed(load_config(), {"obsidian": [item.address]})
    assert tagged == [["Notes/Alpha.md"]]
```

Adapt the import and config lines to whatever `tests/test_cli.py` already uses for `load_config` and module access; do not introduce a second style.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_cli.py -v -k obsidian`
Expected: the new test FAILs, and existing Obsidian print tests fail on the ref/path change from Task 3.

- [ ] **Step 3: Write minimal implementation**

In `src/papersync/cli.py`:

```python
def _tag_printed(cfg: Config, addresses_by_source: dict[str, list[str]]) -> None:
    for source, addresses in addresses_by_source.items():
        factory = _sinks(cfg).get(source)
        if factory is None or not addresses:
            continue
        sink = factory()
        try:
            untagged = sink.mark_printed(addresses)
        except (RuntimeError, ObsidianError) as exc:
            raise click.ClickException(str(exc)) from exc
        for warning in sink.warnings:
            _err(f"WARNING: {warning}")
        for address in untagged:
            _err(f"NOT TAGGED: {address}")
        _err(f"set {sink.marker} on {len(addresses) - len(untagged)} {source} item(s)")
```

In `_do_render`, change `by_source.setdefault(r.item.source, []).append(r.item.ref)` to `.append(r.item.address)`.

In `obsidian_print`, change the final line to:

```python
        _tag_printed(cfg, {"obsidian": [d.item.address for d in docs]})
```

Change `obsidian_export`'s docstring to:

```python
    """Export notes as JSON: search:<query> | base:<file>[#view] | path:<p> | folder:<p>.

    Mints a papersync-id property on any note that lacks one, so the vault is
    modified.
    """
```

Find the `--tag/--no-tag` option in `_render_common` and change its help text to end with `(a papersync-id is still minted)`.

Update any existing test in `tests/test_cli.py` that asserts on an Obsidian ledger ref or a `property:set` path so it expects an id ref and a path address.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest -q`
Expected: PASS, whole suite.

Then: `uv run ruff check . && uv run ruff format . && uv run ty check`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/papersync/cli.py tests/test_cli.py
git commit -m "papersync: tag notes by address and ledger them by id"
```

---

### Task 6: Sink docstring and README

**Files:**
- Modify: `src/papersync/integrations/obsidian/sink.py`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above. Produces: nothing.

`ObsidianSink.mark_printed` needs no code change. Its parameter is already a list of strings passed straight to `path=f"{ref}.md"` — and that is now wrong, because it receives a full path with the extension already on it.

- [ ] **Step 1: Write the failing test**

Change `test_mark_printed_sets_a_dated_property_on_each_note` in `tests/test_obsidian_sink.py` to pass paths:

```python
def test_mark_printed_sets_a_dated_property_on_each_note() -> None:
    calls, sink = _sink()
    assert sink.mark_printed(["Notes/Alpha.md", "Notes/Beta.md"]) == []
    assert calls[0] == [
        "vault=Notes",
        "property:set",
        "name=papersync-printed",
        "value=2026-09-12",
        "type=date",
        "path=Notes/Alpha.md",
    ]
    assert len(calls) == 2
    assert sink.warnings == []
```

and `test_mark_printed_reports_the_refs_it_could_not_tag`:

```python
def test_mark_printed_reports_the_paths_it_could_not_tag() -> None:
    _, sink = _sink({"path=Notes/Ghost.md": 'Error: File "Notes/Ghost.md" not found.'})
    assert sink.mark_printed(["Notes/Alpha.md", "Notes/Ghost.md"]) == ["Notes/Ghost.md"]
    assert any("Notes/Ghost" in w for w in sink.warnings)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_obsidian_sink.py -v`
Expected: FAIL, `path=Notes/Alpha.md.md`.

- [ ] **Step 3: Write minimal implementation**

In `src/papersync/integrations/obsidian/sink.py`, replace `mark_printed` with:

```python
    def mark_printed(self, addresses: list[str]) -> list[str]:
        """Set the printed property on each note path. Returns the ones that failed.

        The argument is a note path, not a papersync-id: ``property:set``
        addresses a file, and the id is only what the QR code carries.
        """
        self.warnings = []
        failed: list[str] = []
        for path in addresses:
            try:
                self.cli.call(
                    "property:set",
                    name=PRINTED_PROPERTY,
                    value=self.today.isoformat(),
                    type="date",
                    path=path,
                )
            except ObsidianError as exc:
                self.warnings.append(f"{path}: {exc}")
                failed.append(path)
        return failed
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest -q`
Expected: PASS, whole suite.

- [ ] **Step 5: Update the README**

In the "Obsidian documents" section of `README.md`, add this paragraph after the description of `papersync-printed`:

```markdown
papersync also writes a `papersync-id` property: twelve characters that
identify the note in the QR code. The path is not used as an identity,
because renaming a note would break every sheet already printed from it.
The id is minted the first time papersync exports or prints a note, and
never changes after that. `--no-tag` skips `papersync-printed` so the note
stays reprintable, but it does not skip the id.
```

- [ ] **Step 6: Commit**

```bash
git add src/papersync/integrations/obsidian/sink.py tests/test_obsidian_sink.py README.md
git commit -m "papersync: address the printed property by path and document the id"
```

---

### Task 7: Live verification on a disposable note

**Files:**
- No source changes. This task verifies the whole feature against the real vault.

**Interfaces:**
- Consumes: everything above. Produces: a report, and a vault that is provably clean.

The user's constraint is absolute: when this task ends, no note in the vault carries `papersync-printed` or `papersync-id`. Never select an existing note. Create one, use it, delete it permanently.

Before starting, confirm the vault is clean:

```bash
obsidian vault=Notes properties counts format=json | grep -A 3 papersync
```

Every `papersync-*` entry must show `"count": 0`. Obsidian keeps a property name in its type registry after the last note using it is gone, so a name with count 0 is expected residue and is not a failure.

- [ ] **Step 1: Create the test note**

```bash
obsidian vault=Notes create path="papersync-live-test.md" \
  content='---\ntitle: Live Test\ntags:\n  - papersync\n---\n\n# Live Test\n\nFirst paragraph.\n\n## Section\n\nSecond paragraph with **bold** and a [[wikilink]].\n'
```

- [ ] **Step 2: Print it**

```bash
cd /Users/jacob/.dotfiles/local/lib/papersync
uv run papersync obsidian print path:papersync-live-test.md --output-dir /tmp/papersync-live
```

Expected: one PDF written, and a line reporting `set papersync-printed on 1 obsidian item(s)`.

- [ ] **Step 3: Confirm the id was minted and reached the QR**

```bash
obsidian vault=Notes property:read name=papersync-id path="papersync-live-test.md"
```

Record the value. Then read the manifest:

```bash
cat /tmp/papersync-live/papersync-*/manifest.json
```

Expected: `ref` equals the value from `property:read`, and `path` equals `papersync-live-test.md`.

- [ ] **Step 4: Rename the note**

```bash
obsidian vault=Notes rename path="papersync-live-test.md" name="papersync-live-renamed"
```

- [ ] **Step 5: Scan the printed sheet and confirm it still resolves**

Rasterize the PDF, distort and blur it, and run it through `papersync scan`, using the same harness the earlier Obsidian live verification used (see `tests/test_chrome_roundtrip.py` for the rasterize-and-distort helpers).

Expected: the scan resolves the ref to `papersync-live-renamed.md` with zero errors. This is the test the path-based design could not pass, so it is the acceptance criterion for the whole plan. If it fails, stop and report; do not delete the note until the failure is understood.

- [ ] **Step 6: Delete the note and prove the vault is clean**

```bash
obsidian vault=Notes delete path="papersync-live-renamed.md" permanent
obsidian vault=Notes search query='["papersync-id"]' format=json
obsidian vault=Notes search query='["papersync-printed"]' format=json
obsidian vault=Notes properties counts format=json | grep -A 3 papersync
rm -rf /tmp/papersync-live
```

Expected: both searches answer `No matches found.`, and every `papersync-*` property shows `"count": 0`.

- [ ] **Step 7: Drop the stale ledger entry**

The earlier Obsidian live test left a `render` entry whose ref is a path. Find it and forget it:

```bash
uv run papersync status
uv run papersync status --forget "<the path-shaped ref>" --source obsidian
uv run papersync status
```

Expected: no outstanding Obsidian cards remain.

- [ ] **Step 8: Run the full check and commit**

```bash
/Users/jacob/.dotfiles/script/test
```

Expected: green.

There is nothing to commit unless Step 5 turned up a defect. If it did, fix it, add a regression test, and commit that.

---

## Self-Review

**Spec coverage.** Identity shape and alphabet: Task 2. Payload size: falls out of Task 3, asserted in Task 4's QR test. `Item` locator: Task 1. Minting rules including read-back and five attempts: Task 2. Which commands mint: Task 3 for `export`, Task 5 for the help text. `--no-tag` interaction: Task 5. Lookup with zero, one and many hits: Task 3. Sink: Task 6. No migration: Task 7 Step 7. Vault hygiene: Task 7 Steps 1, 6. Error table: Tasks 2 and 3. Testing: every task, with the acceptance test in Task 7.

**Placeholders.** One deliberate instruction rather than a placeholder: Task 5 Step 1 says to match `tests/test_cli.py`'s existing fixture style rather than prescribing an import line, because that file is 20 KB and its conventions are local. Task 7 Step 5 points at `tests/test_chrome_roundtrip.py` for the rasterize helpers rather than restating them.

**Type consistency.** `ensure_id(cli, path, meta) -> str` in Task 2 matches its call in Task 3. `find(cli, note_id) -> list[str]` matches. `search_paths(cli, query) -> list[str]` is produced in Task 2 and consumed by `resolve` in Task 3. `Item.address` is defined in Task 1 and used in Tasks 5 and 6. `mark_printed(addresses)` in Task 6 matches what `_tag_printed` sends in Task 5.

**One name collision to watch.** Task 3 renames `_paths_from` to `_paths_in` and narrows it to `base:query`, because search now goes through `identity.search_paths`. If a later reader finds both, the duplicate was not deleted.

---

### Task 8: Route scanned-page lookup by payload source

**Added during execution.** Task 7's live verification exposed a defect this plan
missed. `_recognize` in `src/papersync/cli.py` hardcoded `ThingsSource(_db()).lookup`
as the only lookup passed to `recognize_pages`, so every scanned page was looked up in
the Things database whatever its payload said. `ObsidianSource.lookup`, built and
tested in Task 3, was dead code, and no Obsidian sheet could ever resolve. The printed
page decoded its QR correctly to the minted id and then failed with
`unknown item 017f9y54a0af`.

The defect predates this plan, but the spec's acceptance criterion cannot pass without
fixing it, and shipping `papersync-id` without it would mean a note can be printed with
an id and never scanned back.

**Files:**
- Modify: `src/papersync/recognize/assemble.py`
- Modify: `src/papersync/cli.py`
- Test: `tests/test_assemble.py`, `tests/test_cli.py`, `tests/test_chrome_roundtrip.py`

**What was built:**

`recognize_pages`'s `lookup` parameter became
`Callable[[str, list[str]], dict[str, Item]]`, taking the source name first, and its
call site became `lookup(payload.source, [payload.ref]).get(payload.ref)`.

`_recognize` builds a dispatcher that constructs each source at most once, lazily:
`ThingsSource(_db()).lookup` for `things`, `ObsidianSource(ObsidianCli(vault)).lookup`
for `obsidian` when a vault is configured, and `{}` for anything else, so an
unconfigured or unknown source yields the existing `unknown item <ref>` page error
rather than a crash. Afterwards it surfaces `ObsidianSource.errors` through `_err`,
because `lookup` appends rather than raises and those messages are the only diagnostic
saying why a page failed.

Commit: `7a16561`.
