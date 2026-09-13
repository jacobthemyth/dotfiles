"""End-to-end proof that stamped chrome is dimensionally trustworthy.

Stamp a blank page, rasterize it at scan resolution, then run the real
recognizer over it. If the QR decodes and every box lands where ``layout.py``
says it does, Chromium's page scaling cannot break recognition.
"""

from datetime import date
from pathlib import Path

import cv2
import numpy as np

from papersync.boxsets import BoxSetRegistry
from papersync.model import Item
from papersync.payload import Payload
from papersync.recognize import geometry
from papersync.recognize.assemble import recognize_pages
from papersync.recognize.ocr import OcrLine
from papersync.recognize.raster import RasterPage
from papersync.render import chrome, engine
from papersync.render.qr import qr_matrix
from papersync.render.templates.v1 import layout as L  # noqa: N812
from tests import synthetic

SIZE = L.SIZES["letter"]
TODAY = date(2026, 9, 12)
LABELS = ["A", "B", "C", "D"]


class NoOcr:
    def recognize(self, gray: np.ndarray) -> list[OcrLine]:
        return []


def _registry(tmp_path: Path) -> BoxSetRegistry:
    reg = BoxSetRegistry(tmp_path / "boxsets.toml")
    assert reg.id_for(LABELS) == 1
    return reg


def _lookup(source: str, refs: list[str]) -> dict[str, Item]:
    return {r: Item(source="obsidian", ref=r, title="Alpha") for r in refs}


def _stamped(pages: int, ref: str = "Notes/Projects/Alpha") -> bytes:
    payloads = [
        Payload(1, "obsidian", ref, SIZE.name, 1, page=i + 1, pages=pages) for i in range(pages)
    ]
    return chrome.stamp(
        chrome.blank(SIZE, pages), SIZE, LABELS, "Alpha", TODAY.isoformat(), payloads
    )


def test_stamped_page_survives_rasterization_and_recognition(tmp_path: Path) -> None:
    gray = synthetic.rasterize(_stamped(1))
    synthetic.draw_x(gray, L.meta_box(SIZE, 0))
    synthetic.draw_x(gray, L.meta_box(SIZE, 2))

    rec = recognize_pages(
        [RasterPage("fake.pdf", 0, gray)], NoOcr(), _registry(tmp_path), _lookup, TODAY, ["fake"]
    )

    assert rec.plan.errors == []
    change = rec.plan.changes[0]
    assert change.ref == "Notes/Projects/Alpha"
    assert change.marks == ["A", "C"]
    assert change.complete is False


def test_stamped_pages_survive_rotation_and_scaling(tmp_path: Path) -> None:
    """A real scan is never square to the platen. The homography must absorb that.

    A scan leaves margin around the page (see
    ``test_round_trip_survives_larger_rotations`` in test_recognize_primitives.py):
    without it, a letter page's corner fiducials -- already only 9 mm from the
    physical edge -- swing off the raster under this rotation and scale, purely
    from page-corner-to-center distance, well before any recognizer logic runs.
    """
    padded = cv2.copyMakeBorder(
        synthetic.rasterize(_stamped(1)), 150, 150, 150, 150, cv2.BORDER_CONSTANT, value=255
    )
    gray = synthetic.distort(padded)

    rec = recognize_pages(
        [RasterPage("fake.pdf", 0, gray)], NoOcr(), _registry(tmp_path), _lookup, TODAY, ["fake"]
    )
    assert rec.plan.errors == []
    assert rec.plan.changes[0].ref == "Notes/Projects/Alpha"


def test_deeply_nested_ref_survives_round_trip(tmp_path: Path) -> None:
    """A short 20-char ref is what let the QR version-5 overflow through review.

    This ref is a deliberately oversized synthetic ref, not modeled on any
    one source -- it guards QR capacity for a long ref generally. It is 6
    folders deep and 67 characters long, long enough that it overflowed the
    old fixed-version-5 QR (segno.DataOverflowError around 46 plain
    characters). It must still stamp, survive a 300 dpi rasterization, and
    decode back intact. Obsidian refs are no longer path-shaped: they are
    now fixed-length 12-character minted ids, so this scenario cannot arise
    from a real Obsidian vault, only from some other source with an
    unbounded ref.
    """
    ref = "Areas/Work/Projects/2026/Q3/Client Alpha/Meeting Notes 2026-09-12"
    gray = synthetic.rasterize(_stamped(1, ref=ref))

    rec = recognize_pages(
        [RasterPage("fake.pdf", 0, gray)], NoOcr(), _registry(tmp_path), _lookup, TODAY, ["fake"]
    )

    assert rec.plan.errors == []
    assert rec.plan.changes[0].ref == ref


def test_continuation_pages_are_gathered_into_one_change(tmp_path: Path) -> None:
    pdf = _stamped(3)
    pages = [RasterPage("fake.pdf", i, synthetic.rasterize(pdf, page=i)) for i in range(3)]

    rec = recognize_pages(pages, NoOcr(), _registry(tmp_path), _lookup, TODAY, ["fake"])
    assert rec.plan.errors == []
    assert len(rec.plan.changes) == 1
    assert rec.plan.changes[0].pages == [1, 2, 3]


def _mean_gray(
    gray: np.ndarray, h: np.ndarray, x_mm: float, y_mm: float, radius_mm: float
) -> float:
    """Mean pixel value in a small square window centred on (x_mm, y_mm)."""
    cx, cy = geometry.mm_to_px(h, x_mm, y_mm)
    r = max(1, round(radius_mm * 300 / 25.4))
    y0, y1 = max(0, round(cy) - r), round(cy) + r + 1
    x0, x1 = max(0, round(cx) - r), round(cx) + r + 1
    return float(gray[y0:y1, x0:x1].mean())


def _has_ink(
    gray: np.ndarray, h: np.ndarray, x_mm: float, y_mm: float, radius_mm: float = 0.3
) -> bool:
    return _mean_gray(gray, h, x_mm, y_mm, radius_mm) < 128


def test_both_renderers_place_their_marks_at_the_same_coordinates(tmp_path: Path) -> None:
    """Typst renders Things cards and pymupdf renders documents.

    Two chrome implementations now exist, restating shared constants by hand
    (fill colours, stroke widths, font sizes, the label offset). This test is
    what stops them drifting apart: it renders the same layout through both,
    rasterizes both, and compares ink between them -- not just each against
    its own expectation -- at every kind of mark layout.py names: fiducials,
    every QR module, every meta box (and the primary/done box), and the title
    bar's fill. A renderer that moves, resizes or recolors any of these fails
    this test even if its own output still "looks right" in isolation.
    """
    size = L.SIZES["letter"]
    opts = engine.RenderOptions(labels=LABELS, boxes_id=1, size="letter", overflow="paginate")
    item = Item(source="things", ref="T1", title="Alpha")
    typst_pdf = engine.render_item(item, "letter", opts, TODAY).pdf
    # Same source/ref/size/boxes/page/pages as engine._payloads derives for
    # this item, so both renderers encode the *same* QR payload -- otherwise
    # the two QR codes would legitimately differ and the module-by-module
    # comparison below would be meaningless.
    payload = Payload(1, item.source, item.ref, size.name, opts.boxes_id)
    overlay_pdf = chrome.stamp(
        chrome.blank(size, 1),
        size,
        LABELS,
        item.title,
        TODAY.isoformat(),
        [payload],
        primary_box=True,  # engine.compile_pages defaults primary_box to True too
    )

    gray_t = synthetic.rasterize(typst_pdf)
    gray_p = synthetic.rasterize(overlay_pdf)
    h = synthetic.identity_h()

    # Fiducials: ink at every centre, clear space just outside, in both.
    for f in L.fiducials(size):
        cx, cy = f.center
        assert _has_ink(gray_t, h, cx, cy) and _has_ink(gray_p, h, cx, cy)
        ox, oy = f.x - 1.5, f.y - 1.5
        assert not _has_ink(gray_t, h, ox, oy) and not _has_ink(gray_p, h, ox, oy)

    # QR: every module lands where the shared payload's own matrix says, in
    # both renderers -- so if either one drifts by even a fraction of a
    # module, this catches it directly.
    matrix = qr_matrix(payload.to_url())
    q = L.qr_rect(size)
    step = q.w / len(matrix)
    for row, bits in enumerate(matrix):
        for col, bit in enumerate(bits):
            mx, my = q.x + (col + 0.5) * step, q.y + (row + 0.5) * step
            expect_ink = bool(bit)
            r = step * 0.3
            assert _has_ink(gray_t, h, mx, my, r) == expect_ink
            assert _has_ink(gray_p, h, mx, my, r) == expect_ink

    # Meta boxes and the primary/done box: the 0.4pt stroke lands on all four
    # corners in both, the interior is unfilled in both, and the margin just
    # outside is clear in both.
    boxes = [L.done_box(size), *(L.meta_box(size, i) for i in range(len(LABELS)))]
    for box in boxes:
        for cx, cy in box.corners():
            assert _has_ink(gray_t, h, cx, cy, 0.2) == _has_ink(gray_p, h, cx, cy, 0.2)
        icx, icy = box.center
        assert not _has_ink(gray_t, h, icx, icy) and not _has_ink(gray_p, h, icx, icy)
        ox, oy = box.x - 1.0, box.y - 1.0
        assert not _has_ink(gray_t, h, ox, oy) and not _has_ink(gray_p, h, ox, oy)

    # Title bar: a flat luma(225)/(0.882, 0.882, 0.882) fill. Sampled away
    # from the glyphs (the two renderers antialias text differently, so
    # comparing glyph pixels directly would be flaky) but at both the top and
    # bottom edges, so a renderer that undersizes the bar -- as card.typ once
    # did, leaving its bottom ~0.6mm short of layout.py's title_bar.h -- is
    # caught even though the fill colour itself is unchanged.
    bar = L.title_bar(size)
    for frac in (0.05, 0.5, 0.95):
        x = bar.x + frac * bar.w
        for y in (bar.y + 0.3, bar.y + bar.h - 0.3):
            gt = _mean_gray(gray_t, h, x, y, 0.2)
            gp = _mean_gray(gray_p, h, x, y, 0.2)
            assert abs(gt - gp) < 20, f"title bar fill differs at ({x}, {y}): {gt} vs {gp}"
            assert 190 < gt < 245 and 190 < gp < 245
    assert not _has_ink(gray_t, h, bar.x, bar.y - 1.0)
    assert not _has_ink(gray_p, h, bar.x, bar.y - 1.0)
