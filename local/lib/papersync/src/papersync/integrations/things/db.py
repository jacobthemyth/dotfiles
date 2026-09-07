import re
import sqlite3
from datetime import date
from pathlib import Path

from pydantic import BaseModel

STATUS_TODO, STATUS_CANCELED, STATUS_DONE = 0, 2, 3
TYPE_TASK, TYPE_PROJECT = 0, 1
START_INBOX, START_ANYTIME, START_SOMEDAY = 0, 1, 2
DB_GLOB = (
    "Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/"
    "ThingsData-*/Things Database.thingsdatabase/main.sqlite"
)
_SHOW_RE = re.compile(r"\Athings:///show\?id=(\w+)\Z")


class ThingsDbNotFound(FileNotFoundError):  # noqa: N818
    pass


def pack_date(d: date) -> int:
    return (d.year << 16) | (d.month << 12) | (d.day << 7)


def unpack_date(n: int | None) -> date | None:
    if not n:
        return None
    return date(n >> 16, (n >> 12) & 0xF, (n >> 7) & 0x1F)


class TaskRow(BaseModel):
    uuid: str
    title: str
    notes: str
    status: int
    start: int
    start_date: date | None
    deadline: date | None
    project: str | None
    tags: list[str]


def find_db_path() -> Path:
    matches = sorted(Path.home().glob(DB_GLOB))
    if not matches:
        raise ThingsDbNotFound(f"Things database not found under ~/{DB_GLOB}")
    return matches[0]


_BASE = f"""
SELECT TASK.uuid, TASK.title, TASK.notes, TASK.status, TASK.start,
       TASK.startDate, TASK.deadline, TASK.project
FROM TMTask TASK
LEFT JOIN TMTask PROJECT ON PROJECT.type = {TYPE_PROJECT} AND TASK.project = PROJECT.uuid
"""
_OPEN = f"TASK.trashed = 0 AND TASK.type = {TYPE_TASK} AND TASK.status = {STATUS_TODO}"


class ThingsDb:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)

    def _rows(self, where: str, params: tuple[object, ...] = ()) -> list[TaskRow]:
        cur = self._conn.execute(f"{_BASE} WHERE {where} ORDER BY TASK.creationDate", params)
        rows = [self._row(r) for r in cur.fetchall()]
        tags = self._tags([r.uuid for r in rows])
        for r in rows:
            r.tags = tags.get(r.uuid, [])
        return rows

    @staticmethod
    def _row(r: tuple[object, ...]) -> TaskRow:
        uuid, title, notes, status, start, start_date, deadline, project = r
        return TaskRow(
            uuid=str(uuid),
            title=str(title or ""),
            notes=str(notes or ""),
            status=int(status or 0),  # ty: ignore[invalid-argument-type]
            start=int(start or 0),  # ty: ignore[invalid-argument-type]
            start_date=unpack_date(start_date),  # ty: ignore[invalid-argument-type]
            deadline=unpack_date(deadline),  # ty: ignore[invalid-argument-type]
            project=str(project) if project else None,
            tags=[],
        )

    def _tags(self, uuids: list[str]) -> dict[str, list[str]]:
        if not uuids:
            return {}
        marks = ",".join("?" * len(uuids))
        cur = self._conn.execute(
            f"SELECT TT.tasks, T.title FROM TMTaskTag TT JOIN TMTag T ON T.uuid = TT.tags "
            f"WHERE TT.tasks IN ({marks}) ORDER BY T.title",
            uuids,
        )
        out: dict[str, list[str]] = {}
        for task, title in cur.fetchall():
            out.setdefault(task, []).append(title)
        return out

    def select(self, selector: str) -> list[TaskRow]:
        if selector == "inbox":
            return self._rows(f"{_OPEN} AND TASK.start = {START_INBOX}")
        if selector in ("next", "someday"):
            start = START_ANYTIME if selector == "next" else START_SOMEDAY
            return self._rows(
                f"{_OPEN} AND ((TASK.start = {start} AND TASK.project IS NULL) "
                f"OR PROJECT.start = {start})"
            )
        m = _SHOW_RE.match(selector)
        if m:
            return self._rows(f"{_OPEN} AND PROJECT.uuid = ?", (m.group(1),))
        raise ValueError(
            f"unknown selector {selector!r}; use inbox, next, someday or things:///show?id=UUID"
        )

    def get(self, uuid: str) -> TaskRow | None:
        rows = self._rows("TASK.uuid = ?", (uuid,))
        return rows[0] if rows else None

    def get_many(self, uuids: list[str]) -> dict[str, TaskRow]:
        return {u: row for u in uuids if (row := self.get(u)) is not None}

    def tag_titles(self) -> set[str]:
        return {str(title) for (title,) in self._conn.execute("SELECT title FROM TMTag")}
