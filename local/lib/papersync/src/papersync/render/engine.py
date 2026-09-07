import json
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import pymupdf
import typst

from papersync.model import Item
from papersync.payload import NEW_REF, Payload
from papersync.render.qr import qr_svg
from papersync.render.templates.v1 import layout as L  # noqa: N812

TEMPLATE_DIR = Path(__file__).parent / "templates" / "v1"
TEMPLATE = TEMPLATE_DIR / "card.typ"
FONT_DIR = TEMPLATE_DIR / "fonts"
TRUNCATION_MARK = "[…]"


class RenderOverflow(Exception):  # noqa: N818
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
        size,
        opts.labels,
        item.title,
        notes,
        _payloads(item.ref, size.name, opts.boxes_id, 1),
        f"{item.title} (cont.)",
        footer_base,
        False,
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
            return render_item(
                item, name, RenderOptions(opts.labels, opts.boxes_id, name, "fail"), today
            )
        except RenderOverflow:
            continue  # content or box labels do not fit: try the next size
    return render_item(
        item, "letter", RenderOptions(opts.labels, opts.boxes_id, "letter", "paginate"), today
    )


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
