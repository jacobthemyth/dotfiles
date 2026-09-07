import io

import segno
from segno import DataOverflowError

QR_VERSION = 5


def qr_svg(url: str) -> str:
    """Render a QR at fixed version 5 so the printed footprint never changes."""
    try:
        code = segno.make(url, version=QR_VERSION, error="m", mode="byte", boost_error=False)
    except DataOverflowError:
        code = segno.make(url, version=QR_VERSION, error="l", mode="byte", boost_error=False)
    buf = io.BytesIO()
    code.save(buf, kind="svg", border=0, scale=1)
    return buf.getvalue().decode()
