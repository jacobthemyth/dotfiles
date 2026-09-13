"""Mint and resolve the stable note id papersync writes into front matter.

Obsidian has no built-in note id: the path is the identity, so a rename
breaks every printed sheet that encodes one. papersync mints its own id as a
front matter property and puts that in the QR code instead.
"""

import json
import secrets
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


def ensure_id(cli: ObsidianCli, path: str, meta: dict[str, Any]) -> str:
    """Return the note's papersync-id, minting and writing one if it has none.

    The write is read back because the Obsidian CLI exits 0 whatever happens,
    so a silent no-op is otherwise indistinguishable from success.
    """
    existing = meta.get(ID_PROPERTY)
    if isinstance(existing, str) and existing:
        return existing
    for _ in range(MINT_ATTEMPTS):
        candidate = new_id()
        if find(cli, candidate):
            continue
        cli.call("property:set", name=ID_PROPERTY, value=candidate, type="text", path=path)
        confirmed = cli.call("property:read", name=ID_PROPERTY, path=path).strip()
        if confirmed != candidate:
            raise IdentityError(f"set {ID_PROPERTY} on {path} but read back {confirmed!r}")
        return candidate
    raise IdentityError(
        f"could not mint a unique {ID_PROPERTY} for {path} after {MINT_ATTEMPTS} attempts"
    )
