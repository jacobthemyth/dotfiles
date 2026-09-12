"""Draw papersync chrome onto a finished PDF, in PDF user space.

The marks must sit at the exact millimetre coordinates ``layout.py`` computes,
because ``recognize.geometry`` fits its homography to them and then looks every
box up in millimetres. Drawing them here, after the body renderer has finished,
keeps that guarantee independent of whatever produced the body.
"""

import pymupdf

from papersync.payload import Payload
from papersync.render.qr import qr_matrix
from papersync.render.templates.v1 import layout as L  # noqa: N812

PT = 72.0 / 25.4
TOLERANCE_PT = 0.1 * PT
BLACK = (0.0, 0.0, 0.0)


class ChromeError(RuntimeError):
    pass


def rect(r: L.Rect) -> pymupdf.Rect:
    return pymupdf.Rect(r.x * PT, r.y * PT, (r.x + r.w) * PT, (r.y + r.h) * PT)


def blank(size: L.PageSize, pages: int) -> bytes:
    doc = pymupdf.open()
    for _ in range(pages):
        doc.new_page(width=size.width * PT, height=size.height * PT)
    return doc.tobytes()


def _check_page(page: pymupdf.Page, size: L.PageSize, number: int) -> None:
    if page.rotation:
        raise ChromeError(f"page {number} is rotated {page.rotation} degrees")
    want_w, want_h = size.width * PT, size.height * PT
    if (
        abs(page.rect.width - want_w) > TOLERANCE_PT
        or abs(page.rect.height - want_h) > TOLERANCE_PT
    ):
        raise ChromeError(
            f"page {number} is {page.rect.width / PT:.1f}x{page.rect.height / PT:.1f} mm, "
            f"expected {size.width}x{size.height} mm"
        )


def _draw_qr(page: pymupdf.Page, size: L.PageSize, payload: Payload) -> None:
    """Draw modules as filled rectangles, merging runs so no seam shows."""
    matrix = qr_matrix(payload.to_url())
    q = L.qr_rect(size)
    step = q.w / len(matrix)
    for row, bits in enumerate(matrix):
        col = 0
        while col < len(bits):
            if not bits[col]:
                col += 1
                continue
            start = col
            while col < len(bits) and bits[col]:
                col += 1
            page.draw_rect(
                pymupdf.Rect(
                    (q.x + start * step) * PT,
                    (q.y + row * step) * PT,
                    (q.x + col * step) * PT,
                    (q.y + (row + 1) * step) * PT,
                ),
                color=None,
                fill=BLACK,
                width=0,
            )


def stamp_marks(
    doc: pymupdf.Document,
    size: L.PageSize,
    labels: list[str],
    payloads: list[Payload],
    primary_box: bool,
) -> None:
    """Draw fiducials, QR codes and boxes onto every page of ``doc`` in place."""
    if len(payloads) != doc.page_count:
        raise ChromeError(f"{len(payloads)} payload(s) for {doc.page_count} page(s)")
    for index in range(doc.page_count):
        page = doc[index]
        _check_page(page, size, index + 1)
        for f in L.fiducials(size):
            page.draw_rect(rect(f), color=None, fill=BLACK, width=0)
        _draw_qr(page, size, payloads[index])
        if index:
            continue
        if primary_box:
            page.draw_rect(rect(L.done_box(size)), color=BLACK, width=0.4)
        for i in range(len(labels)):
            page.draw_rect(rect(L.meta_box(size, i)), color=BLACK, width=0.4)
