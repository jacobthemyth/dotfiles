"""Draw papersync chrome onto a finished PDF, in PDF user space.

The marks must sit at the exact millimetre coordinates ``layout.py`` computes,
because ``recognize.geometry`` fits its homography to them and then looks every
box up in millimetres. Drawing them here, after the body renderer has finished,
keeps that guarantee independent of whatever produced the body.
"""

from pathlib import Path

import pymupdf

from papersync.payload import Payload
from papersync.render.qr import qr_matrix
from papersync.render.templates.v1 import layout as L  # noqa: N812

PT = 72.0 / 25.4
TOLERANCE_PT = 0.1 * PT
BLACK = (0.0, 0.0, 0.0)
FONT_DIR = Path(__file__).parent / "templates" / "v1" / "fonts"
FONT_REGULAR = ("psans", FONT_DIR / "NewCMSans10-Regular.otf")
FONT_BOLD = ("psansb", FONT_DIR / "NewCMSans10-Bold.otf")
TITLE_FILL = (0.882, 0.882, 0.882)  # luma 225, matching card.typ
FOOTER_GRAY = (0.431, 0.431, 0.431)  # luma 110, matching card.typ
TITLE_PT = 10
LABEL_PT = 6
FOOTER_PT = 6
# NewCMSans's own line-height metric reserves far more vertical room than its
# glyphs need (a math-font legacy: tall accents/stacks), so PyMuPDF's default
# `insert_textbox` fit check reports every one of these tightly sized boxes as
# too short even for a single short line. 0.8 keeps single-line text centred
# and legible while fitting the title bar, box labels and footer strip as
# ``layout.py`` sizes them.
TEXT_LINEHEIGHT = 0.8


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


def _title_text(page: pymupdf.Page, size: L.PageSize, text: str) -> None:
    """Draw ``text`` in the title bar, truncating with an ellipsis if it overflows.

    Obsidian note titles come from frontmatter or the filename and are
    unbounded in length, so this must degrade gracefully the way the Typst
    path does, rather than silently print an empty bar. A failed
    ``insert_textbox`` draws nothing, so retrying over the same rectangle is
    safe; the bar itself is drawn once, before any attempt.
    """
    bar = L.title_bar(size)
    page.draw_rect(rect(bar), color=None, fill=TITLE_FILL, width=0)
    inner = pymupdf.Rect(
        (bar.x + 1.4) * PT, (bar.y + 0.6) * PT, (bar.x + bar.w - 1.4) * PT, (bar.y + bar.h) * PT
    )
    candidate = text
    keep = len(text)
    while True:
        fit = page.insert_textbox(
            inner,
            candidate,
            fontsize=TITLE_PT,
            fontname=FONT_BOLD[0],
            color=BLACK,
            lineheight=TEXT_LINEHEIGHT,
        )
        if fit >= 0:
            return
        if candidate == "…":
            raise ChromeError(f"title does not fit in the title bar even as '…': {inner}")
        keep -= 1
        candidate = text[:keep] + "…" if keep > 0 else "…"


def _footer_text(page: pymupdf.Page, size: L.PageSize, text: str) -> None:
    """Rotated a quarter turn clockwise down the right margin.

    PyMuPDF measures ``rotate`` counterclockwise, so 270 is the clockwise
    quarter turn that ``card.typ`` writes as ``rotate(90deg)``.
    """
    strip = L.footer_rect(size)
    box = rect(strip)
    fit = page.insert_textbox(
        box,
        text,
        fontsize=FOOTER_PT,
        fontname=FONT_REGULAR[0],
        color=FOOTER_GRAY,
        rotate=270,
        lineheight=TEXT_LINEHEIGHT,
    )
    if fit < 0:
        raise ChromeError(f"footer {text!r} does not fit in {box}")


def _labels_text(page: pymupdf.Page, size: L.PageSize, labels: list[str]) -> None:
    for i, label in enumerate(labels):
        box = L.meta_box(size, i)
        label_rect = pymupdf.Rect(
            box.x * PT,
            (box.y + box.h + 0.5) * PT,
            (box.x + L.BOX_PITCH_MM) * PT,
            (box.y + box.h + 3.5) * PT,
        )
        fit = page.insert_textbox(
            label_rect,
            label,
            fontsize=LABEL_PT,
            fontname=FONT_REGULAR[0],
            color=BLACK,
            lineheight=TEXT_LINEHEIGHT,
        )
        if fit < 0:
            raise ChromeError(f"label {label!r} does not fit in {label_rect}")


def stamp(
    pdf: bytes,
    size: L.PageSize,
    labels: list[str],
    title: str,
    footer: str,
    payloads: list[Payload],
    primary_box: bool = False,
) -> bytes:
    """Return ``pdf`` with papersync chrome drawn on every page."""
    doc = pymupdf.open("pdf", pdf)
    stamp_marks(doc, size, labels, payloads, primary_box)
    total = doc.page_count
    for index in range(total):
        page = doc[index]
        for name, path in (FONT_REGULAR, FONT_BOLD):
            page.insert_font(fontname=name, fontfile=str(path))
        _footer_text(page, size, footer if total == 1 else f"{footer} · {index + 1}/{total}")
        _title_text(page, size, title if index == 0 else f"{title} (cont.)")
        if index == 0:
            _labels_text(page, size, labels)
    return doc.tobytes()
