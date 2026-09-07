from datetime import datetime
from pathlib import Path
from typing import Literal

from papersync.ledger import Ledger, LedgerEntry


def _e(event: Literal["render", "apply", "forget"], ref: str, ts: int) -> LedgerEntry:
    return LedgerEntry(
        ts=datetime(2026, 9, 7, 0, 0, ts), event=event, source="things", ref=ref, title=ref
    )


def test_outstanding(tmp_path: Path) -> None:
    led = Ledger(tmp_path / "prints.jsonl")
    led.record(_e("render", "A", 1))
    led.record(_e("render", "B", 2))
    led.record(_e("apply", "A", 3))
    led.record(_e("render", "A", 4))
    led.record(_e("render", "C", 5))
    led.record(_e("forget", "C", 6))
    assert [e.ref for e in led.outstanding()] == ["B", "A"]


def test_persists(tmp_path: Path) -> None:
    path = tmp_path / "prints.jsonl"
    Ledger(path).record(_e("render", "A", 1))
    assert Ledger(path).outstanding()[0].ref == "A"
    assert path.read_text().count("\n") == 1
