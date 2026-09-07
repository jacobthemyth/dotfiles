# papersync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `papersync`, a uv-managed Python CLI that prints Things items onto SDAPS-style index cards and reads marked, annotated and new cards back into Things.

**Architecture:** An integration-neutral core (model, config, render engine, recognizer, plan display) plus a `things` integration (sqlite reader, URL-scheme writer, keychain). Rendering goes through a versioned Typst template driven by a Python geometry module that is also the recognizer's single source of truth. The plan JSON is the contract between `recognize` and `apply`.

**Tech Stack:** Python 3.12, uv, click, pydantic, typst, segno, pymupdf, zxing-cpp, opencv-python-headless, numpy, ocrmac, keyring, pytest, ruff, ty.

**Spec:** `docs/superpowers/specs/2026-09-07-papersync-design.md`

## Global Constraints

- Project directory: `local/lib/papersync/` (symlinked whole by rcm to `~/.local/lib/papersync/`). Shim: `local/bin/papersync`.
- Python `>=3.12`. All dependencies must be PyPI wheels. No Homebrew packages beyond `uv`.
- macOS only for OCR and Things. The render path must still import and run without ocrmac being importable (import ocrmac lazily).
- QR payload form: `papersync:///v1/things/<ref>?size=<size>&boxes=<n>[&page=<p>&pages=<n>]`. Query keys in exactly that order. QR is always version 5, module 0.38 mm, error level M with fallback to L.
- Template version is a plain integer. v1 geometry lives in `src/papersync/render/templates/v1/layout.py`.
- Tags default to `papersync:meta:<label>`. State tags: `papersync:printed` on render, swapped for `papersync:scanned` on apply; the Things URL scheme never creates tags, so missing ones are created through `osascript` first. Appended notes block: `\n\n## Scanned YYYY-MM-DD\n\n> line\n> line`.
- Human output to stderr, data to stdout. `apply` requires a literal `yes` unless `--auto-approve`.
- Fill thresholds: below `FILL_LOW = 0.06` unchecked, above `FILL_HIGH = 0.20` checked, between uncertain. Uncertain is treated as unchecked and warned, never an error.
- `ruff check`, `ruff format --check`, `ty check` and `pytest` must pass after every task. Run them from `local/lib/papersync` as `uv run ruff check .`, `uv run ruff format --check .`, `uv run ty check`, `uv run pytest -q`.
- Commit after every task. Commit messages end with the session trailer used in this repo:

```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AEs4A1FGA9nw9F1fPXdYu9
```

- Verified during the spec spike (2026-09-07): `typst.compile(path, sys_inputs={...}, font_paths=[...])` returns PDF bytes; New Computer Modern (serif) is bundled but New Computer Modern Sans is not, so two OTFs are vendored; a warm compile takes about 100 ms; `zxingcpp.read_barcodes(gray, formats=zxingcpp.BarcodeFormat.QRCode)` returns `.text` and `.position.top_left/.top_right/.bottom_right/.bottom_left` with `.x/.y`; `ocrmac.ocrmac.OCR(pil_image, recognition_level="accurate").recognize(px=True)` returns `[(text, confidence, (x, y, w, h)), ...]`; Things packs dates as `year << 16 | month << 12 | day << 7`; `start` is 0 inbox, 1 anytime/today, 2 someday.

---

## File map

```
local/bin/papersync                                   shim
local/lib/papersync/pyproject.toml
local/lib/papersync/README.md
local/lib/papersync/src/papersync/__init__.py         __version__
local/lib/papersync/src/papersync/cli.py              click commands
local/lib/papersync/src/papersync/model.py            Item, BoxResult, Change, PlanError, Plan
local/lib/papersync/src/papersync/payload.py          QR URL build/parse
local/lib/papersync/src/papersync/config.py           config.toml, XDG dirs, Action
local/lib/papersync/src/papersync/boxsets.py          box set registry
local/lib/papersync/src/papersync/ledger.py           prints.jsonl, status
local/lib/papersync/src/papersync/display.py          diff-style plan display
local/lib/papersync/src/papersync/render/qr.py        segno SVG
local/lib/papersync/src/papersync/render/engine.py    size selection, pagination, output files
local/lib/papersync/src/papersync/render/templates/v1/layout.py
local/lib/papersync/src/papersync/render/templates/v1/card.typ
local/lib/papersync/src/papersync/render/templates/v1/fonts/NewCMSans10-{Regular,Bold}.otf
local/lib/papersync/src/papersync/recognize/raster.py
local/lib/papersync/src/papersync/recognize/qr.py
local/lib/papersync/src/papersync/recognize/geometry.py   fiducials + homography
local/lib/papersync/src/papersync/recognize/marks.py
local/lib/papersync/src/papersync/recognize/ocr.py
local/lib/papersync/src/papersync/recognize/assemble.py   pages -> Plan
local/lib/papersync/src/papersync/recognize/review.py
local/lib/papersync/src/papersync/integrations/base.py
local/lib/papersync/src/papersync/integrations/things/db.py
local/lib/papersync/src/papersync/integrations/things/source.py
local/lib/papersync/src/papersync/integrations/things/auth.py
local/lib/papersync/src/papersync/integrations/things/actions.py
local/lib/papersync/src/papersync/integrations/things/sink.py   URL scheme, state tags, AppleScript tag creation
local/lib/papersync/tests/...                         one test file per module
```

---

### Task 1: Project scaffold, shim, rcm and test wiring

**Files:**
- Create: `local/lib/papersync/pyproject.toml`, `local/lib/papersync/src/papersync/__init__.py`, `local/lib/papersync/src/papersync/cli.py`, `local/lib/papersync/tests/test_cli.py`, `local/lib/papersync/README.md`, `local/bin/papersync`
- Modify: `rcrc` (SYMLINK_DIRS), `.gitignore`, `script/test`, `CLAUDE.md`

**Interfaces:**
- Produces: `papersync.cli.main` (click group), `papersync.__version__`.

- [ ] **Step 1: Create the project files**

`local/lib/papersync/pyproject.toml`:

```toml
[project]
name = "papersync"
version = "0.1.0"
description = "Print Things items to index cards and scan them back."
requires-python = ">=3.12"
dependencies = [
  "click>=8.1",
  "pydantic>=2.7",
  "typst>=0.13",
  "segno>=1.6",
  "pymupdf>=1.24",
  "zxing-cpp>=2.2",
  "opencv-python-headless>=4.9",
  "numpy>=1.26",
  "ocrmac>=1.0; sys_platform == 'darwin'",
  "pillow>=10",
  "keyring>=25",
]

[project.scripts]
papersync = "papersync.cli:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/papersync"]

[dependency-groups]
dev = ["pytest>=8", "ruff>=0.6", "ty"]

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP", "N", "SIM", "RUF"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

`src/papersync/__init__.py`:

```python
__version__ = "0.1.0"
```

`src/papersync/cli.py`:

```python
import click

from papersync import __version__


@click.group()
@click.version_option(__version__, prog_name="papersync")
def main() -> None:
    """Print Things items to index cards and scan them back."""


if __name__ == "__main__":
    main()
```

`tests/test_cli.py`:

```python
from click.testing import CliRunner

from papersync.cli import main


def test_version() -> None:
    result = CliRunner().invoke(main, ["--version"])
    assert result.exit_code == 0
    assert "papersync" in result.output
```

`README.md`: two paragraphs, what the tool does and the `uv run` invocation. Keep it under 30 lines.

`local/bin/papersync` (mode 755):

```sh
#!/bin/sh
exec uv run --project "$HOME/.local/lib/papersync" --frozen papersync "$@"
```

- [ ] **Step 2: Lock and run**

Run: `cd local/lib/papersync && uv lock && uv run pytest -q`
Expected: 1 passed. `uv.lock` is created and committed.

- [ ] **Step 3: Wire rcm, gitignore, script/test, CLAUDE.md**

`rcrc`: change `export SYMLINK_DIRS="agents/skills/*"` to `export SYMLINK_DIRS="agents/skills/* local/lib/papersync"`.

`.gitignore`: append `.venv/`, `.ruff_cache/`, `.pytest_cache/`.

`script/test`: append before the final `exit` (look at the file for where `fail` is checked):

```bash
echo "==> papersync lint + tests"
if command -v uv >/dev/null 2>&1; then
  (
    cd local/lib/papersync &&
    uv run --frozen ruff check . &&
    uv run --frozen ruff format --check . &&
    uv run --frozen ty check &&
    uv run --frozen pytest -q
  ) || fail=1
else
  echo "  SKIP: uv not installed"
fi
```

`CLAUDE.md` Structure section: add `- \`local/lib/papersync/\` — uv project behind \`~/.local/bin/papersync\` (see docs/superpowers/specs/2026-09-07-papersync-design.md)`.

- [ ] **Step 4: Run the whole check**

Run: `./script/test`
Expected: the papersync block passes. Fix any ruff or ty complaint before continuing.

- [ ] **Step 5: Commit**

```bash
git add local/lib/papersync local/bin/papersync rcrc .gitignore script/test CLAUDE.md
git commit -m "Scaffold papersync uv project and shim"
```

---

### Task 2: Core model

**Files:**
- Create: `src/papersync/model.py`, `tests/test_model.py`

**Interfaces:**
- Produces:

```python
class Item(BaseModel): source: str; ref: str; title: str; notes: str = ""
class BoxResult(BaseModel): fill: float; checked: bool; uncertain: bool
class Change(BaseModel):
    kind: Literal["update", "create"]; source: str; ref: str | None = None
    title: str; complete: bool = False; marks: list[str] = []
    append_notes: str | None = None; notes: str | None = None
    boxes: dict[str, BoxResult] = {}; pages: list[int] = []
class PlanError(BaseModel): page: int; message: str
class Plan(BaseModel):
    papersync_plan: Literal[1] = 1; created: datetime; inputs: list[str]
    changes: list[Change]; errors: list[PlanError]
    def to_json(self) -> str; @classmethod def from_json(cls, text: str) -> "Plan"
def scanned_block(text: str, day: date) -> str
```

- [ ] **Step 1: Write the failing tests**

```python
from datetime import date, datetime

from papersync.model import Change, Plan, scanned_block


def test_plan_round_trip() -> None:
    plan = Plan(
        created=datetime(2026, 9, 7, 10, 0),
        inputs=["scan.pdf"],
        changes=[Change(kind="update", source="things", ref="U1", title="FOO", marks=["A"])],
        errors=[],
    )
    text = plan.to_json()
    assert '"papersync_plan": 1' in text
    assert Plan.from_json(text) == plan


def test_from_json_reports_field_path() -> None:
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError) as info:
        Plan.from_json('{"papersync_plan": 1, "created": "x", "inputs": [], "changes": [], "errors": []}')
    assert "created" in str(info.value)


def test_scanned_block() -> None:
    assert scanned_block("one\ntwo", date(2026, 9, 7)) == "\n\n## Scanned 2026-09-07\n\n> one\n> two"
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_model.py -q`
Expected: ImportError on `papersync.model`.

- [ ] **Step 3: Implement**

```python
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field


class Item(BaseModel):
    source: str
    ref: str
    title: str
    notes: str = ""


class BoxResult(BaseModel):
    fill: float
    checked: bool
    uncertain: bool


class Change(BaseModel):
    kind: Literal["update", "create"]
    source: str
    ref: str | None = None
    title: str
    complete: bool = False
    marks: list[str] = Field(default_factory=list)
    append_notes: str | None = None
    notes: str | None = None
    boxes: dict[str, BoxResult] = Field(default_factory=dict)
    pages: list[int] = Field(default_factory=list)


class PlanError(BaseModel):
    page: int
    message: str


class Plan(BaseModel):
    papersync_plan: Literal[1] = 1
    created: datetime
    inputs: list[str]
    changes: list[Change]
    errors: list[PlanError]

    def to_json(self) -> str:
        return self.model_dump_json(indent=2)

    @classmethod
    def from_json(cls, text: str) -> "Plan":
        return cls.model_validate_json(text)


def scanned_block(text: str, day: date) -> str:
    quoted = "\n".join(f"> {line}" for line in text.splitlines())
    return f"\n\n## Scanned {day.isoformat()}\n\n{quoted}"
```

- [ ] **Step 4: Run tests, lint, types**

Run: `uv run pytest -q && uv run ruff check . && uv run ruff format --check . && uv run ty check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add local/lib/papersync && git commit -m "papersync: core plan model"
```

---

### Task 3: QR payload URL

**Files:**
- Create: `src/papersync/payload.py`, `tests/test_payload.py`

**Interfaces:**
- Produces:

```python
SCHEME = "papersync:///"
NEW_REF = "new"
@dataclass(frozen=True)
class Payload:
    version: int; source: str; ref: str; size: str; boxes: int; page: int = 1; pages: int = 1
    def to_url(self) -> str
    @classmethod
    def parse(cls, text: str) -> "Payload"        # raises PayloadError
    @property
    def is_new(self) -> bool
class PayloadError(ValueError)
```

- [ ] **Step 1: Write the failing tests**

```python
import pytest

from papersync.payload import Payload, PayloadError


def test_single_page_url() -> None:
    p = Payload(version=1, source="things", ref="ABC", size="3x5", boxes=1)
    assert p.to_url() == "papersync:///v1/things/ABC?size=3x5&boxes=1"


def test_paginated_url_and_parse() -> None:
    p = Payload(version=1, source="things", ref="ABC", size="letter", boxes=2, page=2, pages=3)
    url = p.to_url()
    assert url == "papersync:///v1/things/ABC?size=letter&boxes=2&page=2&pages=3"
    assert Payload.parse(url) == p


def test_new_card() -> None:
    p = Payload.parse("papersync:///v1/things/new?size=3x5&boxes=1")
    assert p.is_new and p.page == 1 and p.pages == 1


@pytest.mark.parametrize(
    "bad",
    [
        "https://example.com",
        "papersync:///v9/things/ABC?size=3x5&boxes=1",
        "papersync:///v1/things/ABC?boxes=1",
        "papersync:///v1/things/ABC?size=3x5&boxes=x",
        "papersync:///v1/things?size=3x5&boxes=1",
    ],
)
def test_rejects(bad: str) -> None:
    with pytest.raises(PayloadError):
        Payload.parse(bad)


def test_longest_payload_fits_qr_version_5() -> None:
    p = Payload(version=1, source="things", ref="A" * 22, size="letter", boxes=1, page=10, pages=12)
    assert len(p.to_url().encode()) <= 84
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_payload.py -q` — ImportError.

- [ ] **Step 3: Implement**

```python
from dataclasses import dataclass
from urllib.parse import parse_qs, urlsplit

SCHEME = "papersync:///"
NEW_REF = "new"
SUPPORTED_VERSIONS = {1}


class PayloadError(ValueError):
    pass


@dataclass(frozen=True)
class Payload:
    version: int
    source: str
    ref: str
    size: str
    boxes: int
    page: int = 1
    pages: int = 1

    @property
    def is_new(self) -> bool:
        return self.ref == NEW_REF

    def to_url(self) -> str:
        url = f"{SCHEME}v{self.version}/{self.source}/{self.ref}?size={self.size}&boxes={self.boxes}"
        if self.pages > 1:
            url += f"&page={self.page}&pages={self.pages}"
        return url

    @classmethod
    def parse(cls, text: str) -> "Payload":
        if not text.startswith(SCHEME):
            raise PayloadError(f"not a papersync URL: {text!r}")
        parts = urlsplit(text)
        segments = parts.path.strip("/").split("/")
        if len(segments) != 3 or not segments[0].startswith("v"):
            raise PayloadError(f"expected /v<n>/<source>/<ref>: {text!r}")
        try:
            version = int(segments[0][1:])
        except ValueError as exc:
            raise PayloadError(f"bad version in {text!r}") from exc
        if version not in SUPPORTED_VERSIONS:
            raise PayloadError(f"unsupported template version v{version}")
        query = {k: v[-1] for k, v in parse_qs(parts.query).items()}
        try:
            size = query["size"]
            boxes = int(query["boxes"])
            page = int(query.get("page", "1"))
            pages = int(query.get("pages", "1"))
        except (KeyError, ValueError) as exc:
            raise PayloadError(f"bad query in {text!r}: {exc}") from exc
        return cls(version, segments[1], segments[2], size, boxes, page, pages)
```

- [ ] **Step 4: Run tests, lint, types** — all pass.

- [ ] **Step 5: Commit** — `git commit -m "papersync: QR payload URL"`

---

### Task 4: Configuration, XDG directories, box set registry

**Files:**
- Create: `src/papersync/config.py`, `src/papersync/boxsets.py`, `tests/test_config.py`, `tests/test_boxsets.py`

**Interfaces:**
- Produces:

```python
# config.py
class Action(BaseModel): tags: list[str] = []; when: str | None = None; deadline: str | None = None
                         list: str | None = None; completed: bool | None = None; canceled: bool | None = None
class RenderConfig(BaseModel): size: str = "auto"; overflow: str = "fail"
                               boxes: list[str] = ["A","B","C","D"]; output_dir: str = "."; open: bool = True
class ThingsConfig(BaseModel): actions: dict[str, Action] = {}
class Config(BaseModel): render: RenderConfig = RenderConfig(); things: ThingsConfig = ThingsConfig()
def config_dir() -> Path      # $XDG_CONFIG_HOME/papersync or ~/.config/papersync
def state_dir() -> Path       # $XDG_STATE_HOME/papersync or ~/.local/state/papersync
def load_config(path: Path | None = None) -> Config
# boxsets.py
class BoxSetRegistry:
    def __init__(self, path: Path)
    def id_for(self, labels: list[str]) -> int      # reuse or append, never rewrite
    def labels_for(self, set_id: int) -> list[str] | None
```

- [ ] **Step 1: Write the failing tests**

`tests/test_config.py`:

```python
from pathlib import Path

from papersync.config import config_dir, load_config, state_dir


def test_defaults_when_file_missing(tmp_path: Path) -> None:
    cfg = load_config(tmp_path / "missing.toml")
    assert cfg.render.size == "auto"
    assert cfg.render.boxes == ["A", "B", "C", "D"]
    assert cfg.things.actions == {}


def test_parses_actions(tmp_path: Path) -> None:
    p = tmp_path / "config.toml"
    p.write_text('[render]\nsize = "3x5"\n[things.actions]\ntoday = { when = "today" }\n')
    cfg = load_config(p)
    assert cfg.render.size == "3x5"
    assert cfg.things.actions["today"].when == "today"


def test_xdg_dirs(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("XDG_CONFIG_HOME", "/x/cfg")
    monkeypatch.setenv("XDG_STATE_HOME", "/x/state")
    assert config_dir() == Path("/x/cfg/papersync")
    assert state_dir() == Path("/x/state/papersync")
```

`tests/test_boxsets.py`:

```python
from pathlib import Path

from papersync.boxsets import BoxSetRegistry


def test_assigns_and_reuses_ids(tmp_path: Path) -> None:
    reg = BoxSetRegistry(tmp_path / "boxsets.toml")
    assert reg.id_for(["A", "B"]) == 1
    assert reg.id_for(["waiting", "today"]) == 2
    assert reg.id_for(["A", "B"]) == 1
    assert reg.labels_for(2) == ["waiting", "today"]
    assert reg.labels_for(9) is None


def test_persists_across_instances(tmp_path: Path) -> None:
    path = tmp_path / "boxsets.toml"
    BoxSetRegistry(path).id_for(["A"])
    again = BoxSetRegistry(path)
    assert again.labels_for(1) == ["A"]
    assert again.id_for(["B"]) == 2
    text = path.read_text()
    assert text.count("[[sets]]") == 2 and 'labels = ["A"]' in text


def test_never_rewrites_existing_set(tmp_path: Path) -> None:
    path = tmp_path / "boxsets.toml"
    path.write_text('[[sets]]\nid = 1\nlabels = ["A"]\ncreated = "2026-01-01T00:00:00Z"\n')
    reg = BoxSetRegistry(path)
    reg.id_for(["B"])
    assert path.read_text().startswith('[[sets]]\nid = 1\nlabels = ["A"]\ncreated = "2026-01-01T00:00:00Z"\n')
```

- [ ] **Step 2: Run to verify failure** — ImportError.

- [ ] **Step 3: Implement**

`src/papersync/config.py`:

```python
import os
import tomllib
from pathlib import Path

from pydantic import BaseModel, Field


class Action(BaseModel):
    tags: list[str] = Field(default_factory=list)
    when: str | None = None
    deadline: str | None = None
    list: str | None = None
    completed: bool | None = None
    canceled: bool | None = None


class RenderConfig(BaseModel):
    size: str = "auto"
    overflow: str = "fail"
    boxes: list[str] = Field(default_factory=lambda: ["A", "B", "C", "D"])
    output_dir: str = "."
    open: bool = True


class ThingsConfig(BaseModel):
    actions: dict[str, Action] = Field(default_factory=dict)


class Config(BaseModel):
    render: RenderConfig = Field(default_factory=RenderConfig)
    things: ThingsConfig = Field(default_factory=ThingsConfig)


def _xdg(var: str, default: str) -> Path:
    return Path(os.environ.get(var) or Path.home() / default) / "papersync"


def config_dir() -> Path:
    return _xdg("XDG_CONFIG_HOME", ".config")


def state_dir() -> Path:
    return _xdg("XDG_STATE_HOME", ".local/state")


def load_config(path: Path | None = None) -> Config:
    path = path or config_dir() / "config.toml"
    if not path.exists():
        return Config()
    with path.open("rb") as fh:
        return Config.model_validate(tomllib.load(fh))
```

`src/papersync/boxsets.py`:

```python
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
            fh.write(f"[[sets]]\nid = {set_id}\nlabels = {json.dumps(labels)}\ncreated = \"{created}\"\n")
        return set_id
```

Note: `json.dumps` of a list of strings is valid TOML array syntax, and appending keeps existing entries byte-identical.

- [ ] **Step 4: Run tests, lint, types** — all pass.

- [ ] **Step 5: Commit** — `git commit -m "papersync: config and box set registry"`

---

### Task 5: Template v1 geometry, fonts and QR SVG

**Files:**
- Create: `src/papersync/render/__init__.py`, `src/papersync/render/qr.py`, `src/papersync/render/templates/__init__.py`, `src/papersync/render/templates/v1/__init__.py`, `src/papersync/render/templates/v1/layout.py`, `src/papersync/render/templates/v1/fonts/NewCMSans10-Regular.otf`, `.../NewCMSans10-Bold.otf`, `.../fonts/LICENSE.txt`, `tests/test_layout.py`, `tests/test_qr.py`

**Interfaces:**
- Produces:

```python
# layout.py (all lengths in millimeters, origin top-left, y down)
TEMPLATE_VERSION = 1
FILL_LOW = 0.06; FILL_HIGH = 0.20; BOX_INSET_MM = 0.7
FIDUCIAL_MM = 5.0; FIDUCIAL_INSET_MM = 4.0; QR_MM = 14.0; BOX_MM = 4.0; BOX_PITCH_MM = 14.0
@dataclass(frozen=True) class Rect: x: float; y: float; w: float; h: float
    @property center -> tuple[float, float]; def inset(self, d: float) -> "Rect"; def corners(self) -> list[tuple[float,float]]
@dataclass(frozen=True) class PageSize: name: str; width: float; height: float
SIZES: dict[str, PageSize]   # "3x5" 127x76.2, "4x6" 152.4x101.6, "letter" 215.9x279.4
SIZE_ORDER = ["3x5", "4x6", "letter"]
def fiducials(size: PageSize) -> list[Rect]      # TL, TR, BL, BR
def qr_rect(size) -> Rect
def done_box(size) -> Rect
def meta_box(size, index: int) -> Rect
def max_boxes(size) -> int
def title_bar(size) -> Rect
def notes_region(size) -> Rect
def footer_rect(size) -> Rect
def geometry(size: PageSize, labels: list[str]) -> dict[str, object]   # JSON for card.typ
# qr.py
def qr_svg(url: str) -> str
```

- [ ] **Step 1: Vendor the fonts**

```bash
d=src/papersync/render/templates/v1/fonts; mkdir -p $d
cp /usr/local/texlive/2026/texmf-dist/fonts/opentype/public/newcomputermodern/NewCMSans10-Regular.otf $d/
cp /usr/local/texlive/2026/texmf-dist/fonts/opentype/public/newcomputermodern/NewCMSans10-Bold.otf $d/
```

`fonts/LICENSE.txt`: "New Computer Modern Sans by Antonis Tsolomitis, distributed under the GUST Font License (GFL). Source: CTAN package newcomputermodern." Add `[tool.hatch.build.targets.wheel] artifacts = ["**/*.otf", "**/*.typ"]` to pyproject so they ship in the package.

- [ ] **Step 2: Write the failing tests**

`tests/test_layout.py`:

```python
from papersync.render.templates.v1 import layout as L


def test_sizes() -> None:
    assert L.SIZES["3x5"].width == 127.0 and L.SIZES["3x5"].height == 76.2
    assert L.SIZE_ORDER == ["3x5", "4x6", "letter"]


def test_fiducials_are_inset_squares() -> None:
    size = L.SIZES["3x5"]
    tl, tr, bl, br = L.fiducials(size)
    assert (tl.x, tl.y, tl.w, tl.h) == (4.0, 4.0, 5.0, 5.0)
    assert br.center == (127.0 - 6.5, 76.2 - 6.5)
    assert tr.x == 127.0 - 9.0 and bl.y == 76.2 - 9.0


def test_qr_is_inside_bottom_right_frame() -> None:
    size = L.SIZES["3x5"]
    q = L.qr_rect(size)
    br = L.fiducials(size)[3]
    assert q.x + q.w < br.x and q.y + q.h < br.y


def test_meta_boxes_never_reach_qr() -> None:
    for size in L.SIZES.values():
        last = L.meta_box(size, L.max_boxes(size) - 1)
        assert last.x + last.w + 2.0 < L.qr_rect(size).x
    assert L.max_boxes(L.SIZES["3x5"]) == 6


def test_geometry_json_is_plain_numbers() -> None:
    g = L.geometry(L.SIZES["3x5"], ["A", "B"])
    assert g["width"] == 127.0 and len(g["meta_boxes"]) == 2
    assert all(isinstance(v, int | float | str | list | dict) for v in g.values())


def test_rect_inset_and_corners() -> None:
    r = L.Rect(10, 20, 4, 4).inset(1)
    assert (r.x, r.y, r.w, r.h) == (11, 21, 2, 2)
    assert r.corners() == [(11, 21), (13, 21), (13, 23), (11, 23)]
```

`tests/test_qr.py`:

```python
from papersync.render.qr import qr_svg


def test_svg_has_no_border_and_fixed_version() -> None:
    svg = qr_svg("papersync:///v1/things/ABC?size=3x5&boxes=1")
    assert svg.startswith("<?xml") or svg.startswith("<svg")
    assert 'width="37"' in svg  # version 5 = 37 modules, scale 1, border 0


def test_long_payload_falls_back_to_level_l() -> None:
    url = "papersync:///v1/things/" + "A" * 22 + "?size=letter&boxes=100&page=100&pages=100"
    assert 'width="37"' in qr_svg(url)
```

- [ ] **Step 3: Run to verify failure** — ImportError.

- [ ] **Step 4: Implement**

`layout.py`:

```python
"""Template v1 geometry. Millimeters, origin top-left, y grows downward."""

from dataclasses import dataclass

TEMPLATE_VERSION = 1
FILL_LOW = 0.06
FILL_HIGH = 0.20
BOX_INSET_MM = 0.7
FIDUCIAL_MM = 5.0
FIDUCIAL_INSET_MM = 4.0
QR_MM = 14.0
BOX_MM = 4.0
BOX_PITCH_MM = 14.0
MARGIN_MM = 12.0
TOP_MM = 22.0       # notes start
BOTTOM_MM = 27.0    # notes end, measured from bottom edge


@dataclass(frozen=True)
class Rect:
    x: float
    y: float
    w: float
    h: float

    @property
    def center(self) -> tuple[float, float]:
        return (self.x + self.w / 2, self.y + self.h / 2)

    def inset(self, d: float) -> "Rect":
        return Rect(self.x + d, self.y + d, self.w - 2 * d, self.h - 2 * d)

    def corners(self) -> list[tuple[float, float]]:
        return [
            (self.x, self.y),
            (self.x + self.w, self.y),
            (self.x + self.w, self.y + self.h),
            (self.x, self.y + self.h),
        ]

    def as_dict(self) -> dict[str, float]:
        return {"x": self.x, "y": self.y, "w": self.w, "h": self.h}


@dataclass(frozen=True)
class PageSize:
    name: str
    width: float
    height: float


SIZES: dict[str, PageSize] = {
    "3x5": PageSize("3x5", 127.0, 76.2),
    "4x6": PageSize("4x6", 152.4, 101.6),
    "letter": PageSize("letter", 215.9, 279.4),
}
SIZE_ORDER = ["3x5", "4x6", "letter"]


def fiducials(size: PageSize) -> list[Rect]:
    i, f = FIDUCIAL_INSET_MM, FIDUCIAL_MM
    return [
        Rect(i, i, f, f),
        Rect(size.width - i - f, i, f, f),
        Rect(i, size.height - i - f, f, f),
        Rect(size.width - i - f, size.height - i - f, f, f),
    ]


def qr_rect(size: PageSize) -> Rect:
    edge = FIDUCIAL_INSET_MM + FIDUCIAL_MM + 2.0  # 11 mm from the page edge
    return Rect(size.width - edge - QR_MM, size.height - edge - QR_MM, QR_MM, QR_MM)


def done_box(size: PageSize) -> Rect:
    return Rect(MARGIN_MM, MARGIN_MM, BOX_MM, BOX_MM)


def title_bar(size: PageSize) -> Rect:
    return Rect(MARGIN_MM + BOX_MM + 2.0, MARGIN_MM - 1.0, size.width - MARGIN_MM - 28.0 - (MARGIN_MM + BOX_MM + 2.0), 6.0)


def footer_rect(size: PageSize) -> Rect:
    return Rect(size.width - MARGIN_MM - 26.0, MARGIN_MM, 26.0, 4.0)


def notes_region(size: PageSize) -> Rect:
    return Rect(MARGIN_MM, TOP_MM, size.width - 2 * MARGIN_MM, size.height - TOP_MM - BOTTOM_MM)


def meta_box(size: PageSize, index: int) -> Rect:
    return Rect(MARGIN_MM + index * BOX_PITCH_MM, size.height - MARGIN_MM, BOX_MM, BOX_MM)


def max_boxes(size: PageSize) -> int:
    limit = qr_rect(size).x - 2.0
    n = 0
    while meta_box(size, n).x + BOX_MM + 2.0 < limit:
        n += 1
    return n


def geometry(size: PageSize, labels: list[str]) -> dict[str, object]:
    return {
        "width": size.width,
        "height": size.height,
        "margin": MARGIN_MM,
        "top": TOP_MM,
        "bottom": BOTTOM_MM,
        "fiducials": [r.as_dict() for r in fiducials(size)],
        "qr": qr_rect(size).as_dict(),
        "done_box": done_box(size).as_dict(),
        "title_bar": title_bar(size).as_dict(),
        "footer": footer_rect(size).as_dict(),
        "meta_boxes": [
            {"rect": meta_box(size, i).as_dict(), "label": label} for i, label in enumerate(labels)
        ],
    }
```

`qr.py`:

```python
import io

import segno
from segno import DataOverflowError

QR_VERSION = 5


def qr_svg(url: str) -> str:
    """Render a QR at fixed version 5 so the printed footprint never changes."""
    try:
        code = segno.make(url, version=QR_VERSION, error="m", mode="byte", boost_error=False)
    except DataOverflowError:
        code = segno.make(url, version=QR_VERSION, error="l", mode="byte", boost_error=False)
    buf = io.BytesIO()
    code.save(buf, kind="svg", border=0, scale=1)
    return buf.getvalue().decode()
```

- [ ] **Step 5: Run tests, lint, types** — all pass.

- [ ] **Step 6: Commit** — `git commit -m "papersync: template v1 geometry, fonts, QR"`

---

### Task 6: Typst template and render engine

**Files:**
- Create: `src/papersync/render/templates/v1/card.typ`, `src/papersync/render/engine.py`, `tests/test_engine.py`

**Interfaces:**
- Consumes: `layout.geometry`, `qr_svg`, `Payload`, `Item`.
- Produces:

```python
@dataclass class RenderedItem: item: Item | None; size: str; pdf: bytes; pages: int; truncated: bool
@dataclass class RenderOptions: size: str = "auto"; overflow: str = "fail"; labels: list[str]; boxes_id: int
class OverflowError_(Exception)   # named RenderOverflow
def compile_pages(size: PageSize, labels: list[str], title: str, notes: str, qrs: list[str],
                  continuation_title: str, footer: str, lined: bool) -> tuple[bytes, int]
def render_item(item: Item, size_name: str, opts: RenderOptions, today: date) -> RenderedItem   # raises RenderOverflow
def render_auto(item: Item, opts: RenderOptions, today: date) -> RenderedItem
def render_new(count: int, size_name: str, opts: RenderOptions, today: date) -> list[RenderedItem]
def write_outputs(rendered: list[RenderedItem], out_dir: Path, stamp: str) -> list[Path]   # one PDF per size
```

- [ ] **Step 1: Write the Typst template**

`card.typ` reads one JSON document from `sys.inputs.data` with keys: `geometry` (from `layout.geometry`), `title`, `notes`, `qrs` (list of SVG strings, one per page), `continuation_title`, `footer`, `lined` (bool).

```typst
#let d = json(bytes(sys.inputs.data))
#let g = d.geometry
#let mm(v) = v * 1mm
#let rect_at(r, ..args) = place(top + left, dx: mm(r.x), dy: mm(r.y), rect(width: mm(r.w), height: mm(r.h), ..args))

#let chrome(page_no) = {
  for f in g.fiducials { rect_at(f, fill: black, stroke: none) }
  let qr = d.qrs.at(calc.min(page_no, d.qrs.len()) - 1)
  place(top + left, dx: mm(g.qr.x), dy: mm(g.qr.y), image(bytes(qr), width: mm(g.qr.w), height: mm(g.qr.h)))
  let total = d.qrs.len()
  let foot = if total > 1 { d.footer + " · " + str(page_no) + "/" + str(total) } else { d.footer }
  place(top + left, dx: mm(g.footer.x), dy: mm(g.footer.y),
    box(width: mm(g.footer.w), align(right, text(size: 6pt, fill: luma(110), font: "New Computer Modern Sans")[#foot])))
  if page_no == 1 {
    rect_at(g.done_box, stroke: 0.4pt)
    place(top + left, dx: mm(g.title_bar.x), dy: mm(g.title_bar.y),
      block(width: mm(g.title_bar.w), fill: luma(225), inset: 4pt,
        text(font: "New Computer Modern Sans", weight: "bold", size: 10pt)[#d.title]))
    for b in g.meta_boxes {
      rect_at(b.rect, stroke: 0.4pt)
      place(top + left, dx: mm(b.rect.x), dy: mm(b.rect.y + b.rect.h + 0.5),
        text(size: 6pt, font: "New Computer Modern Sans")[#b.label])
    }
  } else {
    place(top + left, dx: mm(g.title_bar.x), dy: mm(g.title_bar.y),
      block(width: mm(g.title_bar.w), fill: luma(225), inset: 4pt,
        text(font: "New Computer Modern Sans", weight: "bold", size: 10pt)[#d.continuation_title]))
  }
  if d.lined {
    let n = calc.floor((g.height - g.top - g.bottom) / 7)
    for i in range(n) {
      place(top + left, dx: mm(g.margin), dy: mm(g.top + (i + 1) * 7),
        line(length: mm(g.width - 2 * g.margin), stroke: 0.2pt + luma(190)))
    }
  }
}

#set page(width: mm(g.width), height: mm(g.height),
  margin: (top: mm(g.top), bottom: mm(g.bottom), left: mm(g.margin), right: mm(g.margin)),
  background: context chrome(counter(page).get().first()))
#set text(font: "New Computer Modern", size: 10pt)
#set par(leading: 0.55em, spacing: 0.9em)

#if not d.lined [
  #for line in d.notes.split("\n") [#line \ ]
]
```

Strings inserted with `[#d.title]` are Typst values, never parsed as markup. The `\ ` after each line preserves line breaks. The footer is the print date, and on paginated items the template appends ` · page/total` itself, so one footer string serves every page.

- [ ] **Step 2: Write the failing tests**

```python
from datetime import date
from pathlib import Path

import pymupdf
import pytest

from papersync.model import Item
from papersync.render import engine
from papersync.render.templates.v1 import layout as L

OPTS = engine.RenderOptions(labels=["A", "B"], boxes_id=1)
TODAY = date(2026, 9, 7)


def _item(notes: str) -> Item:
    return Item(source="things", ref="A" * 22, title="Buy *milk* #eggs", notes=notes)


def test_short_item_fits_3x5() -> None:
    r = engine.render_auto(_item("one line"), OPTS, TODAY)
    assert r.size == "3x5" and r.pages == 1
    doc = pymupdf.open("pdf", r.pdf)
    assert doc.page_count == 1
    assert abs(doc[0].rect.width - 127 / 25.4 * 72) < 1


def test_long_item_goes_to_letter_and_paginates() -> None:
    r = engine.render_auto(_item("\n".join(f"line {i}" for i in range(400))), OPTS, TODAY)
    assert r.size == "letter" and r.pages > 1


def test_forced_size_fail() -> None:
    with pytest.raises(engine.RenderOverflow):
        engine.render_item(_item("\n".join(["x"] * 50)), "3x5", OPTS, TODAY)


def test_forced_size_paginate() -> None:
    opts = engine.RenderOptions(labels=["A"], boxes_id=1, overflow="paginate")
    r = engine.render_item(_item("\n".join(["x"] * 50)), "3x5", opts, TODAY)
    assert r.pages >= 2
    text = "".join(p.get_text() for p in pymupdf.open("pdf", r.pdf))
    assert "(cont.)" in text and f"2/{r.pages}" in text


def test_forced_size_truncate() -> None:
    opts = engine.RenderOptions(labels=["A"], boxes_id=1, overflow="truncate")
    r = engine.render_item(_item("\n".join(["x"] * 50)), "3x5", opts, TODAY)
    assert r.pages == 1 and r.truncated
    assert "[…]" in pymupdf.open("pdf", r.pdf)[0].get_text()


def test_too_many_labels_raises() -> None:
    opts = engine.RenderOptions(labels=[str(i) for i in range(10)], boxes_id=1)
    with pytest.raises(engine.RenderOverflow):
        engine.render_item(_item(""), "3x5", opts, TODAY)


def test_auto_moves_up_when_labels_do_not_fit() -> None:
    opts = engine.RenderOptions(labels=[str(i) for i in range(7)], boxes_id=1)
    assert engine.render_auto(_item("x"), opts, TODAY).size == "4x6"


def test_new_cards() -> None:
    cards = engine.render_new(2, "3x5", OPTS, TODAY)
    assert len(cards) == 2 and all(c.item is None and c.pages == 1 for c in cards)


def test_write_outputs_groups_by_size(tmp_path: Path) -> None:
    a = engine.render_auto(_item("a"), OPTS, TODAY)
    b = engine.render_auto(_item("b"), OPTS, TODAY)
    c = engine.render_auto(_item("\n".join(["x"] * 400)), OPTS, TODAY)
    paths = engine.write_outputs([a, b, c], tmp_path, "20260907-100000")
    names = sorted(p.name for p in paths)
    assert names == ["papersync-20260907-100000-3x5.pdf", "papersync-20260907-100000-letter.pdf"]
    assert pymupdf.open(tmp_path / names[0]).page_count == 2


def test_max_boxes_matches_layout() -> None:
    assert L.max_boxes(L.SIZES["3x5"]) == 6
```

- [ ] **Step 3: Run to verify failure** — ImportError.

- [ ] **Step 4: Implement `engine.py`**

```python
import json
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import pymupdf
import typst

from papersync.model import Item
from papersync.payload import NEW_REF, Payload
from papersync.render.qr import qr_svg
from papersync.render.templates.v1 import layout as L

TEMPLATE_DIR = Path(__file__).parent / "templates" / "v1"
TEMPLATE = TEMPLATE_DIR / "card.typ"
FONT_DIR = TEMPLATE_DIR / "fonts"
TRUNCATION_MARK = "[…]"


class RenderOverflow(Exception):
    pass


@dataclass
class RenderOptions:
    labels: list[str] = field(default_factory=list)
    boxes_id: int = 1
    size: str = "auto"
    overflow: str = "fail"


@dataclass
class RenderedItem:
    item: Item | None
    size: str
    pdf: bytes
    pages: int
    truncated: bool = False


def compile_pages(
    size: L.PageSize,
    labels: list[str],
    title: str,
    notes: str,
    qrs: list[str],
    continuation_title: str,
    footer: str,
    lined: bool,
) -> tuple[bytes, int]:
    data = {
        "geometry": L.geometry(size, labels),
        "title": title,
        "notes": notes,
        "qrs": qrs,
        "continuation_title": continuation_title,
        "footer": footer,
        "lined": lined,
    }
    pdf = typst.compile(
        str(TEMPLATE), sys_inputs={"data": json.dumps(data)}, font_paths=[str(FONT_DIR)]
    )
    assert isinstance(pdf, bytes)
    return pdf, pymupdf.open("pdf", pdf).page_count


def _payloads(ref: str, size: str, boxes_id: int, pages: int) -> list[str]:
    return [
        qr_svg(Payload(L.TEMPLATE_VERSION, "things", ref, size, boxes_id, p, pages).to_url())
        for p in range(1, pages + 1)
    ]


def _compile_item(
    item: Item, size: L.PageSize, opts: RenderOptions, today: date, notes: str
) -> tuple[bytes, int]:
    footer_base = today.isoformat()
    pdf, pages = compile_pages(
        size, opts.labels, item.title, notes, _payloads(item.ref, size.name, opts.boxes_id, 1),
        f"{item.title} (cont.)", footer_base, False,
    )
    if pages == 1:
        return pdf, 1
    qrs = _payloads(item.ref, size.name, opts.boxes_id, pages)
    return compile_pages(
        size, opts.labels, item.title, notes, qrs, f"{item.title} (cont.)", footer_base, False
    )


def _check_labels(size: L.PageSize, opts: RenderOptions) -> None:
    if len(opts.labels) > L.max_boxes(size):
        raise RenderOverflow(
            f"{len(opts.labels)} box labels do not fit on {size.name} (max {L.max_boxes(size)})"
        )


def render_item(item: Item, size_name: str, opts: RenderOptions, today: date) -> RenderedItem:
    size = L.SIZES[size_name]
    _check_labels(size, opts)
    pdf, pages = _compile_item(item, size, opts, today, item.notes)
    if pages == 1 or opts.overflow == "paginate":
        return RenderedItem(item, size_name, pdf, pages)
    if opts.overflow == "fail":
        raise RenderOverflow(f"{item.title!r} does not fit on {size_name}")
    lines = item.notes.splitlines()
    lo, hi = 0, len(lines)
    best: bytes | None = None
    while lo < hi:  # largest prefix of lines that fits with the mark
        mid = (lo + hi + 1) // 2
        candidate = "\n".join([*lines[:mid], TRUNCATION_MARK])
        pdf, pages = _compile_item(item, size, opts, today, candidate)
        if pages == 1:
            best, lo = pdf, mid
        else:
            hi = mid - 1
    if best is None:
        best, _ = _compile_item(item, size, opts, today, TRUNCATION_MARK)
    return RenderedItem(item, size_name, best, 1, truncated=True)


def render_auto(item: Item, opts: RenderOptions, today: date) -> RenderedItem:
    for name in L.SIZE_ORDER[:-1]:
        try:
            return render_item(item, name, RenderOptions(opts.labels, opts.boxes_id, name, "fail"), today)
        except RenderOverflow:
            continue  # content or box labels do not fit: try the next size
    return render_item(item, "letter", RenderOptions(opts.labels, opts.boxes_id, "letter", "paginate"), today)


def render_new(count: int, size_name: str, opts: RenderOptions, today: date) -> list[RenderedItem]:
    size = L.SIZES[size_name]
    _check_labels(size, opts)
    qrs = _payloads(NEW_REF, size_name, opts.boxes_id, 1)
    pdf, pages = compile_pages(size, opts.labels, "", "", qrs, "", today.isoformat(), True)
    return [RenderedItem(None, size_name, pdf, pages) for _ in range(count)]


def write_outputs(rendered: list[RenderedItem], out_dir: Path, stamp: str) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for name in L.SIZE_ORDER:
        group = [r for r in rendered if r.size == name]
        if not group:
            continue
        doc = pymupdf.open()
        for r in group:
            doc.insert_pdf(pymupdf.open("pdf", r.pdf))
        path = out_dir / f"papersync-{stamp}-{name}.pdf"
        doc.save(path)
        paths.append(path)
    return paths
```

Note on `render_auto`: the 3x5 and 4x6 attempts use `overflow="fail"` so a multi-page result moves to the next size, and letter always paginates. A label-count overflow also moves to the next size, because larger sizes fit more boxes (6, 8 and 13); only a letter overflow raises.

- [ ] **Step 5: Run tests, lint, types** — all pass. If `typst.compile` type stubs make ty complain about `sys_inputs`, add a `# ty: ignore` on that call with a comment naming the missing stub.

- [ ] **Step 6: Look at one card**

Run: `uv run python -c "from datetime import date; from papersync.model import Item; from papersync.render import engine; r=engine.render_auto(Item(source='things',ref='A'*22,title='Sample',notes='one\ntwo'), engine.RenderOptions(['A','B','C']), date.today()); open('/tmp/card.pdf','wb').write(r.pdf)" && open /tmp/card.pdf`
Expected: fiducials in the corners, grey title bar with a box on its left, QR bottom right, three labelled boxes bottom left, date top right.

- [ ] **Step 7: Commit** — `git commit -m "papersync: Typst template and render engine"`

---

### Task 7: Ledger and status

**Files:**
- Create: `src/papersync/ledger.py`, `tests/test_ledger.py`

**Interfaces:**
- Produces:

```python
class LedgerEntry(BaseModel): ts: datetime; event: Literal["render","apply","forget"]; source: str
                              ref: str; title: str = ""; size: str = ""; boxes: int = 0; file: str = ""
class Ledger:
    def __init__(self, path: Path)
    def record(self, entry: LedgerEntry) -> None
    def outstanding(self) -> list[LedgerEntry]    # latest render per (source, ref) with no later apply/forget
```

- [ ] **Step 1: Write the failing tests**

```python
from datetime import datetime
from pathlib import Path

from papersync.ledger import Ledger, LedgerEntry


def _e(event: str, ref: str, ts: int) -> LedgerEntry:
    return LedgerEntry(ts=datetime(2026, 9, 7, 0, 0, ts), event=event, source="things", ref=ref, title=ref)  # type: ignore[arg-type]


def test_outstanding(tmp_path: Path) -> None:
    led = Ledger(tmp_path / "prints.jsonl")
    led.record(_e("render", "A", 1))
    led.record(_e("render", "B", 2))
    led.record(_e("apply", "A", 3))
    led.record(_e("render", "A", 4))
    led.record(_e("render", "C", 5))
    led.record(_e("forget", "C", 6))
    assert [e.ref for e in led.outstanding()] == ["B", "A"]


def test_persists(tmp_path: Path) -> None:
    path = tmp_path / "prints.jsonl"
    Ledger(path).record(_e("render", "A", 1))
    assert Ledger(path).outstanding()[0].ref == "A"
    assert path.read_text().count("\n") == 1
```

- [ ] **Step 2: Run to verify failure** — ImportError.

- [ ] **Step 3: Implement**

```python
from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel


class LedgerEntry(BaseModel):
    ts: datetime
    event: Literal["render", "apply", "forget"]
    source: str
    ref: str
    title: str = ""
    size: str = ""
    boxes: int = 0
    file: str = ""


class Ledger:
    def __init__(self, path: Path) -> None:
        self.path = path

    def _entries(self) -> list[LedgerEntry]:
        if not self.path.exists():
            return []
        return [LedgerEntry.model_validate_json(line) for line in self.path.read_text().splitlines() if line]

    def record(self, entry: LedgerEntry) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a") as fh:
            fh.write(entry.model_dump_json() + "\n")

    def outstanding(self) -> list[LedgerEntry]:
        latest: dict[tuple[str, str], LedgerEntry] = {}
        for entry in sorted(self._entries(), key=lambda e: e.ts):
            key = (entry.source, entry.ref)
            if entry.event == "render":
                latest[key] = entry
            else:
                latest.pop(key, None)
        return sorted(latest.values(), key=lambda e: e.ts)
```

- [ ] **Step 4: Run tests, lint, types** — all pass.

- [ ] **Step 5: Commit** — `git commit -m "papersync: print ledger"`

---

### Task 8: Things database reader and source

**Files:**
- Create: `src/papersync/integrations/__init__.py`, `src/papersync/integrations/base.py`, `src/papersync/integrations/things/__init__.py`, `src/papersync/integrations/things/db.py`, `src/papersync/integrations/things/source.py`, `tests/__init__.py`, `tests/things_fixture.py`, `tests/test_things_db.py`, `tests/test_things_source.py`

**Interfaces:**
- Produces:

```python
# base.py
class Source(Protocol):
    name: str
    def export(self, selector: str) -> list[Item]: ...
    def lookup(self, refs: list[str]) -> dict[str, Item]: ...
class Sink(Protocol):
    name: str
    def describe(self, change: Change) -> list[str]: ...      # display lines after the header
    def apply(self, changes: list[Change]) -> None: ...
    def verify(self, changes: list[Change]) -> list[str]: ...
    def mark_printed(self, refs: list[str]) -> None: ...      # state tag on render
    def check(self) -> list[str]: ...
# db.py
STATUS_TODO, STATUS_CANCELED, STATUS_DONE = 0, 2, 3
TYPE_TASK, TYPE_PROJECT = 0, 1
START_INBOX, START_ANYTIME, START_SOMEDAY = 0, 1, 2
def pack_date(d: date) -> int; def unpack_date(n: int | None) -> date | None
class TaskRow(BaseModel): uuid; title; notes; status; start; start_date: date | None; deadline: date | None
                          project: str | None; tags: list[str]
def find_db_path() -> Path            # raises ThingsDbNotFound with the expected glob in the message
class ThingsDb:
    def __init__(self, path: Path)
    def select(self, selector: str) -> list[TaskRow]   # inbox|next|someday|things:///show?id=UUID, raises ValueError
    def get(self, uuid: str) -> TaskRow | None
    def get_many(self, uuids: list[str]) -> dict[str, TaskRow]
    def tag_titles(self) -> set[str]                   # every tag title in TMTag
# source.py
class ThingsSource: name = "things"; __init__(db: ThingsDb); export; lookup
```

There is no `registry.py`: with one integration a name lookup module is dead code. The CLI constructs `ThingsSource` and `ThingsSink` directly.

- [ ] **Step 1: Write the fixture and failing tests**

`tests/things_fixture.py`:

```python
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE TMTask (uuid TEXT PRIMARY KEY, creationDate REAL, type INTEGER, status INTEGER,
  stopDate REAL, trashed INTEGER, title TEXT, notes TEXT, start INTEGER, startDate INTEGER,
  deadline INTEGER, area TEXT, project TEXT);
CREATE TABLE TMTag (uuid TEXT PRIMARY KEY, title TEXT);
CREATE TABLE TMTaskTag (tasks TEXT NOT NULL, tags TEXT NOT NULL);
"""


def make_db(path: Path) -> Path:
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    rows = [
        ("P1", 1.0, 1, 0, None, 0, "Project One", "", 1, None, None, None, None),
        ("T1", 2.0, 0, 0, None, 0, "FOO", "", 0, None, None, None, None),
        ("T2", 3.0, 0, 0, None, 0, "BAR", "BAZ", 1, None, None, None, "P1"),
        ("T3", 4.0, 0, 0, None, 0, "Someday thing", "", 2, None, None, None, None),
        ("T4", 5.0, 0, 3, 6.0, 0, "Done thing", "", 1, None, None, None, None),
        ("T5", 6.0, 0, 0, None, 1, "Trashed", "", 0, None, None, None, None),
        ("T6", 7.0, 0, 0, None, 0, "Dated", "", 1, (2026 << 16) | (9 << 12) | (7 << 7), (2026 << 16) | (9 << 12) | (10 << 7), None, None),
    ]
    conn.executemany("INSERT INTO TMTask VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    conn.executemany(
        "INSERT INTO TMTag VALUES (?,?)",
        [("G1", "waiting"), ("G2", "papersync:meta:A"), ("G3", "papersync:scanned")],
    )
    conn.executemany(
        "INSERT INTO TMTaskTag VALUES (?,?)",
        [("T2", "G1"), ("T1", "G2"), ("T1", "G3"), ("T4", "G3"), ("T6", "G3")],
    )
    conn.commit()
    conn.close()
    return path
```

`tests/test_things_db.py`:

```python
from datetime import date
from pathlib import Path

import pytest

from papersync.integrations.things.db import ThingsDb, pack_date, unpack_date
from tests.things_fixture import make_db


@pytest.fixture
def db(tmp_path: Path) -> ThingsDb:
    return ThingsDb(make_db(tmp_path / "main.sqlite"))


def test_dates() -> None:
    assert pack_date(date(2026, 9, 7)) == (2026 << 16) | (9 << 12) | (7 << 7)
    assert unpack_date(pack_date(date(2026, 9, 7))) == date(2026, 9, 7)
    assert unpack_date(None) is None


def test_select_inbox(db: ThingsDb) -> None:
    assert [t.uuid for t in db.select("inbox")] == ["T1"]


def test_select_next_includes_project_tasks(db: ThingsDb) -> None:
    assert [t.uuid for t in db.select("next")] == ["T2", "T6"]


def test_select_someday_and_project(db: ThingsDb) -> None:
    assert [t.uuid for t in db.select("someday")] == ["T3"]
    assert [t.uuid for t in db.select("things:///show?id=P1")] == ["T2"]


def test_select_rejects_unknown(db: ThingsDb) -> None:
    with pytest.raises(ValueError):
        db.select("bogus")


def test_get_includes_tags_and_dates(db: ThingsDb) -> None:
    t2 = db.get("T2")
    assert t2 is not None and t2.tags == ["waiting"] and t2.notes == "BAZ"
    t1 = db.get("T1")
    assert t1 is not None and t1.tags == ["papersync:meta:A", "papersync:scanned"]
    t6 = db.get("T6")
    assert t6 is not None and t6.start_date == date(2026, 9, 7) and t6.deadline == date(2026, 9, 10)
    assert db.get("nope") is None
    assert set(db.get_many(["T1", "T2", "zz"])) == {"T1", "T2"}


def test_tag_titles(db: ThingsDb) -> None:
    assert db.tag_titles() == {"waiting", "papersync:meta:A", "papersync:scanned"}
```

`tests/test_things_source.py`:

```python
from pathlib import Path

from papersync.integrations.things.db import ThingsDb
from papersync.integrations.things.source import ThingsSource
from tests.things_fixture import make_db


def test_export_and_lookup(tmp_path: Path) -> None:
    src = ThingsSource(ThingsDb(make_db(tmp_path / "main.sqlite")))
    items = src.export("next")
    assert [(i.ref, i.title, i.notes) for i in items] == [("T2", "BAR", "BAZ"), ("T6", "Dated", "")]
    assert items[0].source == "things"
    assert src.lookup(["T1"])["T1"].title == "FOO"
```

Add an empty `tests/__init__.py` so `from tests.things_fixture import make_db` resolves.

- [ ] **Step 2: Run to verify failure** — ImportError.

- [ ] **Step 3: Implement**

`base.py`:

```python
from typing import Protocol

from papersync.model import Change, Item


class Source(Protocol):
    name: str

    def export(self, selector: str) -> list[Item]: ...
    def lookup(self, refs: list[str]) -> dict[str, Item]: ...


class Sink(Protocol):
    name: str

    def describe(self, change: Change) -> list[str]: ...
    def apply(self, changes: list[Change]) -> None: ...
    def verify(self, changes: list[Change]) -> list[str]: ...
    def mark_printed(self, refs: list[str]) -> None: ...
    def check(self) -> list[str]: ...
```

`db.py`:

```python
import re
import sqlite3
from datetime import date
from pathlib import Path

from pydantic import BaseModel

STATUS_TODO, STATUS_CANCELED, STATUS_DONE = 0, 2, 3
TYPE_TASK, TYPE_PROJECT = 0, 1
START_INBOX, START_ANYTIME, START_SOMEDAY = 0, 1, 2
DB_GLOB = "Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite"
_SHOW_RE = re.compile(r"\Athings:///show\?id=(\w+)\Z")


class ThingsDbNotFound(FileNotFoundError):
    pass


def pack_date(d: date) -> int:
    return (d.year << 16) | (d.month << 12) | (d.day << 7)


def unpack_date(n: int | None) -> date | None:
    if not n:
        return None
    return date(n >> 16, (n >> 12) & 0xF, (n >> 7) & 0x1F)


class TaskRow(BaseModel):
    uuid: str
    title: str
    notes: str
    status: int
    start: int
    start_date: date | None
    deadline: date | None
    project: str | None
    tags: list[str]


def find_db_path() -> Path:
    matches = sorted(Path.home().glob(DB_GLOB))
    if not matches:
        raise ThingsDbNotFound(f"Things database not found under ~/{DB_GLOB}")
    return matches[0]


_BASE = f"""
SELECT TASK.uuid, TASK.title, TASK.notes, TASK.status, TASK.start, TASK.startDate, TASK.deadline, TASK.project
FROM TMTask TASK
LEFT JOIN TMTask PROJECT ON PROJECT.type = {TYPE_PROJECT} AND TASK.project = PROJECT.uuid
"""
_OPEN = f"TASK.trashed = 0 AND TASK.type = {TYPE_TASK} AND TASK.status = {STATUS_TODO}"


class ThingsDb:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)

    def _rows(self, where: str, params: tuple[object, ...] = ()) -> list[TaskRow]:
        cur = self._conn.execute(f"{_BASE} WHERE {where} ORDER BY TASK.creationDate", params)
        rows = [self._row(r) for r in cur.fetchall()]
        tags = self._tags([r.uuid for r in rows])
        for r in rows:
            r.tags = tags.get(r.uuid, [])
        return rows

    @staticmethod
    def _row(r: tuple[object, ...]) -> TaskRow:
        uuid, title, notes, status, start, start_date, deadline, project = r
        return TaskRow(
            uuid=str(uuid), title=str(title or ""), notes=str(notes or ""), status=int(status),  # type: ignore[arg-type]
            start=int(start or 0), start_date=unpack_date(start_date), deadline=unpack_date(deadline),  # type: ignore[arg-type]
            project=str(project) if project else None, tags=[],
        )

    def _tags(self, uuids: list[str]) -> dict[str, list[str]]:
        if not uuids:
            return {}
        marks = ",".join("?" * len(uuids))
        cur = self._conn.execute(
            f"SELECT TT.tasks, T.title FROM TMTaskTag TT JOIN TMTag T ON T.uuid = TT.tags "
            f"WHERE TT.tasks IN ({marks}) ORDER BY T.title",
            uuids,
        )
        out: dict[str, list[str]] = {}
        for task, title in cur.fetchall():
            out.setdefault(task, []).append(title)
        return out

    def select(self, selector: str) -> list[TaskRow]:
        if selector == "inbox":
            return self._rows(f"{_OPEN} AND TASK.start = {START_INBOX}")
        if selector in ("next", "someday"):
            start = START_ANYTIME if selector == "next" else START_SOMEDAY
            return self._rows(
                f"{_OPEN} AND ((TASK.start = {start} AND TASK.project IS NULL) OR PROJECT.start = {start})"
            )
        m = _SHOW_RE.match(selector)
        if m:
            return self._rows(f"{_OPEN} AND PROJECT.uuid = ?", (m.group(1),))
        raise ValueError(f"unknown selector {selector!r}; use inbox, next, someday or things:///show?id=UUID")

    def get(self, uuid: str) -> TaskRow | None:
        rows = self._rows("TASK.uuid = ?", (uuid,))
        return rows[0] if rows else None

    def get_many(self, uuids: list[str]) -> dict[str, TaskRow]:
        return {u: row for u in uuids if (row := self.get(u)) is not None}

    def tag_titles(self) -> set[str]:
        return {str(title) for (title,) in self._conn.execute("SELECT title FROM TMTag")}
```

`source.py`:

```python
from papersync.integrations.things.db import ThingsDb
from papersync.model import Item


class ThingsSource:
    name = "things"

    def __init__(self, db: ThingsDb) -> None:
        self.db = db

    def export(self, selector: str) -> list[Item]:
        return [Item(source=self.name, ref=t.uuid, title=t.title, notes=t.notes) for t in self.db.select(selector)]

    def lookup(self, refs: list[str]) -> dict[str, Item]:
        return {
            u: Item(source=self.name, ref=u, title=t.title, notes=t.notes)
            for u, t in self.db.get_many(refs).items()
        }
```

- [ ] **Step 4: Run tests, lint, types** — all pass.

- [ ] **Step 5: Commit** — `git commit -m "papersync: Things database reader and source"`

---

### Task 9: Things auth and action resolution

**Files:**
- Create: `src/papersync/integrations/things/auth.py`, `src/papersync/integrations/things/actions.py`, `tests/test_things_auth.py`, `tests/test_things_actions.py`

**Interfaces:**
- Produces:

```python
# auth.py
SERVICE, ACCOUNT = "papersync", "things-auth-token"
def get_token(prompt: Callable[[str], str] = getpass.getpass, store: Any = keyring) -> str   # prompts and stores when missing
def set_token(token: str, store: Any = keyring) -> None
# actions.py
class ThingsUpdate(BaseModel): completed: bool = False; canceled: bool = False; tags: list[str] = []
                               when: str | None = None; deadline: str | None = None; list: str | None = None
def resolve(change: Change, cfg: ThingsConfig) -> tuple[ThingsUpdate, list[str]]   # (update, warnings)
def default_tag(label: str) -> str      # "papersync:meta:<label>"
```

- [ ] **Step 1: Write the failing tests**

`tests/test_things_auth.py`:

```python
from papersync.integrations.things import auth


class FakeStore:
    def __init__(self) -> None:
        self.data: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, account: str) -> str | None:
        return self.data.get((service, account))

    def set_password(self, service: str, account: str, value: str) -> None:
        self.data[(service, account)] = value


def test_prompts_and_stores_when_missing() -> None:
    store = FakeStore()
    token = auth.get_token(prompt=lambda _msg: "  secret \n", store=store)
    assert token == "secret"
    assert store.data[(auth.SERVICE, auth.ACCOUNT)] == "secret"
    assert auth.get_token(prompt=lambda _m: "never", store=store) == "secret"


def test_set_token_overwrites() -> None:
    store = FakeStore()
    auth.set_token("a", store=store)
    auth.set_token("b", store=store)
    assert auth.get_token(prompt=lambda _m: "x", store=store) == "b"
```

`tests/test_things_actions.py`:

```python
from papersync.config import Action, ThingsConfig
from papersync.integrations.things.actions import resolve
from papersync.model import Change


def _change(marks: list[str], complete: bool = False) -> Change:
    return Change(kind="update", source="things", ref="U", title="t", marks=marks, complete=complete)


def test_default_tag() -> None:
    upd, warnings = resolve(_change(["A"]), ThingsConfig())
    assert upd.tags == ["papersync:meta:A"] and warnings == []


def test_configured_actions_and_done_box() -> None:
    cfg = ThingsConfig(actions={"today": Action(when="today"), "waiting": Action(tags=["waiting"])})
    upd, _ = resolve(_change(["today", "waiting"], complete=True), cfg)
    assert upd.when == "today" and upd.tags == ["waiting"] and upd.completed


def test_conflict_last_wins_with_warning() -> None:
    cfg = ThingsConfig(actions={"today": Action(when="today"), "someday": Action(when="someday")})
    upd, warnings = resolve(_change(["today", "someday"]), cfg)
    assert upd.when == "someday"
    assert warnings == ["'someday' overrides when=today set by 'today'"]
```

- [ ] **Step 2: Run to verify failure** — ImportError.

- [ ] **Step 3: Implement**

`auth.py`:

```python
import getpass
from collections.abc import Callable
from typing import Any

import keyring

SERVICE = "papersync"
ACCOUNT = "things-auth-token"


def get_token(prompt: Callable[[str], str] = getpass.getpass, store: Any = keyring) -> str:
    token = store.get_password(SERVICE, ACCOUNT)
    if token:
        return token
    token = prompt("Things URL scheme auth token (Things > Settings > General > Enable Things URLs > Manage): ").strip()
    if not token:
        raise SystemExit("no token entered")
    store.set_password(SERVICE, ACCOUNT, token)
    return token


def set_token(token: str, store: Any = keyring) -> None:
    store.set_password(SERVICE, ACCOUNT, token.strip())
```

`actions.py`:

```python
from pydantic import BaseModel, Field

from papersync.config import Action, ThingsConfig
from papersync.model import Change

TAG_PREFIX = "papersync:meta:"


def default_tag(label: str) -> str:
    return f"{TAG_PREFIX}{label}"


class ThingsUpdate(BaseModel):
    completed: bool = False
    canceled: bool = False
    tags: list[str] = Field(default_factory=list)
    when: str | None = None
    deadline: str | None = None
    list: str | None = None


def resolve(change: Change, cfg: ThingsConfig) -> tuple[ThingsUpdate, list[str]]:
    upd = ThingsUpdate(completed=change.complete)
    owners: dict[str, str] = {}
    warnings: list[str] = []
    for label in change.marks:
        action = cfg.actions.get(label) or Action(tags=[default_tag(label)])
        for tag in action.tags:
            if tag not in upd.tags:
                upd.tags.append(tag)
        for field in ("when", "deadline", "list", "completed", "canceled"):
            value = getattr(action, field)
            if value is None:
                continue
            if field in owners:
                warnings.append(f"'{label}' overrides {field}={getattr(upd, field)} set by '{owners[field]}'")
            owners[field] = label
            setattr(upd, field, value)
    return upd, warnings
```

- [ ] **Step 4: Run tests, lint, types** — all pass.

- [ ] **Step 5: Commit** — `git commit -m "papersync: Things keychain auth and action resolution"`

---

### Task 10: Things sink (URLs, state tags, skip logic, verify)

**Files:**
- Create: `src/papersync/integrations/things/sink.py`, `tests/test_things_sink.py`

**Interfaces:**
- Consumes: `ThingsDb` (`get`, `tag_titles`), `resolve`, `get_token`, `Change`.
- Produces:

```python
STATE_PRINTED = "papersync:printed"; STATE_SCANNED = "papersync:scanned"; STATE_TAGS = {both}
class ThingsSink:
    name = "things"
    def __init__(self, db: ThingsDb, cfg: ThingsConfig, opener: Callable[[str], None] = _open_url,
                 token_provider: Callable[[], str] = get_token, sleeper: Callable[[float], None] = time.sleep,
                 runner: Callable[[str], None] = _run_osascript)
    def describe(self, change) -> list[str]
    def plan_urls(self, changes) -> list[tuple[Change, str | None]]     # None when nothing remains to do
    def ensure_tags(self, names: Iterable[str]) -> None                  # AppleScript-creates missing tags
    def apply(self, changes) -> None
    def mark_printed(self, refs: list[str]) -> None
    def verify(self, changes) -> list[str]
    def check(self) -> list[str]
def create_tags_script(names: list[str]) -> str
def build_update_url(ref: str, token: str, upd: ThingsUpdate, tags: list[str] | None, append_notes: str | None) -> str
def build_add_url(title: str, notes: str | None, upd: ThingsUpdate, tags: list[str]) -> str
```

State tags: an item carries exactly one of `papersync:printed` or `papersync:scanned`. `mark_printed` sets `printed`; `apply` sets `scanned`. Because the Things URL scheme's `tags` parameter replaces the whole list, the sink always sends the item's current tags (read from the database) with the state tags stripped, the action tags added, and the new state tag appended. Because the URL scheme silently ignores tags that do not exist, `ensure_tags` creates missing ones through `osascript` first.

- [ ] **Step 1: Write the failing tests**

```python
import sqlite3
from datetime import date
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from papersync.config import Action, ThingsConfig
from papersync.integrations.things.db import ThingsDb
from papersync.integrations.things.sink import (
    STATE_PRINTED,
    STATE_SCANNED,
    ThingsSink,
    create_tags_script,
)
from papersync.model import Change, scanned_block
from tests.things_fixture import make_db


class Captured:
    def __init__(self) -> None:
        self.urls: list[str] = []
        self.scripts: list[str] = []


@pytest.fixture
def cap() -> Captured:
    return Captured()


@pytest.fixture
def sink(tmp_path: Path, cap: Captured) -> ThingsSink:
    cfg = ThingsConfig(actions={"today": Action(when="today"), "due": Action(deadline="2026-09-10")})
    return ThingsSink(
        ThingsDb(make_db(tmp_path / "main.sqlite")), cfg, opener=cap.urls.append,
        token_provider=lambda: "TOK", sleeper=lambda _s: None, runner=cap.scripts.append,
    )


def _q(url: str) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}


def test_update_url_replaces_tags_and_sets_scanned(sink: ThingsSink, cap: Captured) -> None:
    # T1 currently has papersync:meta:A and papersync:scanned
    ch = Change(kind="update", source="things", ref="T1", title="FOO", complete=True, marks=["B", "today"],
                append_notes=scanned_block("hi there", date(2026, 9, 7)))
    sink.apply([ch])
    assert len(cap.urls) == 1 and cap.urls[0].startswith("things:///update?")
    q = _q(cap.urls[0])
    assert q["id"] == "T1" and q["auth-token"] == "TOK" and q["completed"] == "true"
    assert q["tags"] == "papersync:meta:A,papersync:meta:B,papersync:scanned"
    assert q["when"] == "today"
    assert q["append-notes"] == "\n\n## Scanned 2026-09-07\n\n> hi there"
    assert "add-tags" not in q


def test_swaps_printed_for_scanned(sink: ThingsSink, cap: Captured) -> None:
    # T2 has only "waiting"; give it the printed state first
    sink.mark_printed(["T2"])
    assert _q(cap.urls[0])["tags"] == f"waiting,{STATE_PRINTED}"
    with sqlite3.connect(sink.db.path) as c:
        c.execute("INSERT INTO TMTag VALUES ('G4', ?)", (STATE_PRINTED,))
        c.execute("INSERT INTO TMTaskTag VALUES ('T2', 'G4')")
    sink.apply([Change(kind="update", source="things", ref="T2", title="BAR")])
    assert _q(cap.urls[1])["tags"] == f"waiting,{STATE_SCANNED}"


def test_skips_what_already_holds(sink: ThingsSink, cap: Captured) -> None:
    # T1 already has tag papersync:meta:A and scanned; T4 is complete and scanned; T6 has deadline 2026-09-10 and scanned
    sink.apply([
        Change(kind="update", source="things", ref="T1", title="FOO", marks=["A"]),
        Change(kind="update", source="things", ref="T4", title="Done", complete=True),
        Change(kind="update", source="things", ref="T6", title="Dated", marks=["due"]),
    ])
    assert cap.urls == [] and cap.scripts == []


def test_skips_notes_block_already_present(tmp_path: Path, cap: Captured) -> None:
    db_path = make_db(tmp_path / "main.sqlite")
    block = scanned_block("x", date(2026, 9, 7))
    with sqlite3.connect(db_path) as c:
        c.execute("UPDATE TMTask SET notes = notes || ? WHERE uuid = 'T1'", (block,))
    s = ThingsSink(ThingsDb(db_path), ThingsConfig(), opener=cap.urls.append,
                   token_provider=lambda: "T", sleeper=lambda _s: None, runner=cap.scripts.append)
    s.apply([Change(kind="update", source="things", ref="T1", title="FOO", append_notes=block)])
    assert cap.urls == []


def test_creates_missing_tags_once(sink: ThingsSink, cap: Captured) -> None:
    sink.apply([
        Change(kind="update", source="things", ref="T2", title="BAR", marks=["B"]),
        Change(kind="update", source="things", ref="T3", title="Someday", marks=["B", "C"]),
    ])
    assert len(cap.scripts) == 1
    assert cap.scripts[0] == create_tags_script(["papersync:meta:B", "papersync:meta:C"])
    assert create_tags_script(["x"]) == 'tell application "Things3"\n  make new tag with properties {name:"x"}\nend tell'


def test_mark_printed(sink: ThingsSink, cap: Captured) -> None:
    sink.mark_printed(["T1", "T2", "missing"])
    assert cap.scripts == [create_tags_script([STATE_PRINTED])]
    assert [_q(u)["tags"] for u in cap.urls] == [f"papersync:meta:A,{STATE_PRINTED}", f"waiting,{STATE_PRINTED}"]
    assert all("auth-token=TOK" in u for u in cap.urls)


def test_create_url_needs_no_token(sink: ThingsSink, cap: Captured) -> None:
    sink.apply([Change(kind="create", source="things", title="New one", notes="body", marks=["A"])])
    q = _q(cap.urls[0])
    assert cap.urls[0].startswith("things:///add?") and "auth-token" not in q
    assert q["title"] == "New one" and q["notes"] == "body"
    assert q["tags"] == f"papersync:meta:A,{STATE_SCANNED}"


def test_describe_and_verify(sink: ThingsSink) -> None:
    ch = Change(kind="update", source="things", ref="T2", title="BAR", complete=True, marks=["today", "B"])
    assert sink.describe(ch) == [
        "+ completed", "+ today    when=today", "+ B        tag papersync:meta:B", f"+ state    {STATE_SCANNED}",
    ]
    # nothing was applied to the fixture, so verify reports every unmet part
    assert sink.verify([ch]) == [
        "BAR: not completed", "BAR: when=today not set", "BAR: tag papersync:meta:B missing",
        f"BAR: tag {STATE_SCANNED} missing",
    ]
```

- [ ] **Step 2: Run to verify failure** — ImportError.

- [ ] **Step 3: Implement**

`sink.py`:

```python
import subprocess
import time
from collections.abc import Callable, Iterable
from datetime import date
from urllib.parse import quote

from papersync.config import ThingsConfig
from papersync.integrations.things.actions import ThingsUpdate, default_tag, resolve
from papersync.integrations.things.auth import get_token
from papersync.integrations.things.db import (
    START_ANYTIME,
    START_SOMEDAY,
    STATUS_CANCELED,
    STATUS_DONE,
    TaskRow,
    ThingsDb,
)
from papersync.model import Change

VERIFY_DELAY_S = 2.0
STATE_PRINTED = "papersync:printed"
STATE_SCANNED = "papersync:scanned"
STATE_TAGS = {STATE_PRINTED, STATE_SCANNED}


def _open_url(url: str) -> None:
    subprocess.run(["open", "-g", url], check=True)


def _run_osascript(script: str) -> None:
    subprocess.run(["osascript", "-e", script], check=True, capture_output=True)


def create_tags_script(names: list[str]) -> str:
    body = "\n".join(
        '  make new tag with properties {name:"' + n.replace('"', '\\"') + '"}' for n in names
    )
    return 'tell application "Things3"\n' + body + "\nend tell"


def _encode(params: list[tuple[str, str]]) -> str:
    return "&".join(f"{k}={quote(v, safe='')}" for k, v in params)


def _action_params(upd: ThingsUpdate) -> list[tuple[str, str]]:
    params: list[tuple[str, str]] = []
    for key in ("when", "deadline", "list"):
        value = getattr(upd, key)
        if value:
            params.append((key, value))
    if upd.completed:
        params.append(("completed", "true"))
    if upd.canceled:
        params.append(("canceled", "true"))
    return params


def build_update_url(
    ref: str, token: str, upd: ThingsUpdate, tags: list[str] | None, append_notes: str | None
) -> str:
    params = [("id", ref), ("auth-token", token), *_action_params(upd)]
    if tags is not None:
        params.append(("tags", ",".join(tags)))
    if append_notes:
        params.append(("append-notes", append_notes))
    return "things:///update?" + _encode(params)


def build_add_url(title: str, notes: str | None, upd: ThingsUpdate, tags: list[str]) -> str:
    params = [("title", title)]
    if notes:
        params.append(("notes", notes))
    params.append(("tags", ",".join(tags)))
    params += _action_params(upd)
    return "things:///add?" + _encode(params)


def _new_tags(current: list[str], add: list[str], state: str) -> list[str] | None:
    """Current tags with state tags stripped, action tags added, and the new state tag. None if unchanged."""
    out = [t for t in current if t not in STATE_TAGS]
    out += [t for t in add if t not in out and t not in STATE_TAGS]
    out.append(state)
    return None if set(out) == set(current) else out


def _when_holds(row: TaskRow, when: str, today: date) -> bool:
    if when == "today":
        return row.start == START_ANYTIME and row.start_date == today
    if when == "someday":
        return row.start == START_SOMEDAY
    if when == "anytime":
        return row.start == START_ANYTIME and row.start_date is None
    return False


class ThingsSink:
    name = "things"

    def __init__(
        self,
        db: ThingsDb,
        cfg: ThingsConfig,
        opener: Callable[[str], None] = _open_url,
        token_provider: Callable[[], str] = get_token,
        sleeper: Callable[[float], None] = time.sleep,
        runner: Callable[[str], None] = _run_osascript,
    ) -> None:
        self.db = db
        self.cfg = cfg
        self.opener = opener
        self.token_provider = token_provider
        self.sleeper = sleeper
        self.runner = runner

    def ensure_tags(self, names: Iterable[str]) -> None:
        missing = sorted(set(names) - self.db.tag_titles())
        if missing:
            self.runner(create_tags_script(missing))

    def _remaining(self, change: Change, upd: ThingsUpdate) -> tuple[ThingsUpdate, list[str] | None, str | None]:
        """Drop the parts of an update that the database already shows."""
        row = self.db.get(change.ref or "")
        if row is None:
            return upd, [*upd.tags, STATE_SCANNED], change.append_notes
        left = upd.model_copy()
        if row.status == STATUS_DONE:
            left.completed = False
        if row.status == STATUS_CANCELED:
            left.canceled = False
        if upd.when and _when_holds(row, upd.when, date.today()):
            left.when = None
        if upd.deadline and row.deadline is not None and row.deadline.isoformat() == upd.deadline:
            left.deadline = None
        tags = _new_tags(row.tags, upd.tags, STATE_SCANNED)
        notes = change.append_notes
        if notes and notes in row.notes:
            notes = None
        return left, tags, notes

    def plan_urls(self, changes: list[Change]) -> list[tuple[Change, str | None]]:
        out: list[tuple[Change, str | None]] = []
        token: str | None = None
        for change in changes:
            upd, _ = resolve(change, self.cfg)
            if change.kind == "create":
                out.append((change, build_add_url(change.title, change.notes, upd, [*upd.tags, STATE_SCANNED])))
                continue
            left, tags, notes = self._remaining(change, upd)
            if not (left.completed or left.canceled or left.when or left.deadline or left.list or tags or notes):
                out.append((change, None))
                continue
            token = token or self.token_provider()
            out.append((change, build_update_url(change.ref or "", token, left, tags, notes)))
        return out

    def apply(self, changes: list[Change]) -> None:
        planned = [(c, u) for c, u in self.plan_urls(changes) if u]
        if not planned:
            return
        wanted = {STATE_SCANNED}
        for change, _url in planned:
            wanted.update(resolve(change, self.cfg)[0].tags)
        self.ensure_tags(wanted)
        for _change, url in planned:
            self.opener(url)

    def mark_printed(self, refs: list[str]) -> None:
        rows = [row for ref in refs if (row := self.db.get(ref)) is not None]
        updates = [(row.uuid, tags) for row in rows if (tags := _new_tags(row.tags, [], STATE_PRINTED))]
        if not updates:
            return
        self.ensure_tags([STATE_PRINTED])
        token = self.token_provider()
        for uuid, tags in updates:
            self.opener(build_update_url(uuid, token, ThingsUpdate(), tags, None))

    def describe(self, change: Change) -> list[str]:
        upd, warnings = resolve(change, self.cfg)
        lines = ["+ completed"] if change.complete else []
        for label in change.marks:
            action = self.cfg.actions.get(label)
            if action is None:
                lines.append(f"+ {label:<8} tag {default_tag(label)}")
                continue
            parts = [f"tag {t}" for t in action.tags]
            parts += [
                f"{k}={getattr(action, k)}"
                for k in ("when", "deadline", "list", "completed", "canceled")
                if getattr(action, k) is not None
            ]
            lines.append(f"+ {label:<8} {' '.join(parts)}")
        lines += [f"! {w}" for w in warnings]
        lines.append(f"+ state    {STATE_SCANNED}")
        return lines

    def verify(self, changes: list[Change]) -> list[str]:
        self.sleeper(VERIFY_DELAY_S)
        unmet: list[str] = []
        today = date.today()
        for change in changes:
            if change.kind == "create":
                continue
            upd, _ = resolve(change, self.cfg)
            row = self.db.get(change.ref or "")
            if row is None:
                unmet.append(f"{change.title}: item not found")
                continue
            if upd.completed and row.status != STATUS_DONE:
                unmet.append(f"{change.title}: not completed")
            if upd.canceled and row.status != STATUS_CANCELED:
                unmet.append(f"{change.title}: not canceled")
            if upd.when and not _when_holds(row, upd.when, today):
                unmet.append(f"{change.title}: when={upd.when} not set")
            if upd.deadline and (row.deadline is None or row.deadline.isoformat() != upd.deadline):
                unmet.append(f"{change.title}: deadline {upd.deadline} not set")
            unmet += [f"{change.title}: tag {t} missing" for t in [*upd.tags, STATE_SCANNED] if t not in row.tags]
            if STATE_PRINTED in row.tags:
                unmet.append(f"{change.title}: tag {STATE_PRINTED} still present")
            if change.append_notes and change.append_notes not in row.notes:
                unmet.append(f"{change.title}: notes not appended")
        return unmet

    def check(self) -> list[str]:
        problems: list[str] = []
        try:
            self.db.select("inbox")
        except Exception as exc:  # noqa: BLE001
            problems.append(f"Things database unreadable: {exc}")
        return problems
```

Note the freshness rule: `self.db` holds one read-only sqlite connection; sqlite sees Things' commits on each new statement, so no reconnect is needed for `verify`.

- [ ] **Step 4: Run tests, lint, types** — all pass.

- [ ] **Step 5: Commit** — `git commit -m "papersync: Things URL-scheme sink with state tags, skip and verify"`

---

### Task 11: Recognition primitives: raster, QR, homography, marks, OCR protocol

**Files:**
- Create: `src/papersync/recognize/__init__.py`, `raster.py`, `qr.py`, `geometry.py`, `marks.py`, `ocr.py`, `tests/synthetic.py`, `tests/test_recognize_primitives.py`

**Interfaces:**
- Consumes: `layout`, `Payload`, `engine.render_item` (tests only).
- Produces:

```python
# raster.py
DPI = 300
@dataclass class RasterPage: file: str; index: int; gray: np.ndarray   # uint8 HxW
def iter_pages(paths: list[Path]) -> Iterator[RasterPage]
# qr.py
@dataclass class DecodedQr: payload: Payload; corners: np.ndarray   # 4x2 float32 px: TL, TR, BR, BL of the symbol
def find_payload(gray) -> DecodedQr | None      # first papersync payload; ignores foreign codes
# geometry.py
def homography_from_qr(decoded: DecodedQr, size: PageSize) -> np.ndarray          # 3x3 mm->px
def refine_with_fiducials(gray, h0, size) -> np.ndarray | None                     # None if a fiducial is missing
def mm_to_px(h, x: float, y: float) -> tuple[float, float]
# marks.py
def box_fill(gray, h, rect: Rect) -> float
def classify(fill: float) -> BoxResult
# ocr.py
@dataclass class OcrLine: text: str; confidence: float; x: float; y: float; w: float; h: float   # px
class OcrBackend(Protocol): def recognize(self, gray: np.ndarray) -> list[OcrLine]: ...
class OcrmacBackend: recognize(...)     # imports ocrmac lazily; lines sorted top-to-bottom
def lines_in(lines, h, region: Rect) -> list[OcrLine]      # keep lines whose center falls inside region (mm)
def join_text(lines) -> str
```

- [ ] **Step 1: Write the synthetic scan helper and failing tests**

`tests/synthetic.py`:

```python
"""Turn a rendered card into a fake scan: rasterize, draw marks, rotate, scale."""

import cv2
import numpy as np
import pymupdf

from papersync.recognize.geometry import mm_to_px
from papersync.render.templates.v1 import layout as L


def rasterize(pdf: bytes, page: int = 0, dpi: int = 300) -> np.ndarray:
    pix = pymupdf.open("pdf", pdf)[page].get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width).copy()


def identity_h(dpi: int = 300) -> np.ndarray:
    s = dpi / 25.4
    return np.array([[s, 0, 0], [0, s, 0], [0, 0, 1]], dtype=np.float64)


def draw_x(gray: np.ndarray, rect: L.Rect, h: np.ndarray | None = None) -> None:
    h = identity_h() if h is None else h
    inner = rect.inset(0.5)
    tl, tr, br, bl = (mm_to_px(h, x, y) for x, y in inner.corners())
    for a, b in ((tl, br), (tr, bl)):
        cv2.line(gray, (int(a[0]), int(a[1])), (int(b[0]), int(b[1])), 0, 3)


def distort(gray: np.ndarray, angle_deg: float = 2.5, scale: float = 1.03) -> np.ndarray:
    hgt, wid = gray.shape
    m = cv2.getRotationMatrix2D((wid / 2, hgt / 2), angle_deg, scale)
    return cv2.warpAffine(gray, m, (wid, hgt), borderValue=255)


def handwriting_page(width: int = 1500, height: int = 1000) -> np.ndarray:
    """Height 1000 so tests can tell it from a 3x5 card raster (900 rows)."""
    page = np.full((height, width), 255, dtype=np.uint8)
    cv2.putText(page, "some handwriting", (200, 400), cv2.FONT_HERSHEY_SIMPLEX, 3, 0, 6)
    return page
```

`tests/test_recognize_primitives.py`:

```python
from datetime import date

import numpy as np

from papersync.model import Item
from papersync.recognize import geometry, marks, ocr
from papersync.recognize.qr import find_payload
from papersync.render import engine
from papersync.render.templates.v1 import layout as L
from tests import synthetic

SIZE = L.SIZES["3x5"]
OPTS = engine.RenderOptions(labels=["A", "B", "C"], boxes_id=1)


def _card(marked: list[L.Rect]) -> np.ndarray:
    item = Item(source="things", ref="A" * 22, title="FOO", notes="n")
    gray = synthetic.rasterize(engine.render_item(item, "3x5", OPTS, date(2026, 9, 7)).pdf)
    for r in marked:
        synthetic.draw_x(gray, r)
    return synthetic.distort(gray)


def test_qr_and_homography_recover_geometry() -> None:
    gray = _card([])
    decoded = find_payload(gray)
    assert decoded is not None and decoded.payload.ref == "A" * 22 and decoded.payload.size == "3x5"
    h0 = geometry.homography_from_qr(decoded, SIZE)
    h = geometry.refine_with_fiducials(gray, h0, SIZE)
    assert h is not None
    # the top-left fiducial center must land on dark pixels
    cx, cy = geometry.mm_to_px(h, *L.fiducials(SIZE)[0].center)
    assert gray[int(cy), int(cx)] < 60


def test_box_fill_distinguishes_marked_boxes() -> None:
    gray = _card([L.done_box(SIZE), L.meta_box(SIZE, 1)])
    decoded = find_payload(gray)
    assert decoded is not None
    h = geometry.refine_with_fiducials(gray, geometry.homography_from_qr(decoded, SIZE), SIZE)
    assert h is not None
    assert marks.classify(marks.box_fill(gray, h, L.done_box(SIZE))).checked
    assert marks.classify(marks.box_fill(gray, h, L.meta_box(SIZE, 1))).checked
    for i in (0, 2):
        res = marks.classify(marks.box_fill(gray, h, L.meta_box(SIZE, i)))
        assert not res.checked and not res.uncertain


def test_classify_bands() -> None:
    low, mid, high = marks.classify(0.01), marks.classify(0.10), marks.classify(0.5)
    assert (low.checked, low.uncertain) == (False, False)
    assert (mid.checked, mid.uncertain) == (False, True)
    assert (high.checked, high.uncertain) == (True, False)


def test_foreign_qr_is_ignored() -> None:
    import io

    import cv2
    import segno

    page = np.full((900, 1500), 255, dtype=np.uint8)
    buf = io.BytesIO()
    segno.make("https://example.com", error="m").save(buf, kind="png", scale=8, border=4)
    arr = cv2.imdecode(np.frombuffer(buf.getvalue(), np.uint8), cv2.IMREAD_GRAYSCALE)
    page[100 : 100 + arr.shape[0], 100 : 100 + arr.shape[1]] = arr
    assert find_payload(page) is None


def test_lines_in_and_join() -> None:
    h = synthetic.identity_h()
    region = L.notes_region(SIZE)
    inside = ocr.OcrLine("in", 0.9, *geometry.mm_to_px(h, region.x + 5, region.y + 5), 40, 10)
    outside = ocr.OcrLine("out", 0.9, *geometry.mm_to_px(h, 1, 1), 40, 10)
    kept = ocr.lines_in([outside, inside], h, region)
    assert [line.text for line in kept] == ["in"]
    assert ocr.join_text([inside, ocr.OcrLine("two", 0.9, 0, 999, 1, 1)]) == "in\ntwo"
```

- [ ] **Step 2: Run to verify failure** — ImportError.

- [ ] **Step 3: Implement**

`raster.py`:

```python
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pymupdf

DPI = 300


@dataclass
class RasterPage:
    file: str
    index: int
    gray: np.ndarray


def iter_pages(paths: list[Path]) -> Iterator[RasterPage]:
    for path in paths:
        if path.suffix.lower() == ".pdf":
            doc = pymupdf.open(path)
            for i, page in enumerate(doc):
                pix = page.get_pixmap(dpi=DPI, colorspace=pymupdf.csGRAY)
                gray = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width).copy()
                yield RasterPage(str(path), i, gray)
        else:
            gray = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
            if gray is None:
                raise ValueError(f"cannot read image {path}")
            yield RasterPage(str(path), 0, gray)
```

`qr.py`:

```python
from dataclasses import dataclass

import numpy as np
import zxingcpp

from papersync.payload import SCHEME, Payload, PayloadError


@dataclass
class DecodedQr:
    payload: Payload
    corners: np.ndarray  # (4, 2) float32, TL TR BR BL in the symbol's own orientation


class ForeignPayload(Exception):
    """A papersync-looking QR that does not parse. Carries the parse error."""


def find_payload(gray: np.ndarray) -> DecodedQr | None:
    for result in zxingcpp.read_barcodes(gray, formats=zxingcpp.BarcodeFormat.QRCode):
        if not result.text.startswith(SCHEME):
            continue
        try:
            payload = Payload.parse(result.text)
        except PayloadError as exc:
            raise ForeignPayload(str(exc)) from exc
        p = result.position
        corners = np.array(
            [[p.top_left.x, p.top_left.y], [p.top_right.x, p.top_right.y],
             [p.bottom_right.x, p.bottom_right.y], [p.bottom_left.x, p.bottom_left.y]],
            dtype=np.float32,
        )
        return DecodedQr(payload, corners)
    return None
```

`geometry.py`:

```python
import cv2
import numpy as np

from papersync.recognize.qr import DecodedQr
from papersync.render.templates.v1 import layout as L


def mm_to_px(h: np.ndarray, x: float, y: float) -> tuple[float, float]:
    v = h @ np.array([x, y, 1.0])
    return float(v[0] / v[2]), float(v[1] / v[2])


def homography_from_qr(decoded: DecodedQr, size: L.PageSize) -> np.ndarray:
    src = np.array(L.qr_rect(size).corners(), dtype=np.float32)
    return cv2.getPerspectiveTransform(src, decoded.corners).astype(np.float64)


def _find_square(gray: np.ndarray, h0: np.ndarray, rect: L.Rect) -> tuple[float, float] | None:
    cx, cy = mm_to_px(h0, *rect.center)
    px_per_mm = float(np.hypot(h0[0, 0], h0[1, 0]))
    radius = int(4.0 * px_per_mm)
    x0, y0 = max(int(cx) - radius, 0), max(int(cy) - radius, 0)
    window = gray[y0 : int(cy) + radius, x0 : int(cx) + radius]
    if window.size == 0:
        return None
    _, binary = cv2.threshold(window, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    expected = (L.FIDUCIAL_MM * px_per_mm) ** 2
    best = None
    for c in contours:
        area = cv2.contourArea(c)
        if 0.5 * expected <= area <= 1.6 * expected:
            m = cv2.moments(c)
            score = abs(area - expected)
            if best is None or score < best[0]:
                best = (score, x0 + m["m10"] / m["m00"], y0 + m["m01"] / m["m00"])
    return None if best is None else (best[1], best[2])


def refine_with_fiducials(gray: np.ndarray, h0: np.ndarray, size: L.PageSize) -> np.ndarray | None:
    src = [r.center for r in L.fiducials(size)]
    dst = [_find_square(gray, h0, r) for r in L.fiducials(size)]
    if any(d is None for d in dst):
        return None
    src_pts = np.array(src + L.qr_rect(size).corners(), dtype=np.float32)
    qr_corners = [mm_to_px(h0, x, y) for x, y in L.qr_rect(size).corners()]
    dst_pts = np.array([d for d in dst if d is not None] + qr_corners, dtype=np.float32)
    h, _ = cv2.findHomography(src_pts, dst_pts, 0)
    return None if h is None else h.astype(np.float64)
```

`marks.py`:

```python
import cv2
import numpy as np

from papersync.model import BoxResult
from papersync.recognize.geometry import mm_to_px
from papersync.render.templates.v1 import layout as L

PATCH = 40


def box_fill(gray: np.ndarray, h: np.ndarray, rect: L.Rect) -> float:
    inner = rect.inset(L.BOX_INSET_MM)
    src = np.array([mm_to_px(h, x, y) for x, y in inner.corners()], dtype=np.float32)
    dst = np.array([[0, 0], [PATCH, 0], [PATCH, PATCH], [0, PATCH]], dtype=np.float32)
    patch = cv2.warpPerspective(gray, cv2.getPerspectiveTransform(src, dst), (PATCH, PATCH))
    return float((patch < 128).mean())


def classify(fill: float) -> BoxResult:
    if fill < L.FILL_LOW:
        return BoxResult(fill=fill, checked=False, uncertain=False)
    if fill > L.FILL_HIGH:
        return BoxResult(fill=fill, checked=True, uncertain=False)
    return BoxResult(fill=fill, checked=False, uncertain=True)
```

`ocr.py`:

```python
from dataclasses import dataclass
from typing import Protocol

import numpy as np

from papersync.recognize.geometry import mm_to_px
from papersync.render.templates.v1 import layout as L


@dataclass
class OcrLine:
    text: str
    confidence: float
    x: float
    y: float
    w: float
    h: float


class OcrBackend(Protocol):
    def recognize(self, gray: np.ndarray) -> list[OcrLine]: ...


class OcrmacBackend:
    """Apple Vision through ocrmac. macOS only; imported lazily."""

    def recognize(self, gray: np.ndarray) -> list[OcrLine]:
        from ocrmac import ocrmac  # noqa: PLC0415
        from PIL import Image

        image = Image.fromarray(gray)
        raw = ocrmac.OCR(image, recognition_level="accurate").recognize(px=True)
        lines = [OcrLine(t, float(c), float(x), float(y), float(w), float(h)) for t, c, (x, y, w, h) in raw]
        return sorted(lines, key=lambda line: (line.y, line.x))


def lines_in(lines: list[OcrLine], h: np.ndarray, region: L.Rect) -> list[OcrLine]:
    tl = mm_to_px(h, region.x, region.y)
    br = mm_to_px(h, region.x + region.w, region.y + region.h)
    x0, x1 = sorted((tl[0], br[0]))
    y0, y1 = sorted((tl[1], br[1]))
    return [
        line for line in lines
        if x0 <= line.x + line.w / 2 <= x1 and y0 <= line.y + line.h / 2 <= y1
    ]


def join_text(lines: list[OcrLine]) -> str:
    return "\n".join(line.text for line in sorted(lines, key=lambda line: (line.y, line.x)))
```

- [ ] **Step 4: Run tests, lint, types** — all pass. If the fiducial test fails on the rotated image, print `dst` from `refine_with_fiducials` and widen the search radius to `5.0 * px_per_mm`; the spike showed zxing corners are exact, so failures come from the window, not the QR.

- [ ] **Step 5: Commit** — `git commit -m "papersync: recognition primitives"`

---

### Task 12: Page assembly into a plan, and review output

**Files:**
- Create: `src/papersync/recognize/assemble.py`, `src/papersync/recognize/review.py`, `tests/test_assemble.py`

**Interfaces:**
- Consumes: everything from Task 11, `BoxSetRegistry`, `Source.lookup`, `scanned_block`.
- Produces:

```python
@dataclass class PageOverlay: page: RasterPage; boxes: list[tuple[Rect, BoxResult]]; h: np.ndarray | None; note: str
@dataclass class Recognized: plan: Plan; overlays: list[PageOverlay]
def recognize_pages(pages: Iterable[RasterPage], ocr: OcrBackend, registry: BoxSetRegistry,
                    lookup: Callable[[list[str]], dict[str, Item]], today: date, inputs: list[str]) -> Recognized
def write_review(overlays: list[PageOverlay], path: Path) -> None
```

- [ ] **Step 1: Write the failing tests**

```python
from datetime import date
from pathlib import Path

import numpy as np

from papersync.boxsets import BoxSetRegistry
from papersync.model import Item
from papersync.recognize.assemble import recognize_pages
from papersync.recognize.ocr import OcrLine
from papersync.recognize.raster import RasterPage
from papersync.render import engine
from papersync.render.templates.v1 import layout as L
from tests import synthetic

SIZE = L.SIZES["3x5"]
TODAY = date(2026, 9, 7)


class FakeOcr:
    def recognize(self, gray: np.ndarray) -> list[OcrLine]:
        if gray.shape == (1000, 1500):  # synthetic.handwriting_page
            return [OcrLine("some handwriting", 0.9, 200, 350, 800, 60)]
        # a "new" card: one title line and one notes line inside the notes region
        h = synthetic.identity_h()
        from papersync.recognize.geometry import mm_to_px

        tx, ty = mm_to_px(h, L.title_bar(SIZE).x + 2, L.title_bar(SIZE).y + 1)
        nx, ny = mm_to_px(h, L.notes_region(SIZE).x + 2, L.notes_region(SIZE).y + 2)
        return [OcrLine("Call mom", 0.9, tx, ty, 300, 40), OcrLine("about sunday", 0.9, nx, ny, 300, 40)]


def _registry(tmp_path: Path) -> BoxSetRegistry:
    reg = BoxSetRegistry(tmp_path / "boxsets.toml")
    reg.id_for(["A", "B"])
    return reg


def _card(ref: str, title: str, notes: str, marked: list[L.Rect]) -> np.ndarray:
    opts = engine.RenderOptions(labels=["A", "B"], boxes_id=1)
    pdf = engine.render_item(Item(source="things", ref=ref, title=title, notes=notes), "3x5", opts, TODAY).pdf
    gray = synthetic.rasterize(pdf)
    for r in marked:
        synthetic.draw_x(gray, r)
    return synthetic.distort(gray)


def _lookup(refs: list[str]) -> dict[str, Item]:
    known = {"F" * 22: Item(source="things", ref="F" * 22, title="FOO"), "B" * 22: Item(source="things", ref="B" * 22, title="BAR", notes="BAZ")}
    return {r: known[r] for r in refs if r in known}


def test_spec_example(tmp_path: Path) -> None:
    pages = [
        RasterPage("scan.pdf", 0, _card("F" * 22, "FOO", "", [L.done_box(SIZE), L.meta_box(SIZE, 1)])),
        RasterPage("scan.pdf", 1, _card("B" * 22, "BAR", "BAZ", [L.meta_box(SIZE, 0)])),
        RasterPage("scan.pdf", 2, synthetic.handwriting_page()),
    ]
    rec = recognize_pages(pages, FakeOcr(), _registry(tmp_path), _lookup, TODAY, ["scan.pdf"])
    plan = rec.plan
    assert plan.errors == []
    foo, bar = plan.changes
    assert foo.ref == "F" * 22 and foo.complete and foo.marks == ["B"] and foo.append_notes is None
    assert bar.ref == "B" * 22 and not bar.complete and bar.marks == ["A"]
    assert bar.append_notes == "\n\n## Scanned 2026-09-07\n\n> some handwriting"
    assert bar.pages == [2] and foo.title == "FOO"
    assert set(foo.boxes) == {"done", "A", "B"}
    assert len(rec.overlays) == 3


def test_handwriting_before_any_card_is_an_error(tmp_path: Path) -> None:
    pages = [RasterPage("scan.pdf", 0, synthetic.handwriting_page())]
    plan = recognize_pages(pages, FakeOcr(), _registry(tmp_path), _lookup, TODAY, ["scan.pdf"]).plan
    assert plan.changes == [] and plan.errors[0].page == 1 and "no card" in plan.errors[0].message


def test_unknown_box_set_is_an_error(tmp_path: Path) -> None:
    reg = BoxSetRegistry(tmp_path / "boxsets.toml")  # empty: set 1 unknown
    pages = [RasterPage("scan.pdf", 0, _card("F" * 22, "FOO", "", []))]
    plan = recognize_pages(pages, FakeOcr(), reg, _lookup, TODAY, ["scan.pdf"]).plan
    assert plan.changes == [] and "box set 1" in plan.errors[0].message


def test_new_card_becomes_create(tmp_path: Path) -> None:
    opts = engine.RenderOptions(labels=["A", "B"], boxes_id=1)
    gray = synthetic.rasterize(engine.render_new(1, "3x5", opts, TODAY)[0].pdf)
    synthetic.draw_x(gray, L.meta_box(SIZE, 0))
    pages = [RasterPage("scan.pdf", 0, gray), RasterPage("scan.pdf", 1, synthetic.handwriting_page())]
    plan = recognize_pages(pages, FakeOcr(), _registry(tmp_path), _lookup, TODAY, ["scan.pdf"]).plan
    assert plan.errors == []
    (new,) = plan.changes
    assert new.kind == "create" and new.title == "Call mom" and new.marks == ["A"]
    assert new.notes == "about sunday\n\nsome handwriting"


def test_continuation_without_first_page_is_an_error(tmp_path: Path) -> None:
    opts = engine.RenderOptions(labels=["A"], boxes_id=1, overflow="paginate")
    item = Item(source="things", ref="L" * 22, title="Long", notes="\n".join(["x"] * 60))
    pdf = engine.render_item(item, "3x5", opts, TODAY).pdf
    page2 = synthetic.rasterize(pdf, page=1)
    plan = recognize_pages([RasterPage("s.pdf", 0, page2)], FakeOcr(), _registry(tmp_path), _lookup, TODAY, ["s.pdf"]).plan
    assert plan.changes == [] and "continuation" in plan.errors[0].message
```

- [ ] **Step 2: Run to verify failure** — ImportError.

- [ ] **Step 3: Implement**

`assemble.py`:

```python
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import date, datetime

import numpy as np

from papersync.boxsets import BoxSetRegistry
from papersync.model import BoxResult, Change, Item, Plan, PlanError, scanned_block
from papersync.recognize import geometry, marks
from papersync.recognize.ocr import OcrBackend, join_text, lines_in
from papersync.recognize.qr import DecodedQr, ForeignPayload, find_payload
from papersync.recognize.raster import RasterPage
from papersync.render.templates.v1 import layout as L


@dataclass
class PageOverlay:
    page: RasterPage
    boxes: list[tuple[L.Rect, BoxResult]] = field(default_factory=list)
    h: np.ndarray | None = None
    size: L.PageSize | None = None
    note: str = ""


@dataclass
class Recognized:
    plan: Plan
    overlays: list[PageOverlay]


@dataclass
class _Pending:
    change: Change
    handwriting: list[str]
    expected_pages: int
    seen_pages: set[int]


def _finish(pending: _Pending | None, today: date, changes: list[Change], errors: list[PlanError]) -> None:
    if pending is None:
        return
    missing = set(range(1, pending.expected_pages + 1)) - pending.seen_pages
    if missing:
        errors.append(PlanError(page=pending.change.pages[0], message=f"{pending.change.title!r}: pages {sorted(missing)} missing"))
    text = "\n\n".join(pending.handwriting)
    if pending.change.kind == "create":
        if text:
            pending.change.notes = f"{pending.change.notes}\n\n{text}" if pending.change.notes else text
    elif text:
        pending.change.append_notes = scanned_block(text, today)
    changes.append(pending.change)


def _score_boxes(gray: np.ndarray, h: np.ndarray, size: L.PageSize, labels: list[str], overlay: PageOverlay) -> dict[str, BoxResult]:
    out: dict[str, BoxResult] = {}
    for label, rect in [("done", L.done_box(size)), *[(lb, L.meta_box(size, i)) for i, lb in enumerate(labels)]]:
        result = marks.classify(marks.box_fill(gray, h, rect))
        out[label] = result
        overlay.boxes.append((rect, result))
    return out


def recognize_pages(
    pages: Iterable[RasterPage],
    ocr: OcrBackend,
    registry: BoxSetRegistry,
    lookup: Callable[[list[str]], dict[str, Item]],
    today: date,
    inputs: list[str],
) -> Recognized:
    changes: list[Change] = []
    errors: list[PlanError] = []
    overlays: list[PageOverlay] = []
    pending: _Pending | None = None
    page_no = 0
    for page in pages:
        page_no += 1
        overlay = PageOverlay(page)
        overlays.append(overlay)
        try:
            decoded: DecodedQr | None = find_payload(page.gray)
        except ForeignPayload as exc:
            errors.append(PlanError(page=page_no, message=f"unreadable papersync QR: {exc}"))
            overlay.note = "bad QR"
            continue
        if decoded is None:
            if pending is None:
                errors.append(PlanError(page=page_no, message="handwriting page with no card before it"))
                overlay.note = "orphan handwriting"
                continue
            pending.handwriting.append(join_text(ocr.recognize(page.gray)))
            overlay.note = "handwriting"
            continue
        payload = decoded.payload
        size = L.SIZES.get(payload.size)
        if size is None:
            errors.append(PlanError(page=page_no, message=f"unknown size {payload.size!r}"))
            continue
        h = geometry.refine_with_fiducials(
            page.gray, geometry.homography_from_qr(decoded, size), size, qr_corners=decoded.corners
        )
        if h is None:
            errors.append(PlanError(page=page_no, message="corner marks not found"))
            overlay.note = "no fiducials"
            continue
        overlay.h = h
        overlay.size = size
        if payload.page > 1:
            if pending is None or pending.change.ref != payload.ref:
                errors.append(PlanError(page=page_no, message=f"continuation page {payload.page} of {payload.ref} without its first page"))
                continue
            pending.seen_pages.add(payload.page)
            pending.change.pages.append(page_no)
            overlay.note = f"cont. {payload.page}/{payload.pages}"
            continue
        labels = registry.labels_for(payload.boxes)
        if labels is None:
            errors.append(PlanError(page=page_no, message=f"unknown box set {payload.boxes}"))
            continue
        _finish(pending, today, changes, errors)
        boxes = _score_boxes(page.gray, h, size, labels, overlay)
        marked = [lb for lb in labels if boxes[lb].checked]
        if payload.is_new:
            lines = ocr.recognize(page.gray)
            title_lines = lines_in(lines, h, L.title_bar(size))
            note_lines = lines_in(lines, h, L.notes_region(size))
            body = title_lines + note_lines
            title = body[0].text if body else "(untitled)"
            rest = join_text(body[1:]) if len(body) > 1 else None
            change = Change(kind="create", source=payload.source, title=title, notes=rest,
                            complete=boxes["done"].checked, marks=marked, boxes=boxes, pages=[page_no])
            overlay.note = "new"
        else:
            item = lookup([payload.ref]).get(payload.ref)
            if item is None:
                errors.append(PlanError(page=page_no, message=f"unknown item {payload.ref}"))
                overlay.note = "unknown item"
                continue
            change = Change(kind="update", source=payload.source, ref=payload.ref, title=item.title,
                            complete=boxes["done"].checked, marks=marked, boxes=boxes, pages=[page_no])
            overlay.note = item.title
        pending = _Pending(change, [], payload.pages, {1})
    _finish(pending, today, changes, errors)
    plan = Plan(created=datetime.now(), inputs=inputs, changes=changes, errors=errors)
    return Recognized(plan, overlays)
```

`review.py`:

```python
from pathlib import Path

import cv2
import numpy as np
import pymupdf

from papersync.recognize.assemble import PageOverlay
from papersync.recognize.geometry import mm_to_px
from papersync.render.templates.v1 import layout as L

GREEN, RED, AMBER, BLUE = (0, 170, 0), (0, 0, 220), (0, 160, 255), (220, 120, 0)


def _outline(img: np.ndarray, h: np.ndarray, rect: L.Rect, color: tuple[int, int, int], width: int) -> np.ndarray:
    pts = np.array([mm_to_px(h, x, y) for x, y in rect.corners()], dtype=np.int32)
    cv2.polylines(img, [pts], True, color, width)
    return pts


def _draw(overlay: PageOverlay) -> np.ndarray:
    img = cv2.cvtColor(overlay.page.gray, cv2.COLOR_GRAY2BGR)
    if overlay.h is not None and overlay.size is not None:
        for rect in [*L.fiducials(overlay.size), L.qr_rect(overlay.size)]:
            _outline(img, overlay.h, rect, BLUE, 2)
        for rect, res in overlay.boxes:
            color = AMBER if res.uncertain else GREEN if res.checked else RED
            pts = _outline(img, overlay.h, rect, color, 3)
            cv2.putText(img, f"{res.fill:.2f}", (int(pts[1][0]) + 6, int(pts[1][1]) + 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.9, color, 2)
    cv2.putText(img, overlay.note, (40, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.4, BLUE, 3)
    return img


def write_review(overlays: list[PageOverlay], path: Path) -> None:
    doc = pymupdf.open()
    for overlay in overlays:
        ok, png = cv2.imencode(".png", _draw(overlay))
        if not ok:
            raise RuntimeError("could not encode review page")
        img = pymupdf.open("png", png.tobytes())
        rect = img[0].rect
        page = doc.new_page(width=rect.width, height=rect.height)
        page.insert_image(rect, stream=png.tobytes())
    doc.save(path)
```

- [ ] **Step 4: Add a review test**

Append to `tests/test_assemble.py`:

```python
def test_write_review(tmp_path: Path) -> None:
    from papersync.recognize.review import write_review
    import pymupdf

    pages = [RasterPage("scan.pdf", 0, _card("F" * 22, "FOO", "", [L.done_box(SIZE)]))]
    rec = recognize_pages(pages, FakeOcr(), _registry(tmp_path), _lookup, TODAY, ["scan.pdf"])
    out = tmp_path / "review.pdf"
    write_review(rec.overlays, out)
    assert pymupdf.open(out).page_count == 1
```

- [ ] **Step 5: Run tests, lint, types** — all pass.

- [ ] **Step 6: Commit** — `git commit -m "papersync: assemble recognized pages into a plan, review output"`

---

### Task 13: Plan display

**Files:**
- Create: `src/papersync/display.py`, `tests/test_display.py`

**Interfaces:**
- Consumes: `Plan`, `Sink.describe`, `Source.lookup`.
- Produces: `def format_plan(plan: Plan, describe: Callable[[Change], list[str]], current_notes: Callable[[Change], str]) -> str`

- [ ] **Step 1: Write the failing test**

```python
from datetime import date, datetime

from papersync.display import format_plan
from papersync.model import BoxResult, Change, Plan, PlanError, scanned_block


def test_format_plan() -> None:
    bar = Change(kind="update", source="things", ref="U2", title="BAR", marks=["today"],
                 boxes={"waiting": BoxResult(fill=0.31, checked=False, uncertain=True)},
                 append_notes=scanned_block("some handwriting", date(2026, 9, 7)), pages=[2, 3])
    foo = Change(kind="update", source="things", ref="U1", title="FOO", complete=True, marks=["A"], pages=[1])
    new = Change(kind="create", source="things", title="Call mom", notes="about sunday", pages=[4])
    plan = Plan(created=datetime(2026, 9, 7), inputs=["s.pdf"], changes=[foo, bar, new],
                errors=[PlanError(page=5, message="corner marks not found")])
    describe = lambda ch: (["+ completed"] if ch.complete else []) + [f"+ {m:<8} tag x" for m in ch.marks]  # noqa: E731
    out = format_plan(plan, describe, lambda ch: "BAZ" if ch.ref == "U2" else "")
    assert out == (
        "FOO  things:///show?id=U1  (page 1)\n"
        "+ completed\n"
        "+ A        tag x\n"
        "\n"
        "BAR  things:///show?id=U2  (pages 2-3)\n"
        "+ today    tag x\n"
        "? waiting  fill 0.31, treated as unchecked\n"
        "--- notes\n"
        "+++ notes\n"
        "@@ -1 +1,5 @@\n"
        " BAZ\n"
        "+\n"
        "+## Scanned 2026-09-07\n"
        "+\n"
        "+> some handwriting\n"
        "\n"
        "NEW  Call mom  (page 4)\n"
        "+ notes: about sunday\n"
        "\n"
        "ERROR page 5: corner marks not found\n"
    )
```

- [ ] **Step 2: Run to verify failure** — ImportError.

- [ ] **Step 3: Implement**

```python
import difflib
from collections.abc import Callable

from papersync.model import Change, Plan


def _pages(change: Change) -> str:
    if len(change.pages) <= 1:
        return f"(page {change.pages[0]})" if change.pages else ""
    return f"(pages {change.pages[0]}-{change.pages[-1]})"


def _header(change: Change) -> str:
    if change.kind == "create":
        return f"NEW  {change.title}  {_pages(change)}"
    return f"{change.title}  things:///show?id={change.ref}  {_pages(change)}"


def _notes_diff(before: str, after: str) -> list[str]:
    diff = difflib.unified_diff(before.splitlines(), after.splitlines(), "notes", "notes", lineterm="", n=3)
    return list(diff)


def format_plan(
    plan: Plan,
    describe: Callable[[Change], list[str]],
    current_notes: Callable[[Change], str],
) -> str:
    blocks: list[str] = []
    for change in plan.changes:
        lines = [_header(change), *describe(change)]
        for label, box in change.boxes.items():
            if box.uncertain:
                lines.append(f"? {label:<8} fill {box.fill:.2f}, treated as unchecked")
        if change.kind == "create" and change.notes:
            lines.append(f"+ notes: {change.notes}")
        if change.append_notes:
            before = current_notes(change)
            lines += _notes_diff(before, before + change.append_notes)
        blocks.append("\n".join(lines) + "\n")
    for err in plan.errors:
        blocks.append(f"ERROR page {err.page}: {err.message}\n")
    return "\n".join(blocks)
```

The header uses `things:///show?id=` for the `things` source only; that is fine for v1 because the header format is a display concern and the spec's example uses it. If a second integration lands, move `_header` behind `Sink.describe`.

- [ ] **Step 4: Run tests, lint, types** — all pass. Adjust the expected string only if `difflib` hunk headers differ from `@@ -1 +1,5 @@`; run once, read the actual output, and make sure it is semantically the same before changing the assertion.

- [ ] **Step 5: Commit** — `git commit -m "papersync: diff-style plan display"`

---

### Task 14: CLI commands

**Files:**
- Modify: `src/papersync/cli.py`, `src/papersync/config.py` (add `tag: bool = True` to `RenderConfig`), `tests/test_config.py` (assert `cfg.render.tag is True` in `test_defaults_when_file_missing`)
- Create: `tests/test_cli.py` (extend)

**Interfaces:**
- Consumes: everything above.
- Produces the command surface from the spec: `things export`, `things auth`, `render`, `print`, `recognize`, `apply`, `scan`, `status`, `doctor`.

- [ ] **Step 1: Write the failing tests**

Extend `tests/test_cli.py`:

```python
import json
from datetime import datetime
from pathlib import Path

from click.testing import CliRunner

from papersync.cli import main
from papersync.model import Change, Plan, PlanError
from tests import synthetic
from tests.things_fixture import make_db


def _env(tmp_path: Path) -> dict[str, str]:
    cfg = tmp_path / "cfg"
    state = tmp_path / "state"
    cfg.mkdir()
    (cfg / "papersync").mkdir()
    (cfg / "papersync" / "config.toml").write_text('[render]\nopen = false\noutput_dir = "%s"\n' % (tmp_path / "out"))
    return {
        "XDG_CONFIG_HOME": str(cfg),
        "XDG_STATE_HOME": str(state),
        "PAPERSYNC_THINGS_DB": str(make_db(tmp_path / "main.sqlite")),
        "PAPERSYNC_OPENER": "none",
    }


def test_things_export_json(tmp_path: Path) -> None:
    r = CliRunner().invoke(main, ["things", "export", "inbox"], env=_env(tmp_path))
    assert r.exit_code == 0, r.output
    data = json.loads(r.stdout)
    assert [d["title"] for d in data] == ["FOO"] and data[0]["source"] == "things"


def test_render_from_stdin_and_ledger(tmp_path: Path) -> None:
    env = _env(tmp_path)
    items = json.dumps([{"source": "things", "ref": "T1", "title": "FOO", "notes": ""}])
    r = CliRunner().invoke(main, ["render", "-", "--boxes", "A,B"], input=items, env=env)
    assert r.exit_code == 0, r.output
    out = sorted((tmp_path / "out").glob("*.pdf"))
    assert len(out) == 1 and out[0].name.endswith("-3x5.pdf")
    # state tag: opener "none" prints the update URL; runner "none" prints the AppleScript
    assert "things:///update?" in r.output and "papersync%3Aprinted" in r.output
    assert 'osascript: tell application "Things3"' in r.output
    r2 = CliRunner().invoke(main, ["render", "-", "--boxes", "A,B", "--no-tag"], input=items, env=env)
    assert r2.exit_code == 0 and "things:///update?" not in r2.output
    ledger = (tmp_path / "state" / "papersync" / "prints.jsonl").read_text()
    assert '"event":"render"' in ledger and '"ref":"T1"' in ledger
    boxsets = (tmp_path / "cfg" / "papersync" / "boxsets.toml").read_text()
    assert 'labels = ["A", "B"]' in boxsets


def test_print_then_status(tmp_path: Path) -> None:
    env = _env(tmp_path)
    r = CliRunner().invoke(main, ["print", "next"], env=env)
    assert r.exit_code == 0, r.output
    s = CliRunner().invoke(main, ["status"], env=env)
    assert s.exit_code == 0 and "BAR" in s.output and "Dated" in s.output


def test_render_overflow_fail_exits_nonzero(tmp_path: Path) -> None:
    items = json.dumps([{"source": "things", "ref": "T1", "title": "FOO", "notes": "\n".join(["x"] * 80)}])
    r = CliRunner().invoke(main, ["render", "-", "--size", "3x5"], input=items, env=_env(tmp_path))
    assert r.exit_code != 0 and "does not fit" in r.output


def test_apply_requires_yes_and_records(tmp_path: Path) -> None:
    env = _env(tmp_path)
    plan = Plan(created=datetime.now(), inputs=[], errors=[], changes=[
        Change(kind="update", source="things", ref="T1", title="FOO", complete=True, pages=[1])])
    p = tmp_path / "plan.json"
    p.write_text(plan.to_json())
    r = CliRunner().invoke(main, ["apply", str(p), "--no-verify"], input="no\n", env=env)
    assert r.exit_code != 0 and "aborted" in r.output.lower()
    r = CliRunner().invoke(main, ["apply", str(p), "--no-verify"], input="yes\n", env=env)
    assert r.exit_code == 0, r.output
    assert "things:///update?" in r.output  # opener "none" prints URLs instead of opening them
    assert '"event":"apply"' in (tmp_path / "state" / "papersync" / "prints.jsonl").read_text()


def test_apply_auto_approve_refuses_errors(tmp_path: Path) -> None:
    plan = Plan(created=datetime.now(), inputs=[], changes=[], errors=[PlanError(page=1, message="x")])
    p = tmp_path / "plan.json"
    p.write_text(plan.to_json())
    r = CliRunner().invoke(main, ["apply", str(p), "--auto-approve"], env=_env(tmp_path))
    assert r.exit_code != 0 and "error" in r.output.lower()


def test_recognize_round_trip(tmp_path: Path) -> None:
    import cv2

    from papersync.render.templates.v1 import layout as L

    env = _env(tmp_path)
    # print through the CLI so the box set registry has set 1 = A,B
    assert CliRunner().invoke(main, ["render", "-", "--boxes", "A,B"], input=json.dumps(
        [{"source": "things", "ref": "T1", "title": "FOO", "notes": ""}]), env=env).exit_code == 0
    pdf = next((tmp_path / "out").glob("*.pdf"))
    gray = synthetic.rasterize(pdf.read_bytes())
    synthetic.draw_x(gray, L.done_box(L.SIZES["3x5"]))
    scan = tmp_path / "scan.png"
    cv2.imwrite(str(scan), synthetic.distort(gray))
    r = CliRunner().invoke(main, ["recognize", str(scan), "--review", str(tmp_path / "rev.pdf")], env=env)
    assert r.exit_code == 0, r.output
    plan = Plan.from_json(r.stdout)
    assert plan.changes[0].ref == "T1" and plan.changes[0].complete and plan.changes[0].title == "FOO"
    assert (tmp_path / "rev.pdf").exists()


def test_doctor_runs(tmp_path: Path) -> None:
    r = CliRunner().invoke(main, ["doctor"], env=_env(tmp_path))
    assert "uv" in r.output and "Things database" in r.output
```

`result.stdout` is used where a test parses data, because Click 8.2+ interleaves stderr into `result.output`. Two test seams are introduced in the CLI: `PAPERSYNC_THINGS_DB` overrides `find_db_path()`, and `PAPERSYNC_OPENER=none` makes the sink print URLs to stdout instead of calling `open` and print AppleScript as `osascript: <script>` instead of running it. Both are read only in `cli.py`.

- [ ] **Step 2: Run to verify failure** — commands missing.

- [ ] **Step 3: Implement `cli.py`**

```python
import json
import os
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

import click

from papersync import __version__
from papersync.boxsets import BoxSetRegistry
from papersync.config import Config, config_dir, load_config, state_dir
from papersync.display import format_plan
from papersync.integrations.things import auth as things_auth
from papersync.integrations.things.db import ThingsDb, ThingsDbNotFound, find_db_path
from papersync.integrations.things.sink import ThingsSink
from papersync.integrations.things.source import ThingsSource
from papersync.ledger import Ledger, LedgerEntry
from papersync.model import Change, Item, Plan
from papersync.recognize.assemble import recognize_pages
from papersync.recognize.ocr import OcrmacBackend
from papersync.recognize.raster import iter_pages
from papersync.recognize.review import write_review
from papersync.render import engine
from papersync.render.qr import qr_svg
from papersync.render.templates.v1 import layout as L

SIZES = ["auto", *L.SIZE_ORDER]
OVERFLOWS = ["fail", "paginate", "truncate"]


def _err(msg: str) -> None:
    click.echo(msg, err=True)


def _db() -> ThingsDb:
    override = os.environ.get("PAPERSYNC_THINGS_DB")
    try:
        return ThingsDb(Path(override) if override else find_db_path())
    except ThingsDbNotFound as exc:
        raise click.ClickException(str(exc)) from exc


def _sink(cfg: Config) -> ThingsSink:
    if os.environ.get("PAPERSYNC_OPENER") == "none":
        return ThingsSink(
            _db(), cfg.things, opener=click.echo, token_provider=lambda: "TEST",
            sleeper=lambda _s: None, runner=lambda script: click.echo(f"osascript: {script}"),
        )
    return ThingsSink(_db(), cfg.things)


def _ledger() -> Ledger:
    return Ledger(state_dir() / "prints.jsonl")


def _registry() -> BoxSetRegistry:
    return BoxSetRegistry(config_dir() / "boxsets.toml")


def _read_items(src: str) -> list[Item]:
    text = sys.stdin.read() if src == "-" else Path(src).read_text()
    return [Item.model_validate(d) for d in json.loads(text)]


@click.group()
@click.version_option(__version__, prog_name="papersync")
def main() -> None:
    """Print Things items to index cards and scan them back."""


@main.group()
def things() -> None:
    """Things integration."""


@things.command("export")
@click.argument("selector")
def things_export(selector: str) -> None:
    """Export open items as JSON: inbox | next | someday | things:///show?id=UUID."""
    try:
        items = ThingsSource(_db()).export(selector)
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc
    click.echo(json.dumps([i.model_dump() for i in items], indent=2))


@things.command("auth")
def things_auth_cmd() -> None:
    """Store or rotate the Things URL-scheme token in the keychain."""
    token = click.prompt("Things auth token", hide_input=True)
    things_auth.set_token(token)
    _err("stored")


def _render_options(cfg: Config, size: str | None, overflow: str | None, boxes: str | None) -> tuple[engine.RenderOptions, list[str]]:
    labels = [b.strip() for b in boxes.split(",") if b.strip()] if boxes else list(cfg.render.boxes)
    opts = engine.RenderOptions(labels=labels, boxes_id=_registry().id_for(labels),
                                size=size or cfg.render.size, overflow=overflow or cfg.render.overflow)
    return opts, labels


def _do_render(
    cfg: Config, items: list[Item], opts: engine.RenderOptions, new: int, out: Path, open_pdf: bool, tag: bool
) -> list[Path]:
    today = date.today()
    rendered: list[engine.RenderedItem] = []
    try:
        for item in items:
            r = engine.render_auto(item, opts, today) if opts.size == "auto" else engine.render_item(item, opts.size, opts, today)
            if r.truncated:
                _err(f"truncated: {item.title}")
            rendered.append(r)
        if new:
            rendered += engine.render_new(new, "3x5" if opts.size == "auto" else opts.size, opts, today)
    except engine.RenderOverflow as exc:
        raise click.ClickException(str(exc)) from exc
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    paths = engine.write_outputs(rendered, out, stamp)
    ledger = _ledger()
    for r in rendered:
        if r.item is not None:
            ledger.record(LedgerEntry(ts=datetime.now(), event="render", source=r.item.source, ref=r.item.ref,
                                      title=r.item.title, size=r.size, boxes=opts.boxes_id,
                                      file=str(next(p for p in paths if p.name.endswith(f"-{r.size}.pdf")))))
    for p in paths:
        _err(f"wrote {p}")
        if open_pdf:
            subprocess.run(["open", str(p)], check=False)
    things_refs = [r.item.ref for r in rendered if r.item is not None and r.item.source == "things"]
    if tag and things_refs:
        _sink(cfg).mark_printed(things_refs)
        _err(f"tagged {len(things_refs)} item(s) papersync:printed")
    return paths


def _render_common(f):  # type: ignore[no-untyped-def]
    for opt in reversed([
        click.option("--size", type=click.Choice(SIZES), default=None),
        click.option("--overflow", type=click.Choice(OVERFLOWS), default=None),
        click.option("--boxes", default=None, help="comma-separated box labels"),
        click.option("--new", "new", type=int, default=0, help="also print N blank new-item cards"),
        click.option("-o", "--output-dir", default=None),
        click.option("--open/--no-open", "open_pdf", default=None),
        click.option("--tag/--no-tag", "tag", default=None, help="add papersync:printed in Things"),
    ]):
        f = opt(f)
    return f


@main.command()
@click.argument("items_file", default="-")
@_render_common
def render(items_file: str, size: str | None, overflow: str | None, boxes: str | None, new: int, output_dir: str | None, open_pdf: bool | None, tag: bool | None) -> None:
    """Render items JSON (file or -) to one PDF per page size."""
    cfg = load_config()
    opts, _ = _render_options(cfg, size, overflow, boxes)
    items = _read_items(items_file)
    _do_render(cfg, items, opts, new, Path(output_dir or cfg.render.output_dir),
               cfg.render.open if open_pdf is None else open_pdf, cfg.render.tag if tag is None else tag)


@main.command("print")
@click.argument("selector")
@_render_common
def print_cmd(selector: str, size: str | None, overflow: str | None, boxes: str | None, new: int, output_dir: str | None, open_pdf: bool | None, tag: bool | None) -> None:
    """Export a Things selector and render it."""
    cfg = load_config()
    opts, _ = _render_options(cfg, size, overflow, boxes)
    try:
        items = ThingsSource(_db()).export(selector)
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc
    _do_render(cfg, items, opts, new, Path(output_dir or cfg.render.output_dir),
               cfg.render.open if open_pdf is None else open_pdf, cfg.render.tag if tag is None else tag)


def _recognize(scans: tuple[str, ...], review: str | None) -> Plan:
    source = ThingsSource(_db())
    rec = recognize_pages(iter_pages([Path(s) for s in scans]), OcrmacBackend(), _registry(), source.lookup,
                          date.today(), list(scans))
    if review:
        write_review(rec.overlays, Path(review))
        _err(f"wrote {review}")
    return rec.plan


def _display(cfg: Config, plan: Plan) -> str:
    sink = _sink(cfg)
    db = _db()
    return format_plan(plan, sink.describe, lambda ch: (db.get(ch.ref).notes if ch.ref and db.get(ch.ref) else ""))


@main.command()
@click.argument("scans", nargs=-1, required=True)
@click.option("--review", default=None, help="write an annotated PDF for debugging")
def recognize(scans: tuple[str, ...], review: str | None) -> None:
    """Recognize scanned cards and write the plan JSON to stdout."""
    plan = _recognize(scans, review)
    if sys.stderr.isatty():
        _err(_display(load_config(), plan))
    click.echo(plan.to_json())


def _apply(cfg: Config, plan: Plan, auto_approve: bool, verify: bool) -> None:
    click.echo(_display(cfg, plan), err=True)
    if plan.errors:
        raise click.ClickException(f"plan has {len(plan.errors)} error(s); fix the plan JSON and retry")
    if not plan.changes:
        _err("nothing to do")
        return
    if not auto_approve:
        answer = click.prompt("Apply these changes? Only 'yes' is accepted", default="", show_default=False)
        if answer.strip() != "yes":
            raise click.ClickException("aborted")
    sink = _sink(cfg)
    sink.apply(plan.changes)
    ledger = _ledger()
    for ch in plan.changes:
        if ch.ref:
            ledger.record(LedgerEntry(ts=datetime.now(), event="apply", source=ch.source, ref=ch.ref, title=ch.title))
    if verify:
        unmet = sink.verify(plan.changes)
        for line in unmet:
            _err(f"NOT APPLIED: {line}")
        if unmet:
            raise click.ClickException(f"{len(unmet)} change(s) did not land")
    _err(f"applied {len(plan.changes)} change(s)")


@main.command()
@click.argument("plan_file", default="-")
@click.option("--auto-approve", is_flag=True)
@click.option("--verify/--no-verify", default=True)
def apply(plan_file: str, auto_approve: bool, verify: bool) -> None:
    """Apply a plan JSON (file or -) to Things after confirmation."""
    text = sys.stdin.read() if plan_file == "-" else Path(plan_file).read_text()
    try:
        plan = Plan.from_json(text)
    except ValueError as exc:
        raise click.ClickException(f"invalid plan: {exc}") from exc
    _apply(load_config(), plan, auto_approve, verify)


@main.command()
@click.argument("scans", nargs=-1, required=True)
@click.option("--review", default=None)
@click.option("--auto-approve", is_flag=True)
@click.option("--verify/--no-verify", default=True)
def scan(scans: tuple[str, ...], review: str | None, auto_approve: bool, verify: bool) -> None:
    """recognize | apply in one step."""
    _apply(load_config(), _recognize(scans, review), auto_approve, verify)


@main.command()
@click.option("--forget", default=None, help="drop one ref from the outstanding list")
def status(forget: str | None) -> None:
    """List cards that were printed but never scanned back."""
    ledger = _ledger()
    if forget:
        ledger.record(LedgerEntry(ts=datetime.now(), event="forget", source="things", ref=forget))
        _err(f"forgot {forget}")
        return
    entries = ledger.outstanding()
    if not entries:
        click.echo("no outstanding cards")
        return
    rows = _db().get_many([e.ref for e in entries])
    for e in entries:
        row = rows.get(e.ref)
        state = "done in Things" if row and row.status != 0 else "outstanding"
        click.echo(f"{e.ts:%Y-%m-%d}  {e.size:<6} {e.title:<40} {state}")


@main.command()
def doctor() -> None:
    """Check the environment."""
    ok = True

    def report(name: str, problem: str | None) -> None:
        nonlocal ok
        click.echo(f"{'ok  ' if problem is None else 'FAIL'} {name}{'' if problem is None else ': ' + problem}")
        ok = ok and problem is None

    report("uv", None if subprocess.run(["uv", "--version"], capture_output=True).returncode == 0 else "not on PATH")
    try:
        _db().select("inbox")
        report("Things database", None)
    except click.ClickException as exc:
        report("Things database", exc.message)
    try:
        import keyring

        report("keychain token", None if keyring.get_password(things_auth.SERVICE, things_auth.ACCOUNT) else "missing (apply will prompt)")
    except Exception as exc:  # noqa: BLE001
        report("keychain token", str(exc))
    try:
        probe = qr_svg("papersync:///v1/things/doctor?size=3x5&boxes=1")
        engine.compile_pages(L.SIZES["3x5"], [], "doctor", "", [probe], "", "", False)
        report("Typst template", None)
    except Exception as exc:  # noqa: BLE001
        report("Typst template", str(exc))
    try:
        import ocrmac  # noqa: F401

        report("ocrmac", None)
    except Exception as exc:  # noqa: BLE001
        report("ocrmac", str(exc))
    if not ok:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests, lint, types** — all pass. ty will want a return annotation on `_render_common`; annotate it as `Callable[..., Any] -> Callable[..., Any]` with `from collections.abc import Callable` and `from typing import Any`, and drop the ignore comment.

- [ ] **Step 5: Try the real thing**

```bash
./local/bin/papersync doctor
./local/bin/papersync print inbox --no-open -o /tmp/ps
open /tmp/ps/*.pdf
```

Expected: doctor passes every row except possibly the token; a PDF per size with your real inbox.

- [ ] **Step 6: Commit** — `git commit -m "papersync: CLI commands"`

---

### Task 15: Opt-in real OCR test, README, cleanup of the old scripts

**Files:**
- Create: `tests/fixtures/handwriting.png`, `tests/test_ocr_real.py`
- Modify: `local/lib/papersync/README.md`, `CLAUDE.md`
- Delete: `local/bin/things-export`, `local/bin/things-print`, `local/bin/things-pdf-matcher.py`

- [ ] **Step 1: Make the handwriting fixture**

Write "some handwriting" by hand on a 3x5 card, scan or photograph it, convert to a grayscale PNG under 300 KB, and save it as `tests/fixtures/handwriting.png`. If no scanner is at hand, render the words with `cv2.putText` in a cursive-looking Hershey font (`cv2.FONT_HERSHEY_SCRIPT_SIMPLEX`) at 300 dpi and note in the test that Apple Vision reads it.

- [ ] **Step 2: Write the opt-in test**

```python
import os
from pathlib import Path

import cv2
import pytest

pytestmark = pytest.mark.skipif(os.environ.get("PAPERSYNC_REAL_OCR") != "1", reason="set PAPERSYNC_REAL_OCR=1")


def test_ocrmac_reads_handwriting() -> None:
    from papersync.recognize.ocr import OcrmacBackend, join_text

    gray = cv2.imread(str(Path(__file__).parent / "fixtures" / "handwriting.png"), cv2.IMREAD_GRAYSCALE)
    text = join_text(OcrmacBackend().recognize(gray)).lower()
    assert "handwriting" in text
```

Run: `PAPERSYNC_REAL_OCR=1 uv run pytest tests/test_ocr_real.py -q` — passes. `uv run pytest -q` without the variable reports it skipped.

- [ ] **Step 3: README and CLAUDE.md**

README: describe the round trip in four commands (`print`, mark cards, `scan`, `status`), the `papersync:printed` and `papersync:scanned` state tags, the configuration file with `[things.actions]`, where the token, ledger and box set registry live, and `PAPERSYNC_REAL_OCR=1`. Keep every sentence under 20 words.

CLAUDE.md: in Key Commands add `- **papersync**: \`local/lib/papersync\` is a uv project; run its checks with \`./script/test\` or \`cd local/lib/papersync && uv run pytest\``.

- [ ] **Step 4: Delete the old scripts and run everything**

```bash
git rm local/bin/things-export local/bin/things-print local/bin/things-pdf-matcher.py
./script/test
```

Expected: every block passes, including the papersync block.

- [ ] **Step 5: Re-symlink and smoke test through rcm**

```bash
RCRC=~/.dotfiles/rcrc rcup
ls -la ~/.local/lib/papersync ~/.local/bin/papersync
papersync --version
```

Expected: `~/.local/lib/papersync` is a single symlink to the repo directory, and `papersync --version` prints the version through the shim.

- [ ] **Step 6: Commit**

```bash
git add -A local/lib/papersync CLAUDE.md
git commit -m "papersync: real OCR test, docs, remove things-* scripts"
```

---

## Self-review notes

- Spec coverage: CLI surface (Task 14), config and box sets (4), QR payload (3), rendering with size selection, overflow modes, two-pass pagination, new cards, one file per size (6), ledger and status (7, 14), recognition with fiducials, homography, fill scoring, handwriting, new cards, errors, review PDF (11, 12), plan display with unified diff (13), apply with literal yes, auto-approve refusing errors, skip logic, keychain prompt, verify (9, 10, 14), tests including the scanner-free round trip and opt-in OCR (11, 12, 14, 15), migration (1, 15).
- The spec's "(four on 3x5)" example count is superseded by the v1 geometry, which fits six boxes at a 14 mm pitch; `max_boxes` is the source of truth.
- `Change.pages` for a continuation is appended in page order, so the display's `pages 2-3` range holds.
