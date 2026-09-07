from pathlib import Path

import cv2
import numpy as np
import pymupdf

from papersync.recognize.assemble import PageOverlay
from papersync.recognize.geometry import mm_to_px
from papersync.render.templates.v1 import layout as L  # noqa: N812

GREEN, RED, AMBER, BLUE = (0, 170, 0), (0, 0, 220), (0, 160, 255), (220, 120, 0)


def _outline(
    img: np.ndarray, h: np.ndarray, rect: L.Rect, color: tuple[int, int, int], width: int
) -> np.ndarray:
    pts = np.array([mm_to_px(h, x, y) for x, y in rect.corners()], dtype=np.int32)
    cv2.polylines(img, [pts], True, color, width)
    return pts


def _draw(overlay: PageOverlay) -> np.ndarray:
    img = cv2.cvtColor(overlay.page.gray, cv2.COLOR_GRAY2BGR)
    if overlay.h is not None and overlay.size is not None:
        for rect in [*L.fiducials(overlay.size), L.qr_rect(overlay.size)]:
            _outline(img, overlay.h, rect, BLUE, 2)
        for rect, res in overlay.boxes:
            color = AMBER if res.uncertain else GREEN if res.checked else RED
            pts = _outline(img, overlay.h, rect, color, 3)
            cv2.putText(
                img,
                f"{res.fill:.2f}",
                (int(pts[1][0]) + 6, int(pts[1][1]) + 30),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.9,
                color,
                2,
            )
    cv2.putText(img, overlay.note, (40, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.4, BLUE, 3)
    return img


def write_review(overlays: list[PageOverlay], path: Path) -> None:
    doc = pymupdf.open()
    for overlay in overlays:
        ok, png = cv2.imencode(".png", _draw(overlay))
        if not ok:
            raise RuntimeError("could not encode review page")
        img = pymupdf.open("png", png.tobytes())
        rect = img[0].rect
        page = doc.new_page(width=rect.width, height=rect.height)
        page.insert_image(rect, stream=png.tobytes())
    doc.save(path)
