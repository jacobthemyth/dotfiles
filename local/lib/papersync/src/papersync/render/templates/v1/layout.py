"""Template v1 geometry. Millimeters, origin top-left, y grows downward."""

from dataclasses import dataclass

TEMPLATE_VERSION = 2
FILL_LOW = 0.06
FILL_HIGH = 0.20
BOX_INSET_MM = 0.7
FIDUCIAL_MM = 5.0
QR_MM = 14.0
BOX_MM = 4.0
BOX_PITCH_MM = 14.0
MARGIN_MM = 12.0
TOP_MM = 22.0  # notes start


@dataclass(frozen=True)
class Rect:
    x: float
    y: float
    w: float
    h: float

    @property
    def center(self) -> tuple[float, float]:
        return (self.x + self.w / 2, self.y + self.h / 2)

    def inset(self, d: float) -> "Rect":
        return Rect(self.x + d, self.y + d, self.w - 2 * d, self.h - 2 * d)

    def corners(self) -> list[tuple[float, float]]:
        return [
            (self.x, self.y),
            (self.x + self.w, self.y),
            (self.x + self.w, self.y + self.h),
            (self.x, self.y + self.h),
        ]

    def as_dict(self) -> dict[str, float]:
        return {"x": self.x, "y": self.y, "w": self.w, "h": self.h}


@dataclass(frozen=True)
class Edges:
    """The geometry that differs between template versions.

    v1 put the corner squares 4 mm from the page edge, inside the 4.23 mm a
    Brother HL-L8360CDW cannot print. v2 moves them to 6 mm, and moves the QR
    and the notes bottom inward by the same 2 mm so every clearance stays the
    same. A scan reads the version from the QR, so v1 cards still scan.
    """

    fiducial_inset: float
    bottom: float  # notes end, measured from bottom edge


EDGES: dict[int, Edges] = {1: Edges(4.0, 27.0), 2: Edges(6.0, 29.0)}
FIDUCIAL_INSET_MM = EDGES[TEMPLATE_VERSION].fiducial_inset
BOTTOM_MM = EDGES[TEMPLATE_VERSION].bottom


@dataclass(frozen=True)
class PageSize:
    name: str
    width: float
    height: float


SIZES: dict[str, PageSize] = {
    "3x5": PageSize("3x5", 127.0, 76.2),
    "4x6": PageSize("4x6", 152.4, 101.6),
    "letter": PageSize("letter", 215.9, 279.4),
}
SIZE_ORDER = ["3x5", "4x6", "letter"]


def fiducials(size: PageSize, version: int = TEMPLATE_VERSION) -> list[Rect]:
    i, f = EDGES[version].fiducial_inset, FIDUCIAL_MM
    return [
        Rect(i, i, f, f),
        Rect(size.width - i - f, i, f, f),
        Rect(i, size.height - i - f, f, f),
        Rect(size.width - i - f, size.height - i - f, f, f),
    ]


def qr_rect(size: PageSize, version: int = TEMPLATE_VERSION) -> Rect:
    edge = EDGES[version].fiducial_inset + FIDUCIAL_MM + 2.0  # 13 mm from the page edge in v2
    return Rect(size.width - edge - QR_MM, size.height - edge - QR_MM, QR_MM, QR_MM)


def done_box(size: PageSize) -> Rect:
    return Rect(MARGIN_MM, MARGIN_MM, BOX_MM, BOX_MM)


def title_bar(size: PageSize) -> Rect:
    left = MARGIN_MM + BOX_MM + 2.0
    return Rect(left, MARGIN_MM - 1.0, size.width - MARGIN_MM - left, 6.0)


def footer_rect(size: PageSize) -> Rect:
    """Vertical strip in the right margin for the rotated date and page marker.

    It runs from just below the top-right corner square to just above the QR,
    between the text margin and the corner-square column, so it never
    competes with the title bar or the meta boxes.
    """
    top = FIDUCIAL_INSET_MM + FIDUCIAL_MM + 2.0
    bottom = qr_rect(size).y - 2.0
    return Rect(size.width - MARGIN_MM + 0.5, top, 2.5, bottom - top)


def notes_region(size: PageSize, version: int = TEMPLATE_VERSION) -> Rect:
    bottom = EDGES[version].bottom
    return Rect(MARGIN_MM, TOP_MM, size.width - 2 * MARGIN_MM, size.height - TOP_MM - bottom)


def meta_box(size: PageSize, index: int) -> Rect:
    return Rect(MARGIN_MM + index * BOX_PITCH_MM, size.height - MARGIN_MM, BOX_MM, BOX_MM)


LABEL_GAP_MM = 0.5  # gap between a meta box and its label, matching card.typ's own +0.5
LABEL_BAND_MM = 3.0  # vertical room reserved for the label text below a box


def label_band(size: PageSize, index: int) -> Rect:
    """Where a meta box's label is drawn, just below the box itself.

    card.typ restates this offset by hand (Typst cannot import this module),
    but chrome.py and anything checking the invariant both use this.
    """
    box = meta_box(size, index)
    return Rect(box.x, box.y + box.h + LABEL_GAP_MM, BOX_PITCH_MM, LABEL_BAND_MM)


def max_boxes(size: PageSize) -> int:
    limit = qr_rect(size).x - 2.0
    n = 0
    while meta_box(size, n).x + BOX_MM + 2.0 < limit:
        n += 1
    return n


def geometry(size: PageSize, labels: list[str], primary_box: bool = True) -> dict[str, object]:
    return {
        "width": size.width,
        "height": size.height,
        "margin": MARGIN_MM,
        "top": TOP_MM,
        "bottom": BOTTOM_MM,
        "primary_box": primary_box,
        "fiducials": [r.as_dict() for r in fiducials(size)],
        "qr": qr_rect(size).as_dict(),
        "done_box": done_box(size).as_dict(),
        "title_bar": title_bar(size).as_dict(),
        "footer": footer_rect(size).as_dict(),
        "meta_boxes": [
            {"rect": meta_box(size, i).as_dict(), "label": label} for i, label in enumerate(labels)
        ],
    }
