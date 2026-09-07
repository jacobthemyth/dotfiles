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
    tl = mm_to_px(h, region.x, region.y)
    br = mm_to_px(h, region.x + region.w, region.y + region.h)
    x0, x1 = sorted((tl[0], br[0]))
    y0, y1 = sorted((tl[1], br[1]))
    return [
        line
        for line in lines
        if x0 <= line.x + line.w / 2 <= x1 and y0 <= line.y + line.h / 2 <= y1
    ]


def join_text(lines: list[OcrLine]) -> str:
    return "\n".join(line.text for line in sorted(lines, key=lambda line: (line.y, line.x)))
