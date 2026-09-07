from datetime import date, datetime

from papersync.display import format_plan
from papersync.model import BoxResult, Change, Plan, PlanError, scanned_block


def test_format_plan() -> None:
    bar = Change(
        kind="update",
        source="things",
        ref="U2",
        title="BAR",
        marks=["today"],
        boxes={"waiting": BoxResult(fill=0.31, checked=False, uncertain=True)},
        append_notes=scanned_block("some handwriting", date(2026, 9, 7)),
        pages=[2, 3],
    )
    foo = Change(
        kind="update", source="things", ref="U1", title="FOO", complete=True, marks=["A"], pages=[1]
    )
    new = Change(kind="create", source="things", title="Call mom", notes="about sunday", pages=[4])
    plan = Plan(
        created=datetime(2026, 9, 7),
        inputs=["s.pdf"],
        changes=[foo, bar, new],
        errors=[PlanError(page=5, message="corner marks not found")],
    )

    def describe(ch: Change) -> list[str]:
        return (["+ completed"] if ch.complete else []) + [f"+ {m:<8} tag x" for m in ch.marks]

    out = format_plan(plan, describe, lambda ch: "BAZ" if ch.ref == "U2" else "")
    assert out == (
        "FOO  things:///show?id=U1  (page 1)\n"
        "+ completed\n"
        "+ A        tag x\n"
        "\n"
        "BAR  things:///show?id=U2  (pages 2-3)\n"
        "+ today    tag x\n"
        "? waiting  fill 0.31, treated as unchecked\n"
        "--- notes\n"
        "+++ notes\n"
        "@@ -1 +1,5 @@\n"
        " BAZ\n"
        "+\n"
        "+## Scanned 2026-09-07\n"
        "+\n"
        "+> some handwriting\n"
        "\n"
        "NEW  Call mom  (page 4)\n"
        "+ notes: about sunday\n"
        "\n"
        "ERROR page 5: corner marks not found\n"
    )


def test_format_plan_empty() -> None:
    plan = Plan(created=datetime(2026, 9, 7), inputs=[], changes=[], errors=[])
    out = format_plan(plan, lambda ch: [], lambda ch: "")
    assert out == ""


def test_header_omits_trailing_whitespace_when_pages_missing() -> None:
    foo = Change(kind="update", source="things", ref="U1", title="FOO", pages=[])
    plan = Plan(created=datetime(2026, 9, 7), inputs=[], changes=[foo], errors=[])
    out = format_plan(plan, lambda ch: [], lambda ch: "")
    assert out == "FOO  things:///show?id=U1\n"


def test_create_header_omits_trailing_whitespace_when_pages_and_notes_missing() -> None:
    new = Change(kind="create", source="things", title="Call mom", pages=[])
    plan = Plan(created=datetime(2026, 9, 7), inputs=[], changes=[new], errors=[])
    out = format_plan(plan, lambda ch: [], lambda ch: "")
    assert out == "NEW  Call mom\n"
