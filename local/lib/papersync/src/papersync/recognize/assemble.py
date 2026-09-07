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
from papersync.render.templates.v1 import layout as L  # noqa: N812


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


def _finish(
    pending: _Pending | None, today: date, changes: list[Change], errors: list[PlanError]
) -> None:
    if pending is None:
        return
    missing = set(range(1, pending.expected_pages + 1)) - pending.seen_pages
    if missing:
        errors.append(
            PlanError(
                page=pending.change.pages[0],
                message=f"{pending.change.title!r}: pages {sorted(missing)} missing",
            )
        )
    text = "\n\n".join(pending.handwriting)
    if pending.change.kind == "create":
        if text:
            pending.change.notes = (
                f"{pending.change.notes}\n\n{text}" if pending.change.notes else text
            )
    elif text:
        pending.change.append_notes = scanned_block(text, today)
    changes.append(pending.change)


def _score_boxes(
    gray: np.ndarray, h: np.ndarray, size: L.PageSize, labels: list[str], overlay: PageOverlay
) -> dict[str, BoxResult]:
    out: dict[str, BoxResult] = {}
    for label, rect in [
        ("done", L.done_box(size)),
        *[(lb, L.meta_box(size, i)) for i, lb in enumerate(labels)],
    ]:
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
                errors.append(
                    PlanError(page=page_no, message="handwriting page with no card before it")
                )
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
                errors.append(
                    PlanError(
                        page=page_no,
                        message=(
                            f"continuation page {payload.page} of {payload.ref} "
                            "without its first page"
                        ),
                    )
                )
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
            change = Change(
                kind="create",
                source=payload.source,
                title=title,
                notes=rest,
                complete=boxes["done"].checked,
                marks=marked,
                boxes=boxes,
                pages=[page_no],
            )
            overlay.note = "new"
        else:
            item = lookup([payload.ref]).get(payload.ref)
            title = item.title if item else f"(unknown {payload.ref})"
            change = Change(
                kind="update",
                source=payload.source,
                ref=payload.ref,
                title=title,
                complete=boxes["done"].checked,
                marks=marked,
                boxes=boxes,
                pages=[page_no],
            )
            overlay.note = title
        pending = _Pending(change, [], payload.pages, {1})
    _finish(pending, today, changes, errors)
    plan = Plan(created=datetime.now(), inputs=inputs, changes=changes, errors=errors)
    return Recognized(plan, overlays)
