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
