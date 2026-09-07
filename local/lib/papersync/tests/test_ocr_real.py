"""Opt-in test against the real Apple Vision OCR backend.

``tests/fixtures/handwriting.png`` is not a scan of real handwriting — no
scanner was available when this test was written. It is synthetic script
text, "some handwriting" rendered with ``cv2.putText`` in
``cv2.FONT_HERSHEY_SCRIPT_SIMPLEX`` at roughly 300 dpi scale, which Apple
Vision reads as handwriting-style text.

Skipped unless ``PAPERSYNC_REAL_OCR=1`` is set, since it calls the real
on-device Vision framework and only runs on macOS.
"""

import os
from pathlib import Path

import cv2
import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("PAPERSYNC_REAL_OCR") != "1", reason="set PAPERSYNC_REAL_OCR=1"
)


def test_ocrmac_reads_handwriting() -> None:
    from papersync.recognize.ocr import OcrmacBackend, join_text

    path = Path(__file__).parent / "fixtures" / "handwriting.png"
    gray = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise ValueError(f"cannot read image {path}")
    text = join_text(OcrmacBackend().recognize(gray)).lower()
    assert "handwriting" in text


def test_ocrmac_bounding_box_is_the_ink() -> None:
    """ocrmac returns (x1, y1, x2, y2) corners, not (x, y, w, h)."""
    import numpy as np

    from papersync.recognize.ocr import OcrmacBackend

    path = Path(__file__).parent / "fixtures" / "handwriting.png"
    gray = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise ValueError(f"cannot read image {path}")
    height, width = gray.shape
    ink = np.argwhere(gray < 128)
    (y0, x0), (y1, x1) = ink.min(axis=0), ink.max(axis=0)
    lines = OcrmacBackend().recognize(gray)
    assert lines
    line = lines[0]
    cx, cy = line.x + line.w / 2, line.y + line.h / 2
    assert x0 <= cx <= x1, f"center x {cx} outside ink [{x0}, {x1}]"
    assert y0 <= cy <= y1, f"center y {cy} outside ink [{y0}, {y1}]"
    assert line.w < width, f"width {line.w} >= image width {width}"
    assert line.h < height / 2, f"height {line.h} >= half image height {height / 2}"
