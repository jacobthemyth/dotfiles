"""Live test against a running Obsidian.

Running this test installs the papersync bridge plugin into the real vault
named by ``PAPERSYNC_REAL_VAULT``. It also creates a disposable note of its
own -- named so it cannot collide with a real one -- exports it (which mints
a ``papersync-id`` on that note only), and deletes the note permanently in a
fixture teardown that runs even if the test fails. No other note in the
vault is read, written, or deleted. Skipped unless ``PAPERSYNC_REAL_OBSIDIAN=1``
is set.

Run it with:

    PAPERSYNC_REAL_OBSIDIAN=1 PAPERSYNC_REAL_VAULT=Notes \
        uv run pytest tests/test_obsidian_real.py -q
"""

import os
import uuid
from collections.abc import Iterator
from datetime import date
from pathlib import Path

import pytest

from papersync.integrations.obsidian import documents as D  # noqa: N812
from papersync.integrations.obsidian.bridge import install, installed_version, vault_path
from papersync.integrations.obsidian.cli import ObsidianCli
from papersync.integrations.obsidian.source import ObsidianSource
from papersync.render.templates.v1 import layout as L  # noqa: N812

pytestmark = pytest.mark.skipif(
    os.environ.get("PAPERSYNC_REAL_OBSIDIAN") != "1",
    reason="set PAPERSYNC_REAL_OBSIDIAN=1 to run against a live Obsidian",
)

LIVE_NOTE_CONTENT = (
    "---\ntitle: papersync live test\n---\n\nBody paragraph one.\n\nBody paragraph two.\n"
)


@pytest.fixture
def cli() -> ObsidianCli:
    vault = os.environ.get("PAPERSYNC_REAL_VAULT")
    if not vault:
        pytest.skip("set PAPERSYNC_REAL_VAULT to the vault name")
    return ObsidianCli(vault)


@pytest.fixture
def live_note(cli: ObsidianCli) -> Iterator[str]:
    """Create a disposable note this test owns, and delete it permanently after.

    The name embeds a random token so it cannot collide with a real note.
    The teardown runs in ``finally`` so the note is deleted even when the
    test body fails or raises -- this test must never leave a note behind.
    """
    path = f"papersync-live-test-{uuid.uuid4().hex}.md"
    cli.call("create", path=path, content=LIVE_NOTE_CONTENT)
    try:
        yield path
    finally:
        cli.call("delete", path=path, permanent=True)


def test_the_bridge_installs_and_answers(cli: ObsidianCli) -> None:
    install(cli, vault_path(cli))
    assert installed_version(cli) is not None


def test_one_real_note_renders_and_stamps(cli: ObsidianCli, live_note: str, tmp_path: Path) -> None:
    """Exports the disposable note only, minting a papersync-id on it alone."""
    install(cli, vault_path(cli))
    source = ObsidianSource(cli)
    notes = source.export(f"path:{live_note}", skip_printed=False)
    assert source.errors == []
    assert len(notes) == 1

    docs = D.render_documents(
        cli,
        notes,
        L.SIZES["letter"],
        ["A", "B"],
        1,
        ["papersync-printed", "papersync-id"],
        date.today(),
        tmp_path,
    )
    assert docs[0].pages >= 1
    out_dir, paths = D.write_documents(docs, tmp_path / "out", "live", cli.vault)
    assert paths[0].stat().st_size > 1000
    assert (out_dir / "manifest.json").is_file()
