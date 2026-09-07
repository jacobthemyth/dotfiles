import cv2
import numpy as np

from papersync.recognize.qr import DecodedQr
from papersync.render.templates.v1 import layout as L  # noqa: N812


def mm_to_px(h: np.ndarray, x: float, y: float) -> tuple[float, float]:
    v = h @ np.array([x, y, 1.0])
    return float(v[0] / v[2]), float(v[1] / v[2])


def homography_from_qr(decoded: DecodedQr, size: L.PageSize) -> np.ndarray:
    """Seed transform from the QR alone.

    A full perspective transform fitted to the QR's 14 mm square is unusable away
    from the symbol: the decoder reports corners on a whole-pixel grid, and those
    rounding errors turn into perspective terms that drift by tens of pixels at the
    far edge of the card. A similarity (rotation, uniform scale, translation)
    extrapolates cleanly, which is all the seed has to do -- it only has to put the
    fiducial search windows on target, and ``refine_with_fiducials`` fits the real
    homography afterwards.

    The fit is the closed-form Umeyama similarity, so the same corners always give
    the same matrix; a randomized estimator would jitter the search windows.
    """
    src = np.array(L.qr_rect(size).corners(), dtype=np.float64)
    dst = np.asarray(decoded.corners, dtype=np.float64)
    src_mean, dst_mean = src.mean(axis=0), dst.mean(axis=0)
    src_c, dst_c = src - src_mean, dst - dst_mean
    u, sigma, vt = np.linalg.svd(dst_c.T @ src_c / len(src))
    d = np.diag([1.0, float(np.sign(np.linalg.det(u @ vt)))])
    rotation = u @ d @ vt
    scale = float((sigma * np.diag(d)).sum() / (src_c**2).sum() * len(src))
    h = np.eye(3, dtype=np.float64)
    h[:2, :2] = scale * rotation
    h[:2, 2] = dst_mean - h[:2, :2] @ src_mean
    return h


def _find_square(gray: np.ndarray, h0: np.ndarray, rect: L.Rect) -> tuple[float, float] | None:
    cx, cy = mm_to_px(h0, *rect.center)
    px_per_mm = float(np.hypot(h0[0, 0], h0[1, 0]))
    radius = int(4.0 * px_per_mm)
    x0, y0 = max(int(cx) - radius, 0), max(int(cy) - radius, 0)
    window = gray[y0 : int(cy) + radius, x0 : int(cx) + radius]
    if window.size == 0:
        return None
    _, binary = cv2.threshold(window, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    expected = (L.FIDUCIAL_MM * px_per_mm) ** 2
    best: tuple[float, float, float] | None = None
    for c in contours:
        area = cv2.contourArea(c)
        if 0.5 * expected <= area <= 1.6 * expected:
            m = cv2.moments(c)
            if m["m00"] == 0:
                continue
            score = abs(area - expected)
            if best is None or score < best[0]:
                best = (score, x0 + m["m10"] / m["m00"], y0 + m["m01"] / m["m00"])
    return None if best is None else (best[1], best[2])


def refine_with_fiducials(
    gray: np.ndarray,
    h0: np.ndarray,
    size: L.PageSize,
    qr_corners: np.ndarray | None = None,
) -> np.ndarray | None:
    """Fit the real mm->px homography from the four fiducial centers.

    ``qr_corners`` are the measured symbol corners from the decoder (4x2, TL TR BR
    BL). When given they join the fit as four more correspondences. Never
    substitute points projected through ``h0``: those carry no information the seed
    does not already have and would only pull the fit back toward it.
    """
    rects = L.fiducials(size)
    found = [_find_square(gray, h0, r) for r in rects]
    if any(d is None for d in found):
        return None
    src = [r.center for r in rects]
    dst = [d for d in found if d is not None]
    if qr_corners is not None:
        src += L.qr_rect(size).corners()
        dst += [(float(x), float(y)) for x, y in np.asarray(qr_corners, dtype=np.float64)]
    h, _ = cv2.findHomography(np.array(src, dtype=np.float32), np.array(dst, dtype=np.float32), 0)
    return None if h is None else h.astype(np.float64)
