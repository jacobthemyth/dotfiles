import pymupdf
import pytest

from papersync.payload import Payload
from papersync.render import chrome
from papersync.render.templates.v1 import layout as L  # noqa: N812

SIZE = L.SIZES["letter"]
TOL_PT = 0.1 * chrome.PT  # 0.1 mm


def _payloads(n: int) -> list[Payload]:
    return [
        Payload(1, "obsidian", "Notes/Alpha", SIZE.name, 1, page=i + 1, pages=n) for i in range(n)
    ]


def _black_squares(page: pymupdf.Page, side_mm: float) -> list[pymupdf.Rect]:
    """Filled black rectangles whose side matches ``side_mm`` within tolerance."""
    want = side_mm * chrome.PT
    out = []
    for d in page.get_drawings():
        r = d["rect"]
        if (
            d.get("fill") == (0.0, 0.0, 0.0)
            and abs(r.width - want) < TOL_PT
            and abs(r.height - want) < TOL_PT
        ):
            out.append(r)
    return out


def test_blank_makes_pages_of_the_requested_size() -> None:
    doc = pymupdf.open("pdf", chrome.blank(SIZE, 3))
    assert doc.page_count == 3
    assert abs(doc[0].rect.width - SIZE.width * chrome.PT) < TOL_PT
    assert abs(doc[0].rect.height - SIZE.height * chrome.PT) < TOL_PT


def test_fiducials_land_within_a_tenth_of_a_millimetre() -> None:
    doc = pymupdf.open("pdf", chrome.blank(SIZE, 1))
    chrome.stamp_marks(doc, SIZE, ["A", "B"], _payloads(1), primary_box=False)
    got = sorted((r.x0, r.y0) for r in _black_squares(doc[0], L.FIDUCIAL_MM))
    want = sorted((f.x * chrome.PT, f.y * chrome.PT) for f in L.fiducials(SIZE))
    assert len(got) == 4
    for (gx, gy), (wx, wy) in zip(got, want, strict=True):
        assert abs(gx - wx) < TOL_PT and abs(gy - wy) < TOL_PT


def test_meta_boxes_are_stroked_only_on_the_first_page() -> None:
    doc = pymupdf.open("pdf", chrome.blank(SIZE, 2))
    chrome.stamp_marks(doc, SIZE, ["A", "B", "C"], _payloads(2), primary_box=False)

    def stroked_small_squares(page: pymupdf.Page) -> list[pymupdf.Rect]:
        want = L.BOX_MM * chrome.PT
        return [
            d["rect"]
            for d in page.get_drawings()
            if d.get("color") is not None
            and d.get("fill") is None
            and abs(d["rect"].width - want) < TOL_PT
        ]

    first = sorted(r.x0 for r in stroked_small_squares(doc[0]))
    assert len(first) == 3
    for got, i in zip(first, range(3), strict=True):
        assert abs(got - L.meta_box(SIZE, i).x * chrome.PT) < TOL_PT
    assert stroked_small_squares(doc[1]) == []


def test_primary_box_is_drawn_only_when_requested() -> None:
    want = L.BOX_MM * chrome.PT
    doc_off = pymupdf.open("pdf", chrome.blank(SIZE, 1))
    chrome.stamp_marks(doc_off, SIZE, [], _payloads(1), primary_box=False)
    doc_on = pymupdf.open("pdf", chrome.blank(SIZE, 1))
    chrome.stamp_marks(doc_on, SIZE, [], _payloads(1), primary_box=True)

    def small_squares(page: pymupdf.Page) -> int:
        return sum(
            1
            for d in page.get_drawings()
            if d.get("fill") is None and abs(d["rect"].width - want) < TOL_PT
        )

    assert small_squares(doc_off[0]) == 0
    assert small_squares(doc_on[0]) == 1


def test_qr_modules_stay_inside_the_qr_rectangle() -> None:
    doc = pymupdf.open("pdf", chrome.blank(SIZE, 1))
    chrome.stamp_marks(doc, SIZE, [], _payloads(1), primary_box=False)
    q = L.qr_rect(SIZE)
    box = pymupdf.Rect(
        q.x * chrome.PT, q.y * chrome.PT, (q.x + q.w) * chrome.PT, (q.y + q.h) * chrome.PT
    )
    modules = [
        d["rect"]
        for d in doc[0].get_drawings()
        if d.get("fill") == (0.0, 0.0, 0.0)
        # pymupdf stores rect coords as float32, so a fiducial's width can round to
        # fractionally under L.FIDUCIAL_MM * chrome.PT on read-back; back off by TOL_PT
        # so real fiducials are never misclassified as (much smaller) QR modules.
        and d["rect"].width < L.FIDUCIAL_MM * chrome.PT - TOL_PT
    ]
    assert len(modules) > 50  # merged runs, so far fewer than 37*37 but plenty
    for r in modules:
        assert r.x0 >= box.x0 - TOL_PT and r.x1 <= box.x1 + TOL_PT
        assert r.y0 >= box.y0 - TOL_PT and r.y1 <= box.y1 + TOL_PT


def test_wrong_page_size_is_rejected() -> None:
    doc = pymupdf.open("pdf", chrome.blank(L.SIZES["4x6"], 1))
    with pytest.raises(chrome.ChromeError, match="page 1 is"):
        chrome.stamp_marks(doc, SIZE, [], _payloads(1), primary_box=False)


def test_payload_count_must_match_page_count() -> None:
    doc = pymupdf.open("pdf", chrome.blank(SIZE, 2))
    with pytest.raises(chrome.ChromeError, match="1 payload"):
        chrome.stamp_marks(doc, SIZE, [], _payloads(1), primary_box=False)
