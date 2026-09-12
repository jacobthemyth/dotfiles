"""Read notes out of an Obsidian vault through the desktop CLI."""

from pathlib import PurePosixPath
from typing import Any

from papersync.integrations.obsidian.cli import ObsidianCli, ObsidianError
from papersync.model import Item

PRINTED_PROPERTY = "papersync-printed"
KINDS = ("search", "base", "path", "folder")
FENCE = "---"


def strip_frontmatter(text: str) -> str:
    """Drop a leading ``---`` block. The file must open with the fence."""
    if not text.startswith(FENCE + "\n"):
        return text
    end = text.find(f"\n{FENCE}", len(FENCE))
    if end == -1:
        return text
    rest = text[end + len(FENCE) + 1 :]
    return rest.lstrip("\n")


def parse_selector(selector: str) -> tuple[str, str]:
    kind, _, argument = selector.partition(":")
    if kind not in KINDS or not argument:
        raise ValueError(
            f"unknown selector {selector!r}; use search:<query>, base:<file>[#view], "
            "path:<path> or folder:<path>"
        )
    return kind, argument


def _paths_from(rows: Any) -> list[str]:
    """Pull the ``path`` field out of a search or base reply."""
    if isinstance(rows, dict):
        rows = rows.get("results", rows.get("files", []))
    out = []
    for row in rows:
        path = row.get("path") if isinstance(row, dict) else row
        if isinstance(path, str) and path.endswith(".md"):
            out.append(path)
    return out


class ObsidianSource:
    name = "obsidian"

    def __init__(self, cli: ObsidianCli) -> None:
        self.cli = cli
        self.skipped_printed = 0
        self.errors: list[str] = []

    def resolve(self, selector: str) -> list[str]:
        kind, argument = parse_selector(selector)
        if kind == "path":
            return [argument]
        if kind == "folder":
            reply = self.cli.call("files", folder=argument, ext="md")
            return [line.strip() for line in reply.splitlines() if line.strip().endswith(".md")]
        if kind == "search":
            return _paths_from(self.cli.call_json("search", query=argument, format="json"))
        file_name, _, view = argument.partition("#")
        return _paths_from(
            self.cli.call_json("base:query", file=file_name, view=view or None, format="json")
        )

    def _item(self, path: str) -> Item:
        text = self.cli.call("read", path=path)
        meta = self.cli.call_json("properties", path=path, format="json") or {}
        title = str(meta.get("title") or PurePosixPath(path).stem)
        ref = path[: -len(".md")] if path.endswith(".md") else path
        return Item(
            source=self.name, ref=ref, title=title, notes=strip_frontmatter(text), meta=meta
        )

    def export(self, selector: str, skip_printed: bool = True) -> list[Item]:
        self.skipped_printed = 0
        self.errors = []
        items: list[Item] = []
        for path in self.resolve(selector):
            try:
                item = self._item(path)
            except ObsidianError as exc:
                self.errors.append(str(exc))
                continue
            if skip_printed and PRINTED_PROPERTY in item.meta:
                self.skipped_printed += 1
                continue
            items.append(item)
        return items

    def lookup(self, refs: list[str]) -> dict[str, Item]:
        out: dict[str, Item] = {}
        for ref in refs:
            try:
                out[ref] = self._item(f"{ref}.md")
            except ObsidianError as exc:
                self.errors.append(str(exc))
        return out
