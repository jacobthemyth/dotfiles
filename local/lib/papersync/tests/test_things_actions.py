from papersync.config import Action, ThingsConfig
from papersync.integrations.things.actions import resolve
from papersync.model import Change


def _change(marks: list[str], complete: bool = False) -> Change:
    return Change(
        kind="update", source="things", ref="U", title="t", marks=marks, complete=complete
    )


def test_default_tag() -> None:
    upd, warnings = resolve(_change(["A"]), ThingsConfig())
    assert upd.tags == ["papersync:meta:A"] and warnings == []


def test_configured_actions_and_done_box() -> None:
    cfg = ThingsConfig(actions={"today": Action(when="today"), "waiting": Action(tags=["waiting"])})
    upd, _ = resolve(_change(["today", "waiting"], complete=True), cfg)
    assert upd.when == "today" and upd.tags == ["waiting"] and upd.completed


def test_conflict_last_wins_with_warning() -> None:
    cfg = ThingsConfig(actions={"today": Action(when="today"), "someday": Action(when="someday")})
    upd, warnings = resolve(_change(["today", "someday"]), cfg)
    assert upd.when == "someday"
    assert warnings == ["'someday' overrides when=today set by 'today'"]
