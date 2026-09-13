import json

import pytest

from papersync.integrations.obsidian.cli import ObsidianCli
from papersync.integrations.obsidian.source import (
    ObsidianSource,
    parse_selector,
    strip_frontmatter,
)

ALPHA = """---
title: Alpha
tags:
  - project
---

# Alpha

Body text.
"""


class FakeVault:
    """Replays canned replies and records the commands it was asked for."""

    def __init__(self, files: dict[str, str], props: dict[str, dict]) -> None:
        self.files = files
        self.props = props
        self.calls: list[list[str]] = []

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


class _TestSource(ObsidianSource):
    """An ObsidianSource with its FakeVault attached, for call inspection."""

    fake: FakeVault


def _source(files: dict[str, str], props: dict[str, dict] | None = None) -> _TestSource:
    fake = FakeVault(files, props or {})
    src = _TestSource(ObsidianCli("Notes", runner=fake))
    src.fake = fake
    return src


def test_strip_frontmatter_removes_only_a_leading_block() -> None:
    assert strip_frontmatter(ALPHA).startswith("# Alpha")
    assert (
        strip_frontmatter("no frontmatter\n---\nnot a block\n")
        == "no frontmatter\n---\nnot a block\n"
    )
    assert strip_frontmatter("---\na: 1\n---\n") == ""


def test_strip_frontmatter_tolerates_crlf_line_endings() -> None:
    crlf = ALPHA.replace("\n", "\r\n")
    assert strip_frontmatter(crlf).startswith("# Alpha")
    assert "title: Alpha" not in strip_frontmatter(crlf)


def test_parse_selector_accepts_the_four_forms() -> None:
    assert parse_selector("search:tag:#project") == ("search", "tag:#project")
    assert parse_selector("base:Reading.base#Queue") == ("base", "Reading.base#Queue")
    assert parse_selector("path:Notes/Alpha.md") == ("path", "Notes/Alpha.md")
    assert parse_selector("folder:Notes/Projects") == ("folder", "Notes/Projects")


def test_parse_selector_rejects_an_unknown_prefix() -> None:
    with pytest.raises(ValueError, match="search:"):
        parse_selector("tag:#project")


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


def test_title_falls_back_to_the_basename_when_there_is_no_title_property() -> None:
    src = _source({"Notes/Some Note.md": "body only\n"})
    assert src.export("path:Notes/Some Note.md")[0].title == "Some Note"


def test_export_skips_notes_already_marked_printed() -> None:
    src = _source(
        {"a.md": "one\n", "b.md": "two\n"},
        {"a.md": {"papersync-printed": "2026-09-01"}},
    )
    assert [i.locator for i in src.export("folder:.")] == ["b.md"]
    assert src.skipped_printed == 1
    assert [i.locator for i in src.export("folder:.", skip_printed=False)] == ["a.md", "b.md"]
    assert src.skipped_printed == 0


def test_base_selector_splits_the_view_off_the_file() -> None:
    src = _source({"a.md": "one\n"})
    src.export("base:Reading.base#Queue")
    base_call = next(c for c in src.fake.calls if c[1] == "base:query")
    assert "file=Reading.base" in base_call and "view=Queue" in base_call


def test_search_selector_passes_the_query_through_unchanged() -> None:
    src = _source({"a.md": "one\n"})
    src.export("search:tag:#project -path:Archive")
    call = next(c for c in src.fake.calls if c[1] == "search")
    assert "query=tag:#project -path:Archive" in call


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
    assert src.errors == ["papersync-id abcdefghjkmn is on more than one note: a.md, b.md"]


def test_lookup_rejects_a_malformed_ref_without_querying_the_vault() -> None:
    """A ref that is not id-shaped must fail closed, not reach the search query.

    Refs come from a decoded QR; an id-shaped check catches corruption (and
    injection into the search query) before it ever reaches the CLI.
    """
    src = _source({"a.md": "one\n"})
    got = src.lookup(["short"])
    assert got == {}
    assert src.errors == ["malformed papersync-id 'short'"]
    assert src.fake.calls == []


def test_lookup_rejects_a_ref_with_invalid_characters_without_querying_the_vault() -> None:
    src = _source({"a.md": "one\n"})
    bad = '"' * 12  # right length, would otherwise be interpolated straight into the query
    got = src.lookup([bad])
    assert got == {}
    assert src.errors == [f"malformed papersync-id {bad!r}"]
    assert src.fake.calls == []


def test_lookup_does_not_mint_when_the_property_no_longer_matches_after_the_search() -> None:
    """A stale search index must never cause lookup to mint a fresh id.

    ``find`` resolves the ref to a path, but if the note's property has
    since changed, lookup must re-check it and fail rather than call
    ``_item`` (which would mint a brand new id and silently replace the
    note's durable identity).
    """
    src = _source({"a.md": "one\n"}, {"a.md": {"papersync-id": "zzzzzzzzzzzz"}})
    real = src.fake

    def runner(args: list[str]) -> str:
        if args[1] == "search":
            return json.dumps(["a.md"])  # stale: claims a.md carries our ref
        return real(args)

    src.cli.runner = runner
    got = src.lookup(["abcdefghjkmn"])
    assert got == {}
    assert src.errors == ["papersync-id abcdefghjkmn no longer matches the property on a.md"]
    assert not any(c[1] == "property:set" for c in src.fake.calls)


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
