"""Mint and resolve the stable note id papersync writes into front matter.

Obsidian has no built-in note id: the path is the identity, so a rename
breaks every printed sheet that encodes one. papersync mints its own id as a
front matter property and puts that in the QR code instead.
"""

import json
import secrets
import time
from typing import Any

from papersync.integrations.obsidian.cli import ObsidianCli, ObsidianError

ID_PROPERTY = "papersync-id"
# Crockford base32, lowercase. It drops i, l, o and u, so an id read off a
# printed sheet cannot be mistyped as 1/l or 0/o.
ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"
ID_LENGTH = 12
MINT_ATTEMPTS = 5
# A search that matches nothing answers in prose. It is not JSON and it does
# not carry the Error: prefix, so call_json would raise on it.
NO_MATCHES = "No matches found."
# property:set returns before Obsidian has flushed the file, so an immediate
# property:read can miss a value that was in fact written. Seen live: the
# first write of a run reported success, read back "not found", and the id
# was on the note moments later. Retry briefly before believing the write
# failed -- a wrong "it failed" skips a note that now carries an id.
READ_BACK_ATTEMPTS = 6
READ_BACK_PACE_S = 0.25

sleep = time.sleep


class IdentityError(RuntimeError):
    """A note's papersync-id could not be minted or confirmed."""


def new_id() -> str:
    """12 characters of Crockford base32: 60 bits from a cryptographic source."""
    return "".join(secrets.choice(ALPHABET) for _ in range(ID_LENGTH))


def paths_in(rows: Any) -> list[str]:
    """Pull the markdown paths out of a parsed search or base:query reply."""
    if isinstance(rows, dict):
        rows = rows.get("results", rows.get("files", []))
    out = []
    for row in rows:
        path = row.get("path") if isinstance(row, dict) else row
        if isinstance(path, str) and path.endswith(".md"):
            out.append(path)
    return out


def search_paths(cli: ObsidianCli, query: str) -> list[str]:
    """Run a vault search and return the markdown paths it matched."""
    reply = cli.call("search", query=query, format="json")
    if reply == NO_MATCHES:
        return []
    try:
        rows: Any = json.loads(reply)
    except ValueError as exc:
        raise ObsidianError(f"search returned output that is not JSON: {reply[:120]!r}") from exc
    return paths_in(rows)


def find(cli: ObsidianCli, note_id: str) -> list[str]:
    """Every note carrying ``note_id``. More than one means a duplicated note."""
    return search_paths(cli, f'["{ID_PROPERTY}":"{note_id}"]')


def _confirm(cli: ObsidianCli, path: str, candidate: str) -> None:
    """Read the property back until it matches, or give up and raise.

    The Obsidian CLI exits 0 whatever happens, so the read-back is the only
    evidence a write landed. It is retried because the write is flushed
    asynchronously and the first read can be too early.
    """
    seen = ""
    for attempt in range(READ_BACK_ATTEMPTS):
        if attempt:
            sleep(READ_BACK_PACE_S)
        try:
            seen = cli.call("property:read", name=ID_PROPERTY, path=path).strip()
        except ObsidianError as exc:
            seen = str(exc)
            continue
        if seen == candidate:
            return
    raise IdentityError(f"set {ID_PROPERTY} on {path} but read back {seen!r}")


def ensure_id(cli: ObsidianCli, path: str, meta: dict[str, Any]) -> str:
    """Return the note's papersync-id, minting and writing one if it has none.

    The write is read back because the Obsidian CLI exits 0 whatever happens,
    so a silent no-op is otherwise indistinguishable from success.
    """
    existing = meta.get(ID_PROPERTY)
    # A lenient YAML reader hands an all-digit id back as a number, so a bare
    # isinstance(str) check would remint and silently replace the note's id.
    # Coercing everything is too broad the other way: a hand-edited
    # `papersync-id: false` stringifies to "False" and would be reused as an
    # id. Accept a string or a number, and reject a bool, which is an int.
    if isinstance(existing, str | int | float) and not isinstance(existing, bool):
        text = str(existing).strip()
        if text:
            return text
    for _ in range(MINT_ATTEMPTS):
        candidate = new_id()
        if find(cli, candidate):
            continue
        cli.call("property:set", name=ID_PROPERTY, value=candidate, type="text", path=path)
        _confirm(cli, path, candidate)
        return candidate
    raise IdentityError(
        f"could not mint a unique {ID_PROPERTY} for {path} after {MINT_ATTEMPTS} attempts"
    )
