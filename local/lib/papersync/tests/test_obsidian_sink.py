from datetime import date

import pytest

from papersync.integrations.obsidian.cli import ObsidianCli, ObsidianError
from papersync.integrations.obsidian.sink import ObsidianSink
from papersync.model import Change

TODAY = date(2026, 9, 12)


def _sink(replies: dict[str, str] | None = None) -> tuple[list[list[str]], ObsidianSink]:
    calls: list[list[str]] = []
    replies = replies or {}

    def runner(args: list[str]) -> str:
        calls.append(args)
        for needle, reply in replies.items():
            if any(needle in a for a in args):
                return reply
        return "ok"

    return calls, ObsidianSink(ObsidianCli("Notes", runner=runner), today=TODAY)


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


def test_mark_printed_reports_the_paths_it_could_not_tag() -> None:
    _, sink = _sink({"path=Notes/Ghost.md": 'Error: File "Notes/Ghost.md" not found.'})
    assert sink.mark_printed(["Notes/Alpha.md", "Notes/Ghost.md"]) == ["Notes/Ghost.md"]
    assert any("Notes/Ghost" in w for w in sink.warnings)


def test_check_reports_a_reachable_vault() -> None:
    _, sink = _sink({"vault": "Notes"})
    assert sink.check() == []


def test_check_reports_an_unreachable_vault() -> None:
    _, sink = _sink({"vault": "Error: no vault"})
    assert sink.check() == ["vault: no vault"]


def test_check_preserves_a_bare_error_message() -> None:
    """run_obsidian raises bare ObsidianErrors with no ``command: `` prefix at
    all, e.g. when the binary is missing or the call times out. check() must
    not assume every ObsidianError is shaped ``"{command}: {detail}"`` and
    must pass such a message through unchanged rather than mangling it."""

    def runner(args: list[str]) -> str:
        raise ObsidianError("the obsidian CLI is not on PATH")

    sink = ObsidianSink(ObsidianCli("Notes", runner=runner), today=TODAY)
    assert sink.check() == ["the obsidian CLI is not on PATH"]


def test_describe_names_the_note_and_its_marks() -> None:
    _, sink = _sink()
    change = Change(kind="update", source="obsidian", ref="Notes/Alpha", title="Alpha", marks=["B"])
    assert sink.describe(change) == ["mark B"]


def test_apply_and_verify_refuse_until_the_importer_exists() -> None:
    _, sink = _sink()
    with pytest.raises(NotImplementedError, match="importer"):
        sink.apply([])
    with pytest.raises(NotImplementedError, match="importer"):
        sink.verify([])
