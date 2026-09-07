from datetime import date, datetime

from papersync.model import Change, Plan, scanned_block


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
