"""Read notes out of an Obsidian vault through the desktop CLI."""

from pathlib import PurePosixPath
from typing import Any

from papersync.integrations.obsidian.cli import ObsidianCli, ObsidianError
from papersync.integrations.obsidian.identity import (
    ALPHABET,
    ID_LENGTH,
    ID_PROPERTY,
    IdentityError,
    ensure_id,
    find,
    paths_in,
    search_paths,
)
from papersync.model import Item

PRINTED_PROPERTY = "papersync-printed"
KINDS = ("search", "base", "path", "folder")
FENCE = "---"


def strip_frontmatter(text: str) -> str:
    """Drop a leading ``---`` block. The file must open with the fence.

    Tolerates CRLF line endings: a note touched outside Obsidian (or created
    on Windows) may use "\\r\\n", and the fence must still be recognized.
    """
    text = text.replace("\r\n", "\n")
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
            return search_paths(self.cli, argument)
        file_name, _, view = argument.partition("#")
        return paths_in(
            self.cli.call_json("base:query", file=file_name, view=view or None, format="json")
        )

    def _item(self, path: str, meta: dict[str, Any] | None = None) -> Item:
        if meta is None:
            meta = self.cli.call_json("properties", path=path, format="json") or {}
        note_id = ensure_id(self.cli, path, meta)
        text = self.cli.call("read", path=path)
        title = str(meta.get("title") or PurePosixPath(path).stem)
        return Item(
            source=self.name,
            ref=note_id,
            title=title,
            notes=strip_frontmatter(text),
            meta=meta,
            locator=path,
        )

    def export(self, selector: str, skip_printed: bool = True) -> list[Item]:
        """Read every note the selector names, minting an id for each.

        Properties come first so a note that is skipped as already printed is
        never written to.
        """
        self.skipped_printed = 0
        self.errors = []
        items: list[Item] = []
        for path in self.resolve(selector):
            try:
                meta = self.cli.call_json("properties", path=path, format="json") or {}
                if skip_printed and PRINTED_PROPERTY in meta:
                    self.skipped_printed += 1
                    continue
                items.append(self._item(path, meta))
            except (ObsidianError, IdentityError) as exc:
                self.errors.append(str(exc))
        return items

    def lookup(self, refs: list[str]) -> dict[str, Item]:
        """Resolve minted ids to the notes that currently carry them.

        The id is already known here, so it must never be re-derived: a stale
        search index or a property edited away between the search and the
        read must fail loudly rather than let ``_item`` mint a fresh id and
        silently replace the note's durable identity.
        """
        out: dict[str, Item] = {}
        for ref in refs:
            if not (len(ref) == ID_LENGTH and set(ref) <= set(ALPHABET)):
                self.errors.append(f"malformed {ID_PROPERTY} {ref!r}")
                continue
            try:
                paths = find(self.cli, ref)
            except ObsidianError as exc:
                self.errors.append(str(exc))
                continue
            if not paths:
                self.errors.append(f"unknown {ID_PROPERTY} {ref}")
                continue
            if len(paths) > 1:
                self.errors.append(
                    f"{ID_PROPERTY} {ref} is on more than one note: {', '.join(sorted(paths))}"
                )
                continue
            path = paths[0]
            try:
                meta = self.cli.call_json("properties", path=path, format="json") or {}
            except ObsidianError as exc:
                self.errors.append(str(exc))
                continue
            if meta.get(ID_PROPERTY) != ref:
                self.errors.append(f"{ID_PROPERTY} {ref} no longer matches the property on {path}")
                continue
            try:
                out[ref] = self._item(path, meta)
            except (ObsidianError, IdentityError) as exc:
                self.errors.append(str(exc))
        return out
