from papersync.integrations.things.db import ThingsDb
from papersync.model import Item


class ThingsSource:
    name = "things"

    def __init__(self, db: ThingsDb) -> None:
        self.db = db

    def export(self, selector: str) -> list[Item]:
        return [
            Item(source=self.name, ref=t.uuid, title=t.title, notes=t.notes)
            for t in self.db.select(selector)
        ]

    def lookup(self, refs: list[str]) -> dict[str, Item]:
        return {
            u: Item(source=self.name, ref=u, title=t.title, notes=t.notes)
            for u, t in self.db.get_many(refs).items()
        }
