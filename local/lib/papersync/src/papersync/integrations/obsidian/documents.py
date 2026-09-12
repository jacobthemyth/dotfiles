"""Turn Obsidian notes into stamped PDFs, one file per note.

One PDF per document is what makes duplex printing work for continuation pages
only: separate print jobs start each document on a sheet front, so no
blank-page padding is needed.
"""

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

import pymupdf

from papersync.integrations.obsidian import bridge
from papersync.model import Item
from papersync.payload import Payload
from papersync.render import chrome
from papersync.render.templates.v1 import layout as L  # noqa: N812

SLUG_MAX = 60
MANIFEST = "manifest.json"


def slug(name: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return (cleaned[:SLUG_MAX].rstrip("-")) or "note"


def frontmatter_pairs(meta: dict[str, Any], skip: list[str]) -> list[list[Any]]:
    return [[k, v] for k, v in meta.items() if k not in skip]


def build_spec(item: Item, out_path: Path, size: L.PageSize, skip: list[str]) -> dict[str, Any]:
    return {
        "papersync_spec": 1,
        "path": f"{item.ref}.md",
        "out": str(out_path),
        "page": {"width_mm": size.width, "height_mm": size.height},
        "margins_mm": {
            "top": L.TOP_MM,
            "right": L.MARGIN_MM,
            "bottom": L.BOTTOM_MM,
            "left": L.MARGIN_MM,
        },
        "frontmatter": frontmatter_pairs(item.meta, skip),
    }


@dataclass
class RenderedDocument:
    item: Item
    pdf: bytes
    pages: int
    size: str


def render_documents(
    cli: Any,
    items: list[Item],
    size: L.PageSize,
    labels: list[str],
    boxes_id: int,
    skip: list[str],
    today: date,
    workdir: Path,
    renderer: Callable[..., int] | None = None,
) -> list[RenderedDocument]:
    """Render each note through the bridge, then stamp chrome onto the result.

    ``renderer`` is resolved here rather than as a default argument, so a test
    can replace ``bridge.render`` on the module and have this call see it.
    """
    renderer = renderer or bridge.render
    workdir.mkdir(parents=True, exist_ok=True)
    out: list[RenderedDocument] = []
    for index, item in enumerate(items, start=1):
        body_path = workdir / f"{index:03d}-body.pdf"
        spec = build_spec(item, body_path, size, skip)
        renderer(cli, spec, workdir / f"{index:03d}-spec.json")
        body = body_path.read_bytes()
        # The bridge reports a page count too, but pymupdf is authoritative.
        pages = pymupdf.open("pdf", body).page_count
        payloads = [
            Payload(L.TEMPLATE_VERSION, item.source, item.ref, size.name, boxes_id, p, pages)
            for p in range(1, pages + 1)
        ]
        stamped = chrome.stamp(body, size, labels, item.title, today.isoformat(), payloads)
        out.append(RenderedDocument(item, stamped, pages, size.name))
    return out


def write_documents(
    docs: list[RenderedDocument], out_dir: Path, stamp: str, vault: str
) -> tuple[Path, list[Path]]:
    target = out_dir / f"papersync-{stamp}"
    target.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    entries: list[dict[str, Any]] = []
    for index, doc in enumerate(docs, start=1):
        name = f"{index:03d}-{slug(doc.item.title)}.pdf"
        path = target / name
        path.write_bytes(doc.pdf)
        paths.append(path)
        entries.append(
            {
                "index": index,
                "file": name,
                "ref": doc.item.ref,
                "path": f"{doc.item.ref}.md",
                "title": doc.item.title,
                "pages": doc.pages,
                "size": doc.size,
            }
        )
    manifest = {
        "papersync_manifest": 1,
        "created": datetime.now().isoformat(timespec="seconds"),
        "vault": vault,
        "source": "obsidian",
        "documents": entries,
    }
    (target / MANIFEST).write_text(json.dumps(manifest, indent=2))
    return target, paths
