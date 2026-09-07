from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel


class LedgerEntry(BaseModel):
    ts: datetime
    event: Literal["render", "apply", "forget"]
    source: str
    ref: str
    title: str = ""
    size: str = ""
    boxes: int = 0
    file: str = ""


class Ledger:
    def __init__(self, path: Path) -> None:
        self.path = path

    def _entries(self) -> list[LedgerEntry]:
        if not self.path.exists():
            return []
        return [
            LedgerEntry.model_validate_json(line)
            for line in self.path.read_text().splitlines()
            if line
        ]

    def record(self, entry: LedgerEntry) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a") as fh:
            fh.write(entry.model_dump_json() + "\n")

    def outstanding(self) -> list[LedgerEntry]:
        latest: dict[tuple[str, str], LedgerEntry] = {}
        for entry in sorted(self._entries(), key=lambda e: e.ts):
            key = (entry.source, entry.ref)
            if entry.event == "render":
                latest[key] = entry
            else:
                latest.pop(key, None)
        return sorted(latest.values(), key=lambda e: e.ts)
