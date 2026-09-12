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


def _lookup(refs: list[str]) -> dict[str, Item]:
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

    This ref is 6 folders deep and 67 characters long -- realistic for an
    Obsidian vault, and long enough that it overflowed the old fixed-version-5
    QR (segno.DataOverflowError around 46 plain characters). It must still
    stamp, survive a 300 dpi rasterization, and decode back intact.
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


def test_both_renderers_place_their_marks_at_the_same_coordinates(tmp_path: Path) -> None:
    """Typst renders Things cards and pymupdf renders documents.

    Two chrome implementations now exist. This test stops them drifting: it
    recovers the fiducial centres from each renderer's raster and compares them.
    """
    size = L.SIZES["letter"]
    opts = engine.RenderOptions(labels=LABELS, boxes_id=1, size="letter", overflow="paginate")
    typst_pdf = engine.render_item(
        Item(source="things", ref="T1", title="Alpha"), "letter", opts, TODAY
    ).pdf
    payload = Payload(1, "obsidian", "Notes/Alpha", size.name, 1)
    overlay_pdf = chrome.stamp(
        chrome.blank(size, 1), size, LABELS, "Alpha", TODAY.isoformat(), [payload]
    )

    h = synthetic.identity_h()
    centres = [geometry.mm_to_px(h, *f.center) for f in L.fiducials(size)]

    # Both renderers must put ink at every coordinate layout.py names, and white
    # space just outside each square. That is what holds them in agreement.
    for pdf in (typst_pdf, overlay_pdf):
        gray = synthetic.rasterize(pdf)
        for cx, cy in centres:
            assert gray[int(cy), int(cx)] < 128
        for f in L.fiducials(size):
            ox, oy = geometry.mm_to_px(h, f.x - 1.5, f.y - 1.5)
            assert gray[int(oy), int(ox)] > 200
