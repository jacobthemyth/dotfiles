"""Turn a rendered card into a fake scan: rasterize, draw marks, rotate, scale."""

import cv2
import numpy as np
import pymupdf

from papersync.recognize.geometry import mm_to_px
from papersync.render.templates.v1 import layout as L  # noqa: N812


def rasterize(pdf: bytes, page: int = 0, dpi: int = 300) -> np.ndarray:
    pix = pymupdf.open("pdf", pdf)[page].get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width).copy()


def identity_h(dpi: int = 300) -> np.ndarray:
    s = dpi / 25.4
    return np.array([[s, 0, 0], [0, s, 0], [0, 0, 1]], dtype=np.float64)


def draw_x(gray: np.ndarray, rect: L.Rect, h: np.ndarray | None = None) -> None:
    h = identity_h() if h is None else h
    inner = rect.inset(0.5)
    tl, tr, br, bl = (mm_to_px(h, x, y) for x, y in inner.corners())
    for a, b in ((tl, br), (tr, bl)):
        cv2.line(gray, (int(a[0]), int(a[1])), (int(b[0]), int(b[1])), 0, 3)


def distort(gray: np.ndarray, angle_deg: float = 2.5, scale: float = 1.03) -> np.ndarray:
    hgt, wid = gray.shape
    m = cv2.getRotationMatrix2D((wid / 2, hgt / 2), angle_deg, scale)
    return cv2.warpAffine(gray, m, (wid, hgt), borderValue=255)


def handwriting_page(width: int = 1500, height: int = 1000) -> np.ndarray:
    """Height 1000 so tests can tell it from a 3x5 card raster (900 rows)."""
    page = np.full((height, width), 255, dtype=np.uint8)
    cv2.putText(page, "some handwriting", (200, 400), cv2.FONT_HERSHEY_SIMPLEX, 3, 0, 6)
    return page
