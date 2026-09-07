from pathlib import Path

from papersync.integrations.things.db import ThingsDb
from papersync.integrations.things.source import ThingsSource
from tests.things_fixture import make_db


def test_export_and_lookup(tmp_path: Path) -> None:
    src = ThingsSource(ThingsDb(make_db(tmp_path / "main.sqlite")))
    items = src.export("next")
    assert [(i.ref, i.title, i.notes) for i in items] == [("T2", "BAR", "BAZ"), ("T6", "Dated", "")]
    assert items[0].source == "things"
    assert src.lookup(["T1"])["T1"].title == "FOO"


def test_export_skips_printed_items_by_default(tmp_path: Path) -> None:
    import sqlite3

    db_path = make_db(tmp_path / "main.sqlite")
    with sqlite3.connect(db_path) as c:
        c.execute("INSERT INTO TMTag VALUES ('G5', 'papersync:printed')")
        c.execute("INSERT INTO TMTaskTag VALUES ('T6', 'G5')")
    src = ThingsSource(ThingsDb(db_path))
    assert [i.ref for i in src.export("next")] == ["T2"]
    assert src.skipped_printed == 1
    assert [i.ref for i in src.export("next", skip_printed=False)] == ["T2", "T6"]
    assert src.skipped_printed == 0
