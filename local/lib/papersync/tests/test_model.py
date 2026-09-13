from datetime import date, datetime

from papersync.model import Change, Item, Plan, scanned_block


def test_plan_round_trip() -> None:
    plan = Plan(
        created=datetime(2026, 9, 7, 10, 0),
        inputs=["scan.pdf"],
        changes=[Change(kind="update", source="things", ref="U1", title="FOO", marks=["A"])],
        errors=[],
    )
    text = plan.to_json()
    assert '"papersync_plan": 1' in text
    assert Plan.from_json(text) == plan


def test_from_json_reports_field_path() -> None:
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError) as info:
        Plan.from_json(
            '{"papersync_plan": 1, "created": "x", "inputs": [], "changes": [], "errors": []}'
        )
    assert "created" in str(info.value)


def test_scanned_block() -> None:
    assert (
        scanned_block("one\ntwo", date(2026, 9, 7)) == "\n\n## Scanned 2026-09-07\n\n> one\n> two"
    )


def test_item_meta_defaults_to_empty_and_round_trips() -> None:
    from papersync.model import Item

    plain = Item(source="things", ref="T1", title="Foo")
    assert plain.meta == {}

    rich = Item(
        source="obsidian",
        ref="Notes/Alpha",
        title="Alpha",
        meta={"tags": ["project", "active"], "status": "open"},
    )
    assert Item.model_validate_json(rich.model_dump_json()) == rich


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
