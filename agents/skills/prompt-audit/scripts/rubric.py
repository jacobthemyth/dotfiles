"""Load model guides (bundled) and custom criteria (XDG), and select which apply
to a prompt by frontmatter: strict `model` match, `kind` routing. Stdlib only."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import common


@dataclass
class RubricFile:
    path: Path
    models: object   # set[str] or "*"
    kind: str        # "deterministic" | "judgment"
    meta: dict
    body: str


def _load_file(path: Path) -> RubricFile:
    meta, body = common.parse_frontmatter(path.read_text(encoding="utf-8"))
    model = meta.get("model", "*")
    if model == "*" or model is None:
        models: object = "*"
    elif isinstance(model, list):
        models = set(model)
    else:
        models = {model}
    return RubricFile(path=path, models=models, kind=meta.get("kind", "judgment"),
                      meta=meta, body=body)


def load_dir(directory: Path) -> list[RubricFile]:
    if not directory.is_dir():
        return []
    files = []
    for p in sorted(directory.glob("*.md")):
        try:
            files.append(_load_file(p))
        except (OSError, UnicodeDecodeError):
            continue
    return files


def load_all(references_dir: Path, criteria_dir: Path | None = None) -> list[RubricFile]:
    return load_dir(references_dir) + load_dir(criteria_dir or common.criteria_dir())


def applies_to(rf: RubricFile, model: str | None) -> bool:
    if rf.models == "*":
        return True
    return model is not None and model in rf.models


def resolve_for_model(model: str | None, files: list[RubricFile]) -> dict:
    applicable = [f for f in files if applies_to(f, model)]
    return {
        "deterministic": [f for f in applicable if f.kind == "deterministic"],
        "judgment": [f for f in applicable if f.kind == "judgment"],
    }
