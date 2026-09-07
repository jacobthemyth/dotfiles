import cv2
import numpy as np

from papersync.model import BoxResult
from papersync.recognize.geometry import mm_to_px
from papersync.render.templates.v1 import layout as L  # noqa: N812

PATCH = 40


def box_fill(gray: np.ndarray, h: np.ndarray, rect: L.Rect) -> float:
    inner = rect.inset(L.BOX_INSET_MM)
    src = np.array([mm_to_px(h, x, y) for x, y in inner.corners()], dtype=np.float32)
    dst = np.array([[0, 0], [PATCH, 0], [PATCH, PATCH], [0, PATCH]], dtype=np.float32)
    patch = cv2.warpPerspective(
        gray, cv2.getPerspectiveTransform(src, dst), (PATCH, PATCH), borderValue=255
    )
    return float((patch < 128).mean())


def classify(fill: float) -> BoxResult:
    if fill < L.FILL_LOW:
        return BoxResult(fill=fill, checked=False, uncertain=False)
    if fill > L.FILL_HIGH:
        return BoxResult(fill=fill, checked=True, uncertain=False)
    return BoxResult(fill=fill, checked=False, uncertain=True)
