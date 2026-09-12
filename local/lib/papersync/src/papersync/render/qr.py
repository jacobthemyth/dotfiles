import io

import segno
from segno import DataOverflowError

QR_VERSION = 5


def _make(url: str) -> segno.QRCode:
    """Fixed version 5 so the printed footprint never changes."""
    try:
        return segno.make(url, version=QR_VERSION, error="m", mode="byte", boost_error=False)
    except DataOverflowError:
        return segno.make(url, version=QR_VERSION, error="l", mode="byte", boost_error=False)


def qr_svg(url: str) -> str:
    buf = io.BytesIO()
    _make(url).save(buf, kind="svg", border=0, scale=1)
    return buf.getvalue().decode()


def qr_matrix(url: str) -> list[list[int]]:
    """Module matrix with no quiet zone, for drawing modules as PDF rectangles."""
    return [list(row) for row in _make(url).matrix]
