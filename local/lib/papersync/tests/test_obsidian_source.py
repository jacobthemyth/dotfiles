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
            return json.dumps(list(self.files))
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


def test_parse_selector_accepts_the_four_forms() -> None:
    assert parse_selector("search:tag:#project") == ("search", "tag:#project")
    assert parse_selector("base:Reading.base#Queue") == ("base", "Reading.base#Queue")
    assert parse_selector("path:Notes/Alpha.md") == ("path", "Notes/Alpha.md")
    assert parse_selector("folder:Notes/Projects") == ("folder", "Notes/Projects")


def test_parse_selector_rejects_an_unknown_prefix() -> None:
    with pytest.raises(ValueError, match="search:"):
        parse_selector("tag:#project")


def test_export_builds_items_with_body_and_frontmatter() -> None:
    src = _source(
        {"Notes/Alpha.md": ALPHA}, {"Notes/Alpha.md": {"title": "Alpha", "tags": ["project"]}}
    )
    items = src.export("path:Notes/Alpha.md")
    assert len(items) == 1
    item = items[0]
    assert item.source == "obsidian"
    assert item.ref == "Notes/Alpha"
    assert item.title == "Alpha"
    assert item.notes.startswith("# Alpha")
    assert item.meta == {"title": "Alpha", "tags": ["project"]}


def test_title_falls_back_to_the_basename_when_there_is_no_title_property() -> None:
    src = _source({"Notes/Some Note.md": "body only\n"})
    assert src.export("path:Notes/Some Note.md")[0].title == "Some Note"


def test_export_skips_notes_already_marked_printed() -> None:
    src = _source(
        {"a.md": "one\n", "b.md": "two\n"},
        {"a.md": {"papersync-printed": "2026-09-01"}},
    )
    assert [i.ref for i in src.export("folder:.")] == ["b"]
    assert src.skipped_printed == 1
    assert [i.ref for i in src.export("folder:.", skip_printed=False)] == ["a", "b"]
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


def test_lookup_returns_items_by_ref() -> None:
    src = _source({"Notes/Alpha.md": ALPHA}, {"Notes/Alpha.md": {"title": "Alpha"}})
    got = src.lookup(["Notes/Alpha"])
    assert got["Notes/Alpha"].title == "Alpha"


def test_a_missing_note_does_not_abort_the_whole_export() -> None:
    src = _source({"a.md": "one\n"})

    def runner(args: list[str]) -> str:
        if args[1] == "files":
            return "a.md\nghost.md"
        if "path=ghost.md" in args:
            return 'Error: File "ghost.md" not found.'
        return src.fake(args)

    src.cli.runner = runner
    items = src.export("folder:.")
    assert [i.ref for i in items] == ["a"]
    assert src.errors == ['read: File "ghost.md" not found.']
