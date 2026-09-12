"""Live test against a running Obsidian.

Running this test installs the papersync bridge plugin into the real vault
named by ``PAPERSYNC_REAL_VAULT``, and marks nothing else. Skipped unless
``PAPERSYNC_REAL_OBSIDIAN=1`` is set.

Run it with:

    PAPERSYNC_REAL_OBSIDIAN=1 PAPERSYNC_REAL_VAULT=Notes \
        uv run pytest tests/test_obsidian_real.py -q
"""

import os
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


@pytest.fixture
def cli() -> ObsidianCli:
    vault = os.environ.get("PAPERSYNC_REAL_VAULT")
    if not vault:
        pytest.skip("set PAPERSYNC_REAL_VAULT to the vault name")
    return ObsidianCli(vault)


def test_the_bridge_installs_and_answers(cli: ObsidianCli) -> None:
    install(cli, vault_path(cli))
    assert installed_version(cli) is not None


def test_one_real_note_renders_and_stamps(cli: ObsidianCli, tmp_path: Path) -> None:
    install(cli, vault_path(cli))
    source = ObsidianSource(cli)
    notes = source.export("folder:.", skip_printed=False)
    if not notes:
        pytest.skip("the vault has no notes")

    docs = D.render_documents(
        cli,
        notes[:1],
        L.SIZES["letter"],
        ["A", "B"],
        1,
        ["papersync-printed"],
        date.today(),
        tmp_path,
    )
    assert docs[0].pages >= 1
    out_dir, paths = D.write_documents(docs, tmp_path / "out", "live", cli.vault)
    assert paths[0].stat().st_size > 1000
    assert (out_dir / "manifest.json").is_file()
