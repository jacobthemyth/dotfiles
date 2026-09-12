"""Install and drive the papersync bridge plugin."""

import json
import shutil
from pathlib import Path

from papersync import __version__
from papersync.integrations.obsidian.cli import ObsidianCli, ObsidianError

BRIDGE_ID = "papersync-bridge"
BRIDGE_SRC = Path(__file__).parent / "bridge"
FILES = ("manifest.json", "main.js", "page.css")


def vault_path(cli: ObsidianCli) -> Path:
    return Path(cli.call("vault", info="path"))


def install(cli: ObsidianCli, vault: Path) -> Path:
    target = vault / ".obsidian" / "plugins" / BRIDGE_ID
    target.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        shutil.copyfile(BRIDGE_SRC / name, target / name)
    cli.call("plugin:enable", id=BRIDGE_ID)
    return target


def installed_version(cli: ObsidianCli) -> str | None:
    reply = cli.evaluate("(window.papersync && window.papersync.version) || 'undefined'").strip()
    return None if reply in {"undefined", "null", ""} else reply


def require_bridge(cli: ObsidianCli) -> None:
    version = installed_version(cli)
    if version is None:
        raise ObsidianError(
            "the papersync bridge is not installed; run: papersync obsidian install-bridge"
        )
    if version != __version__:
        raise ObsidianError(
            f"the papersync bridge is version {version} but papersync is {__version__}; "
            "run: papersync obsidian install-bridge"
        )


def render(cli: ObsidianCli, spec: dict, spec_path: Path) -> int:
    """Render one note. Returns the page count of the written PDF."""
    spec_path.parent.mkdir(parents=True, exist_ok=True)
    spec_path.write_text(json.dumps(spec))
    # spec_path (and the vault path baked into it) can contain spaces and
    # quotes, so it is never interpolated into the JS source as a bare
    # string. json.dumps produces a properly escaped double-quoted JS
    # string literal (JSON string escaping is a strict subset of JS
    # string escaping), which is safe to splice directly into source.
    js_path = json.dumps(str(spec_path))
    reply = cli.evaluate(f"window.papersync.renderFile({js_path})")
    try:
        result = json.loads(reply)
    except ValueError as exc:
        raise ObsidianError(f"the bridge returned unreadable output: {reply[:120]!r}") from exc
    if not result.get("ok"):
        raise ObsidianError(f"the bridge failed: {result.get('error', 'unknown error')}")
    if "pages" not in result:
        raise ObsidianError(f"the bridge reported success but no page count: {reply[:120]!r}")
    return int(result["pages"])
