from datetime import date

import cv2
import numpy as np
import pytest

from papersync.model import Item
from papersync.recognize import geometry, marks, ocr
from papersync.recognize.qr import find_payload
from papersync.render import engine
from papersync.render.templates.v1 import layout as L  # noqa: N812
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
    assert np.array_equal(h0, geometry.homography_from_qr(decoded, SIZE))  # deterministic fit
    h = geometry.refine_with_fiducials(gray, h0, SIZE, qr_corners=decoded.corners)
    assert h is not None
    # the top-left fiducial center must land on dark pixels
    cx, cy = geometry.mm_to_px(h, *L.fiducials(SIZE)[0].center)
    assert gray[int(cy), int(cx)] < 60


def test_box_fill_distinguishes_marked_boxes() -> None:
    gray = _card([L.done_box(SIZE), L.meta_box(SIZE, 1)])
    decoded = find_payload(gray)
    assert decoded is not None
    h = geometry.refine_with_fiducials(
        gray, geometry.homography_from_qr(decoded, SIZE), SIZE, qr_corners=decoded.corners
    )
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

    import segno

    page = np.full((900, 1500), 255, dtype=np.uint8)
    buf = io.BytesIO()
    segno.make("https://example.com", error="m").save(buf, kind="png", scale=8, border=4)
    arr = cv2.imdecode(np.frombuffer(buf.getvalue(), np.uint8), cv2.IMREAD_GRAYSCALE)
    assert arr is not None
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


def test_lines_in_handles_a_rotated_homography() -> None:
    # Under rotation a box built from two projected corners is not the region: it
    # drops lines near the far corners of the real quadrilateral.
    rot = np.eye(3)
    rot[:2] = cv2.getRotationMatrix2D((750.0, 450.0), 10.0, 1.0)
    h = rot @ synthetic.identity_h()
    region = L.notes_region(SIZE)
    near = ocr.OcrLine("near", 0.9, *geometry.mm_to_px(h, region.x + 5, region.y + 5), 0, 0)
    far = ocr.OcrLine(
        "far", 0.9, *geometry.mm_to_px(h, region.x + region.w - 5, region.y + 3), 0, 0
    )
    outside = ocr.OcrLine("out", 0.9, *geometry.mm_to_px(h, 1, 1), 0, 0)
    kept = ocr.lines_in([outside, near, far], h, region)
    assert [line.text for line in kept] == ["near", "far"]


@pytest.mark.parametrize("angle_deg", [180.0, 10.0])
def test_round_trip_survives_larger_rotations(angle_deg: float) -> None:
    item = Item(source="things", ref="A" * 22, title="FOO", notes="n")
    gray = synthetic.rasterize(engine.render_item(item, "3x5", OPTS, date(2026, 9, 7)).pdf)
    synthetic.draw_x(gray, L.done_box(SIZE))
    # a scan leaves margin around the card; without it a 10-degree rotation
    # swings the bottom-left fiducial out of the frame
    padded = cv2.copyMakeBorder(gray, 150, 150, 150, 150, cv2.BORDER_CONSTANT, value=255)
    scan = synthetic.distort(padded, angle_deg=angle_deg, scale=1.0)
    decoded = find_payload(scan)
    assert decoded is not None and decoded.payload.ref == "A" * 22
    h = geometry.refine_with_fiducials(
        scan, geometry.homography_from_qr(decoded, SIZE), SIZE, qr_corners=decoded.corners
    )
    assert h is not None
    assert marks.classify(marks.box_fill(scan, h, L.done_box(SIZE))).checked
    assert not marks.classify(marks.box_fill(scan, h, L.meta_box(SIZE, 0))).checked
