import sqlite3
import subprocess
from datetime import date
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from papersync.config import Action, ThingsConfig
from papersync.integrations.things.db import ThingsDb
from papersync.integrations.things.sink import (
    STATE_PRINTED,
    STATE_SCANNED,
    ThingsSink,
    create_tags_script,
)
from papersync.model import Change, scanned_block
from tests.things_fixture import make_db


class Captured:
    def __init__(self) -> None:
        self.urls: list[str] = []
        self.scripts: list[str] = []


@pytest.fixture
def cap() -> Captured:
    return Captured()


@pytest.fixture
def sink(tmp_path: Path, cap: Captured) -> ThingsSink:
    cfg = ThingsConfig(
        actions={"today": Action(when="today"), "due": Action(deadline="2026-09-10")}
    )
    return ThingsSink(
        ThingsDb(make_db(tmp_path / "main.sqlite")),
        cfg,
        opener=cap.urls.append,
        token_provider=lambda: "TOK",
        sleeper=lambda _s: None,
        runner=cap.scripts.append,
    )


def _q(url: str) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}


def test_update_url_replaces_tags_and_sets_scanned(sink: ThingsSink, cap: Captured) -> None:
    # T1 currently has papersync:meta:A and papersync:scanned
    ch = Change(
        kind="update",
        source="things",
        ref="T1",
        title="FOO",
        complete=True,
        marks=["B", "today"],
        append_notes=scanned_block("hi there", date(2026, 9, 7)),
    )
    sink.apply([ch])
    assert len(cap.urls) == 1 and cap.urls[0].startswith("things:///update?")
    q = _q(cap.urls[0])
    assert q["id"] == "T1" and q["auth-token"] == "TOK" and q["completed"] == "true"
    assert q["tags"] == "papersync:meta:A,papersync:meta:B,papersync:scanned"
    assert q["when"] == "today"
    assert q["append-notes"] == "\n\n## Scanned 2026-09-07\n\n> hi there"
    assert "add-tags" not in q


def test_swaps_printed_for_scanned(sink: ThingsSink, cap: Captured) -> None:
    # T2 has only "waiting"; give it the printed state first
    sink.mark_printed(["T2"])
    assert _q(cap.urls[0])["tags"] == f"waiting,{STATE_PRINTED}"
    with sqlite3.connect(sink.db.path) as c:
        c.execute("INSERT INTO TMTag VALUES ('G4', ?)", (STATE_PRINTED,))
        c.execute("INSERT INTO TMTaskTag VALUES ('T2', 'G4')")
    sink.apply([Change(kind="update", source="things", ref="T2", title="BAR")])
    assert _q(cap.urls[1])["tags"] == f"waiting,{STATE_SCANNED}"


def test_skips_what_already_holds(sink: ThingsSink, cap: Captured) -> None:
    # T1 already has tag papersync:meta:A and scanned; T4 is complete and scanned;
    # T6 has deadline 2026-09-10 and scanned
    sink.apply(
        [
            Change(kind="update", source="things", ref="T1", title="FOO", marks=["A"]),
            Change(kind="update", source="things", ref="T4", title="Done", complete=True),
            Change(kind="update", source="things", ref="T6", title="Dated", marks=["due"]),
        ]
    )
    assert cap.urls == [] and cap.scripts == []


def test_skips_notes_block_already_present(tmp_path: Path, cap: Captured) -> None:
    db_path = make_db(tmp_path / "main.sqlite")
    block = scanned_block("x", date(2026, 9, 7))
    with sqlite3.connect(db_path) as c:
        c.execute("UPDATE TMTask SET notes = notes || ? WHERE uuid = 'T1'", (block,))
    s = ThingsSink(
        ThingsDb(db_path),
        ThingsConfig(),
        opener=cap.urls.append,
        token_provider=lambda: "T",
        sleeper=lambda _s: None,
        runner=cap.scripts.append,
    )
    s.apply([Change(kind="update", source="things", ref="T1", title="FOO", append_notes=block)])
    assert cap.urls == []


def test_creates_missing_tags_once(sink: ThingsSink, cap: Captured) -> None:
    sink.apply(
        [
            Change(kind="update", source="things", ref="T2", title="BAR", marks=["B"]),
            Change(kind="update", source="things", ref="T3", title="Someday", marks=["B", "C"]),
        ]
    )
    assert len(cap.scripts) == 1
    assert cap.scripts[0] == create_tags_script(["papersync:meta:B", "papersync:meta:C"])
    assert (
        create_tags_script(["x"])
        == 'tell application "Things3"\n  make new tag with properties {name:"x"}\nend tell'
    )


def test_mark_printed(sink: ThingsSink, cap: Captured) -> None:
    sink.mark_printed(["T1", "T2", "missing"])
    assert cap.scripts == [create_tags_script([STATE_PRINTED])]
    assert [_q(u)["tags"] for u in cap.urls] == [
        f"papersync:meta:A,{STATE_PRINTED}",
        f"waiting,{STATE_PRINTED}",
    ]
    assert all("auth-token=TOK" in u for u in cap.urls)


def test_create_url_needs_no_token(sink: ThingsSink, cap: Captured) -> None:
    sink.apply([Change(kind="create", source="things", title="New one", notes="body", marks=["A"])])
    q = _q(cap.urls[0])
    assert cap.urls[0].startswith("things:///add?") and "auth-token" not in q
    assert q["title"] == "New one" and q["notes"] == "body"
    assert q["tags"] == f"papersync:meta:A,{STATE_SCANNED}"


def test_describe_and_verify(sink: ThingsSink) -> None:
    ch = Change(
        kind="update", source="things", ref="T2", title="BAR", complete=True, marks=["today", "B"]
    )
    assert sink.describe(ch) == [
        "+ completed",
        "+ today    when=today",
        "+ B        tag papersync:meta:B",
        f"+ state    {STATE_SCANNED}",
    ]
    # nothing was applied to the fixture, so verify reports every unmet part
    assert sink.verify([ch]) == [
        "BAR: not completed",
        "BAR: when=today not set",
        "BAR: tag papersync:meta:B missing",
        f"BAR: tag {STATE_SCANNED} missing",
    ]


def test_opener_failure_does_not_leak_the_token(tmp_path: Path) -> None:
    def boom(url: str) -> None:
        raise subprocess.CalledProcessError(1, ["open", "-g", url])

    s = ThingsSink(
        ThingsDb(make_db(tmp_path / "main.sqlite")),
        ThingsConfig(),
        opener=boom,
        token_provider=lambda: "TOK",
        sleeper=lambda _s: None,
        runner=lambda _script: None,
    )
    with pytest.raises(RuntimeError) as exc:
        s.apply([Change(kind="update", source="things", ref="T2", title="BAR", complete=True)])
    message = str(exc.value)
    assert "auth-token" not in message and "TOK" not in message
    assert "open" in message and "1" in message
