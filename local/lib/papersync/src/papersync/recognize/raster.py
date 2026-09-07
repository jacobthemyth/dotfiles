from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pymupdf

DPI = 300


@dataclass
class RasterPage:
    file: str
    index: int
    gray: np.ndarray


def iter_pages(paths: list[Path]) -> Iterator[RasterPage]:
    for path in paths:
        if path.suffix.lower() == ".pdf":
            doc = pymupdf.open(path)
            for i in range(doc.page_count):
                pix = doc.load_page(i).get_pixmap(dpi=DPI, colorspace=pymupdf.csGRAY)
                gray = (
                    np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width).copy()
                )
                yield RasterPage(str(path), i, gray)
        else:
            gray = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
            if gray is None:
                raise ValueError(f"cannot read image {path}")
            yield RasterPage(str(path), 0, gray)
