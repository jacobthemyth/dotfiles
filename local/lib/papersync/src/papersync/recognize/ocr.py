from dataclasses import dataclass
from typing import Protocol

import numpy as np

from papersync.recognize.geometry import mm_to_px
from papersync.render.templates.v1 import layout as L  # noqa: N812


@dataclass
class OcrLine:
    text: str
    confidence: float
    x: float
    y: float
    w: float
    h: float


class OcrBackend(Protocol):
    def recognize(self, gray: np.ndarray) -> list[OcrLine]: ...


class OcrmacBackend:
    """Apple Vision through ocrmac. macOS only; imported lazily."""

    def recognize(self, gray: np.ndarray) -> list[OcrLine]:
        from ocrmac import ocrmac
        from PIL import Image

        image = Image.fromarray(gray)
        raw = ocrmac.OCR(image, recognition_level="accurate").recognize(px=True)
        lines = [
            OcrLine(t, float(c), float(x), float(y), float(w), float(h))
            for t, c, (x, y, w, h) in raw
        ]
        return sorted(lines, key=lambda line: (line.y, line.x))


def lines_in(lines: list[OcrLine], h: np.ndarray, region: L.Rect) -> list[OcrLine]:
    """Keep lines whose pixel center falls inside ``region`` (mm).

    The center is mapped back through the inverse homography rather than comparing
    against a box built from two projected corners: the pipeline's homographies are
    rotated, so an axis-aligned box in pixel space is not the region.
    """
    inv = np.linalg.inv(h)
    kept = []
    for line in lines:
        mx, my = mm_to_px(inv, line.x + line.w / 2, line.y + line.h / 2)
        if region.x <= mx <= region.x + region.w and region.y <= my <= region.y + region.h:
            kept.append(line)
    return kept


def join_text(lines: list[OcrLine]) -> str:
    return "\n".join(line.text for line in sorted(lines, key=lambda line: (line.y, line.x)))
