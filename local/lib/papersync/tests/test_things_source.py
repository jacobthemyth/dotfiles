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
