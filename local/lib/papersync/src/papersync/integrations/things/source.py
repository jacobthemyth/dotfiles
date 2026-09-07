from papersync.integrations.things.db import ThingsDb
from papersync.integrations.things.sink import STATE_PRINTED
from papersync.model import Item


class ThingsSource:
    name = "things"

    def __init__(self, db: ThingsDb) -> None:
        self.db = db
        self.skipped_printed = 0

    def export(self, selector: str, skip_printed: bool = True) -> list[Item]:
        """Open items for the selector, minus those already tagged papersync:printed."""
        rows = self.db.select(selector)
        if skip_printed:
            kept = [t for t in rows if STATE_PRINTED not in t.tags]
            self.skipped_printed = len(rows) - len(kept)
            rows = kept
        else:
            self.skipped_printed = 0
        return [Item(source=self.name, ref=t.uuid, title=t.title, notes=t.notes) for t in rows]

    def lookup(self, refs: list[str]) -> dict[str, Item]:
        return {
            u: Item(source=self.name, ref=u, title=t.title, notes=t.notes)
            for u, t in self.db.get_many(refs).items()
        }
