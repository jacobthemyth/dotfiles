"""Write printed state back into an Obsidian vault.

Only the print side is implemented. Scanning documents back in is a later
project, so ``apply`` and ``verify`` refuse rather than quietly doing nothing.
"""

from datetime import date

from papersync.integrations.obsidian.cli import ObsidianCli, ObsidianError
from papersync.integrations.obsidian.source import PRINTED_PROPERTY
from papersync.model import Change

NOT_YET = "the Obsidian importer does not exist yet"


class ObsidianSink:
    name = "obsidian"
    marker = PRINTED_PROPERTY

    def __init__(self, cli: ObsidianCli, today: date | None = None) -> None:
        self.cli = cli
        self.today = today or date.today()
        self.warnings: list[str] = []

    def describe(self, change: Change) -> list[str]:
        return [f"mark {m}" for m in change.marks]

    def mark_printed(self, addresses: list[str]) -> list[str]:
        """Set the printed property on each note path. Returns the ones that failed.

        The argument is a note path, not a papersync-id: ``property:set``
        addresses a file, and the id is only what the QR code carries.
        """
        self.warnings = []
        failed: list[str] = []
        for path in addresses:
            try:
                self.cli.call(
                    "property:set",
                    name=PRINTED_PROPERTY,
                    value=self.today.isoformat(),
                    type="date",
                    path=path,
                )
            except ObsidianError as exc:
                self.warnings.append(f"{path}: {exc}")
                failed.append(path)
        return failed

    def check(self) -> list[str]:
        try:
            self.cli.call("vault", info="name")
        except ObsidianError as exc:
            return [str(exc)]
        return []

    def apply(self, changes: list[Change]) -> None:
        raise NotImplementedError(NOT_YET)

    def verify(self, changes: list[Change]) -> list[str]:
        raise NotImplementedError(NOT_YET)
