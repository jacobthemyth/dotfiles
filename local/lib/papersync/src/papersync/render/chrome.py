"""Draw papersync chrome onto a finished PDF, in PDF user space.

The marks must sit at the exact millimetre coordinates ``layout.py`` computes,
because ``recognize.geometry`` fits its homography to them and then looks every
box up in millimetres. Drawing them here, after the body renderer has finished,
keeps that guarantee independent of whatever produced the body.
"""

from pathlib import Path

import pymupdf

from papersync.payload import Payload
from papersync.render.qr import QrCapacityError, qr_matrix
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
# PyMuPDF-builtin CJK fonts, tried in this order when NewCMSans cannot render
# a title. Each is a full CID-keyed font that also covers ASCII, so it can
# stand in for the whole title, not just its CJK characters.
CJK_FALLBACK_FONTS = ("china-s", "china-t", "japan", "korea")
# Substituted for a character no available font can render (an emoji, say),
# so the title bar shows a visible mark instead of dropping the character or,
# worse, going blank.
GLYPH_PLACEHOLDER = "?"
_FONT_CACHE: dict[str, pymupdf.Font] = {}
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
    try:
        matrix = qr_matrix(payload.to_url())
    except QrCapacityError as exc:
        raise ChromeError(str(exc)) from exc
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
    if len(labels) > L.max_boxes(size):
        raise ChromeError(
            f"{len(labels)} box labels do not fit on {size.name} (max {L.max_boxes(size)})"
        )
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


def _font_object(name: str, fontfile: Path | None = None) -> pymupdf.Font:
    """A cached ``pymupdf.Font``, for ``has_glyph`` checks only (not drawing)."""
    cached = _FONT_CACHE.get(name)
    if cached is None:
        cached = pymupdf.Font(fontfile=str(fontfile)) if fontfile else pymupdf.Font(name)
        _FONT_CACHE[name] = cached
    return cached


def _covers(font: pymupdf.Font, text: str) -> bool:
    return all(font.has_glyph(ord(ch)) != 0 for ch in text)


def _title_font_and_text(page: pymupdf.Page, text: str) -> tuple[str, str]:
    """Pick a registered font name that can render every character of ``text``.

    NewCMSans has no CJK or astral (e.g. emoji) glyphs, and ``insert_textbox``
    reports a non-negative fit even when it silently drew notdefs for
    characters the font lacks -- an all-CJK title draws as a blank bar, and a
    title with one emoji drops just that character, with no error either way.
    Prefer a real PyMuPDF-builtin CJK font when one covers the whole title
    (so real script renders as real script); otherwise fall back to the main
    font with every unrenderable character replaced by a visible placeholder,
    so the bar is never blank and never silently missing a character.
    """
    if _covers(_font_object(FONT_BOLD[0], FONT_BOLD[1]), text):
        return FONT_BOLD[0], text
    for name in CJK_FALLBACK_FONTS:
        if _covers(_font_object(name), text):
            page.insert_font(fontname=name)
            return name, text
    main = _font_object(FONT_BOLD[0], FONT_BOLD[1])
    sanitized = "".join(ch if main.has_glyph(ord(ch)) else GLYPH_PLACEHOLDER for ch in text)
    return FONT_BOLD[0], sanitized


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
    fontname, text = _title_font_and_text(page, text)
    candidate = text
    keep = len(text)
    while True:
        fit = page.insert_textbox(
            inner,
            candidate,
            fontsize=TITLE_PT,
            fontname=fontname,
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
        label_rect = rect(L.label_band(size, i))
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
