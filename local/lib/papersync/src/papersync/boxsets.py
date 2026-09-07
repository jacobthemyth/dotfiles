import json
import tomllib
from datetime import UTC, datetime
from pathlib import Path


class BoxSetRegistry:
    """Append-only registry mapping a box set id to its printed labels."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._sets: dict[int, list[str]] = {}
        if path.exists():
            data = tomllib.loads(path.read_text())
            for entry in data.get("sets", []):
                self._sets[int(entry["id"])] = list(entry["labels"])

    def labels_for(self, set_id: int) -> list[str] | None:
        return self._sets.get(set_id)

    def id_for(self, labels: list[str]) -> int:
        for set_id, existing in self._sets.items():
            if existing == labels:
                return set_id
        set_id = max(self._sets, default=0) + 1
        self._sets[set_id] = list(labels)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        created = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        with self.path.open("a") as fh:
            fh.write(
                f'[[sets]]\nid = {set_id}\nlabels = {json.dumps(labels)}\ncreated = "{created}"\n'
            )
        return set_id
