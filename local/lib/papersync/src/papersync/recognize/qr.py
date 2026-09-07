from dataclasses import dataclass

import cv2
import numpy as np
import zxingcpp

from papersync.payload import SCHEME, Payload, PayloadError

QR_ONLY = zxingcpp.BarcodeFormats(zxingcpp.BarcodeFormat.QRCode)


@dataclass
class DecodedQr:
    payload: Payload
    corners: np.ndarray  # (4, 2) float32, TL TR BR BL in the symbol's own orientation


class ForeignPayload(Exception):  # noqa: N818
    """A papersync-looking QR that does not parse. Carries the parse error."""


def find_payload(gray: np.ndarray) -> DecodedQr | None:
    for result in zxingcpp.read_barcodes(gray, formats=QR_ONLY):
        if not result.text.startswith(SCHEME):
            continue
        try:
            payload = Payload.parse(result.text)
        except PayloadError as exc:
            raise ForeignPayload(str(exc)) from exc
        p = result.position
        corners = np.array(
            [
                [p.top_left.x, p.top_left.y],
                [p.top_right.x, p.top_right.y],
                [p.bottom_right.x, p.bottom_right.y],
                [p.bottom_left.x, p.bottom_left.y],
            ],
            dtype=np.float32,
        )
        return DecodedQr(payload, corners)
    return None


# Blur kernels tried, in order, when the raw raster does not decode. Real 1-bit
# scanner output erodes QR modules into ragged fragments and dithers solid
# squares into speckle; a light Gaussian blur reconstitutes both. Larger
# kernels start to merge modules, so the ladder stops at 5x5.
BLUR_LADDER: tuple[int, ...] = (3, 5)


def decode_with_fallback(gray: np.ndarray) -> tuple[DecodedQr | None, np.ndarray]:
    """Find a papersync QR on the raw raster, then on lightly blurred copies.

    Returns the decode result together with the image it succeeded on, so the
    caller can run fiducial detection and box scoring on the same pixels.
    """
    decoded = find_payload(gray)
    if decoded is not None:
        return decoded, gray
    for k in BLUR_LADDER:
        blurred = cv2.GaussianBlur(gray, (k, k), 0)
        decoded = find_payload(blurred)
        if decoded is not None:
            return decoded, blurred
    return None, gray
