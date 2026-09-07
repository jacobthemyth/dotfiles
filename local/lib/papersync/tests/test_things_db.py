from datetime import date
from pathlib import Path

import pytest

from papersync.integrations.things.db import ThingsDb, pack_date, unpack_date
from tests.things_fixture import make_db


@pytest.fixture
def db(tmp_path: Path) -> ThingsDb:
    return ThingsDb(make_db(tmp_path / "main.sqlite"))


def test_dates() -> None:
    assert pack_date(date(2026, 9, 7)) == (2026 << 16) | (9 << 12) | (7 << 7)
    assert unpack_date(pack_date(date(2026, 9, 7))) == date(2026, 9, 7)
    assert unpack_date(None) is None


def test_select_inbox(db: ThingsDb) -> None:
    assert [t.uuid for t in db.select("inbox")] == ["T1"]


def test_select_next_includes_project_tasks(db: ThingsDb) -> None:
    assert [t.uuid for t in db.select("next")] == ["T2", "T6"]


def test_select_someday_and_project(db: ThingsDb) -> None:
    assert [t.uuid for t in db.select("someday")] == ["T3"]
    assert [t.uuid for t in db.select("things:///show?id=P1")] == ["T2"]


def test_select_rejects_unknown(db: ThingsDb) -> None:
    with pytest.raises(ValueError):
        db.select("bogus")


def test_get_includes_tags_and_dates(db: ThingsDb) -> None:
    t2 = db.get("T2")
    assert t2 is not None and t2.tags == ["waiting"] and t2.notes == "BAZ"
    t1 = db.get("T1")
    assert t1 is not None and t1.tags == ["papersync:meta:A", "papersync:scanned"]
    t6 = db.get("T6")
    assert t6 is not None and t6.start_date == date(2026, 9, 7) and t6.deadline == date(2026, 9, 10)
    assert db.get("nope") is None
    assert set(db.get_many(["T1", "T2", "zz"])) == {"T1", "T2"}


def test_tag_titles(db: ThingsDb) -> None:
    assert db.tag_titles() == {"waiting", "papersync:meta:A", "papersync:scanned"}
