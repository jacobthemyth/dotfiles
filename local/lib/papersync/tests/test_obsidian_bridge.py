import json
import re
from pathlib import Path

import pytest

from papersync import __version__
from papersync.integrations.obsidian import bridge
from papersync.integrations.obsidian.cli import ObsidianCli, ObsidianError


def test_the_shipped_manifest_matches_the_package_version() -> None:
    manifest = json.loads((bridge.BRIDGE_SRC / "manifest.json").read_text())
    assert manifest["id"] == bridge.BRIDGE_ID
    assert manifest["version"] == __version__
    assert manifest["isDesktopOnly"] is True


def test_the_bridge_ships_all_three_files() -> None:
    for name in ("manifest.json", "main.js", "page.css"):
        assert (bridge.BRIDGE_SRC / name).is_file()


def test_page_css_declares_no_page_rule() -> None:
    # main.js's pageStyle() is the single emitter of @page, built from the
    # spec (which traces back to layout.py). A second @page rule here would
    # cascade by source order and could silently override the spec's page
    # size for non-Letter documents, so page.css must never declare one.
    # A rule is `@page` followed (ignoring whitespace) by `{`; explanatory
    # prose mentioning "@page" in a comment is fine and not what this guards.
    css = (bridge.BRIDGE_SRC / "page.css").read_text()
    assert re.search(r"@page\s*\{", css) is None


def test_install_copies_the_files_and_enables_the_plugin(tmp_path: Path) -> None:
    calls: list[list[str]] = []

    def runner(args: list[str]) -> str:
        calls.append(args)
        return str(tmp_path) if args[1] == "vault" else "ok"

    cli = ObsidianCli("Notes", runner=runner)
    target = bridge.install(cli, tmp_path)
    assert target == tmp_path / ".obsidian" / "plugins" / bridge.BRIDGE_ID
    assert (target / "main.js").is_file()
    assert (target / "manifest.json").is_file()
    assert (target / "page.css").is_file()
    assert ["vault=Notes", "plugin:enable", f"id={bridge.BRIDGE_ID}"] in calls


def test_install_overwrites_a_stale_copy(tmp_path: Path) -> None:
    target = tmp_path / ".obsidian" / "plugins" / bridge.BRIDGE_ID
    target.mkdir(parents=True)
    (target / "main.js").write_text("stale")
    bridge.install(ObsidianCli("Notes", runner=lambda a: "ok"), tmp_path)
    assert (target / "main.js").read_text() != "stale"


def test_installed_version_reads_the_running_bridge() -> None:
    cli = ObsidianCli("Notes", runner=lambda a: f"=> {__version__}")
    assert bridge.installed_version(cli) == __version__


def test_installed_version_is_none_when_the_bridge_is_absent() -> None:
    cli = ObsidianCli("Notes", runner=lambda a: "=> undefined")
    assert bridge.installed_version(cli) is None


def test_render_returns_the_page_count(tmp_path: Path) -> None:
    spec_path = tmp_path / "spec.json"
    cli = ObsidianCli("Notes", runner=lambda a: '=> {"ok": true, "pages": 3}')
    assert bridge.render(cli, {"path": "a.md"}, spec_path) == 3
    assert json.loads(spec_path.read_text())["path"] == "a.md"


def test_render_raises_when_the_bridge_reports_failure(tmp_path: Path) -> None:
    cli = ObsidianCli("Notes", runner=lambda a: '=> {"ok": false, "error": "no such file"}')
    with pytest.raises(ObsidianError, match="no such file"):
        bridge.render(cli, {"path": "a.md"}, tmp_path / "spec.json")
