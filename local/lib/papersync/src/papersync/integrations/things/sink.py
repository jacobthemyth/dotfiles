import subprocess
import time
from collections.abc import Callable, Iterable
from datetime import date
from urllib.parse import quote

from papersync.config import ThingsConfig
from papersync.integrations.things.actions import ThingsUpdate, default_tag, resolve
from papersync.integrations.things.auth import get_token
from papersync.integrations.things.db import (
    START_ANYTIME,
    START_SOMEDAY,
    STATUS_CANCELED,
    STATUS_DONE,
    TaskRow,
    ThingsDb,
)
from papersync.model import Change

VERIFY_DELAY_S = 2.0
STATE_PRINTED = "papersync:printed"
STATE_SCANNED = "papersync:scanned"
STATE_TAGS = {STATE_PRINTED, STATE_SCANNED}


def _open_url(url: str) -> None:
    subprocess.run(["open", "-g", url], check=True)


def _run_osascript(script: str) -> None:
    subprocess.run(["osascript", "-e", script], check=True, capture_output=True)


def create_tags_script(names: list[str]) -> str:
    body = "\n".join(
        '  make new tag with properties {name:"' + n.replace('"', '\\"') + '"}' for n in names
    )
    return 'tell application "Things3"\n' + body + "\nend tell"


def _encode(params: list[tuple[str, str]]) -> str:
    return "&".join(f"{k}={quote(v, safe='')}" for k, v in params)


def _action_params(upd: ThingsUpdate) -> list[tuple[str, str]]:
    params: list[tuple[str, str]] = []
    for key in ("when", "deadline", "list"):
        value = getattr(upd, key)
        if value:
            params.append((key, value))
    if upd.completed:
        params.append(("completed", "true"))
    if upd.canceled:
        params.append(("canceled", "true"))
    return params


def build_update_url(
    ref: str, token: str, upd: ThingsUpdate, tags: list[str] | None, append_notes: str | None
) -> str:
    params = [("id", ref), ("auth-token", token), *_action_params(upd)]
    if tags is not None:
        params.append(("tags", ",".join(tags)))
    if append_notes:
        params.append(("append-notes", append_notes))
    return "things:///update?" + _encode(params)


def build_add_url(title: str, notes: str | None, upd: ThingsUpdate, tags: list[str]) -> str:
    params = [("title", title)]
    if notes:
        params.append(("notes", notes))
    params.append(("tags", ",".join(tags)))
    params += _action_params(upd)
    return "things:///add?" + _encode(params)


def _new_tags(current: list[str], add: list[str], state: str) -> list[str] | None:
    """Current tags with state tags stripped, action tags added, and the new state tag.

    Returns None if the result is unchanged.
    """
    out = [t for t in current if t not in STATE_TAGS]
    out += [t for t in add if t not in out and t not in STATE_TAGS]
    out.append(state)
    return None if set(out) == set(current) else out


def _when_holds(row: TaskRow, when: str, today: date) -> bool:
    if when == "today":
        return row.start == START_ANYTIME and row.start_date == today
    if when == "someday":
        return row.start == START_SOMEDAY
    if when == "anytime":
        return row.start == START_ANYTIME and row.start_date is None
    return False


class ThingsSink:
    name = "things"

    def __init__(
        self,
        db: ThingsDb,
        cfg: ThingsConfig,
        opener: Callable[[str], None] = _open_url,
        token_provider: Callable[[], str] = get_token,
        sleeper: Callable[[float], None] = time.sleep,
        runner: Callable[[str], None] = _run_osascript,
    ) -> None:
        self.db = db
        self.cfg = cfg
        self.opener = opener
        self.token_provider = token_provider
        self.sleeper = sleeper
        self.runner = runner

    def ensure_tags(self, names: Iterable[str]) -> None:
        missing = sorted(set(names) - self.db.tag_titles())
        if missing:
            self.runner(create_tags_script(missing))

    def _remaining(
        self, change: Change, upd: ThingsUpdate
    ) -> tuple[ThingsUpdate, list[str] | None, str | None]:
        """Drop the parts of an update that the database already shows."""
        row = self.db.get(change.ref or "")
        if row is None:
            return upd, [*upd.tags, STATE_SCANNED], change.append_notes
        left = upd.model_copy()
        if row.status == STATUS_DONE:
            left.completed = False
        if row.status == STATUS_CANCELED:
            left.canceled = False
        if upd.when and _when_holds(row, upd.when, date.today()):
            left.when = None
        if upd.deadline and row.deadline is not None and row.deadline.isoformat() == upd.deadline:
            left.deadline = None
        tags = _new_tags(row.tags, upd.tags, STATE_SCANNED)
        notes = change.append_notes
        if notes and notes in row.notes:
            notes = None
        return left, tags, notes

    def plan_urls(self, changes: list[Change]) -> list[tuple[Change, str | None]]:
        out: list[tuple[Change, str | None]] = []
        token: str | None = None
        for change in changes:
            upd, _ = resolve(change, self.cfg)
            if change.kind == "create":
                out.append(
                    (
                        change,
                        build_add_url(change.title, change.notes, upd, [*upd.tags, STATE_SCANNED]),
                    )
                )
                continue
            left, tags, notes = self._remaining(change, upd)
            if not (
                left.completed
                or left.canceled
                or left.when
                or left.deadline
                or left.list
                or tags
                or notes
            ):
                out.append((change, None))
                continue
            token = token or self.token_provider()
            out.append((change, build_update_url(change.ref or "", token, left, tags, notes)))
        return out

    def apply(self, changes: list[Change]) -> None:
        planned = [(c, u) for c, u in self.plan_urls(changes) if u]
        if not planned:
            return
        wanted = {STATE_SCANNED}
        for change, _url in planned:
            wanted.update(resolve(change, self.cfg)[0].tags)
        self.ensure_tags(wanted)
        for _change, url in planned:
            self.opener(url)

    def mark_printed(self, refs: list[str]) -> None:
        rows = [row for ref in refs if (row := self.db.get(ref)) is not None]
        updates = [
            (row.uuid, tags) for row in rows if (tags := _new_tags(row.tags, [], STATE_PRINTED))
        ]
        if not updates:
            return
        self.ensure_tags([STATE_PRINTED])
        token = self.token_provider()
        for uuid, tags in updates:
            self.opener(build_update_url(uuid, token, ThingsUpdate(), tags, None))

    def describe(self, change: Change) -> list[str]:
        _upd, warnings = resolve(change, self.cfg)
        lines = ["+ completed"] if change.complete else []
        for label in change.marks:
            action = self.cfg.actions.get(label)
            if action is None:
                lines.append(f"+ {label:<8} tag {default_tag(label)}")
                continue
            parts = [f"tag {t}" for t in action.tags]
            parts += [
                f"{k}={getattr(action, k)}"
                for k in ("when", "deadline", "list", "completed", "canceled")
                if getattr(action, k) is not None
            ]
            lines.append(f"+ {label:<8} {' '.join(parts)}")
        lines += [f"! {w}" for w in warnings]
        lines.append(f"+ state    {STATE_SCANNED}")
        return lines

    def verify(self, changes: list[Change]) -> list[str]:
        self.sleeper(VERIFY_DELAY_S)
        unmet: list[str] = []
        today = date.today()
        for change in changes:
            if change.kind == "create":
                continue
            upd, _ = resolve(change, self.cfg)
            row = self.db.get(change.ref or "")
            if row is None:
                unmet.append(f"{change.title}: item not found")
                continue
            if upd.completed and row.status != STATUS_DONE:
                unmet.append(f"{change.title}: not completed")
            if upd.canceled and row.status != STATUS_CANCELED:
                unmet.append(f"{change.title}: not canceled")
            if upd.when and not _when_holds(row, upd.when, today):
                unmet.append(f"{change.title}: when={upd.when} not set")
            if upd.deadline and (row.deadline is None or row.deadline.isoformat() != upd.deadline):
                unmet.append(f"{change.title}: deadline {upd.deadline} not set")
            unmet += [
                f"{change.title}: tag {t} missing"
                for t in [*upd.tags, STATE_SCANNED]
                if t not in row.tags
            ]
            if STATE_PRINTED in row.tags:
                unmet.append(f"{change.title}: tag {STATE_PRINTED} still present")
            if change.append_notes and change.append_notes not in row.notes:
                unmet.append(f"{change.title}: notes not appended")
        return unmet

    def check(self) -> list[str]:
        problems: list[str] = []
        try:
            self.db.select("inbox")
        except Exception as exc:
            problems.append(f"Things database unreadable: {exc}")
        return problems
