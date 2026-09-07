from dataclasses import dataclass

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
