import io

import segno
from segno import DataOverflowError

from papersync.payload import Payload, PayloadError

# The printed footprint (L.QR_MM, 14mm) never changes -- growing the version
# only shrinks the modules inside that fixed square, so it needs no geometry
# change (chrome._draw_qr already derives its module pitch from len(matrix)).
# What *does* change with version is whether a 300 dpi scan can still decode
# it.
#
# The cap is 12 (65x65 modules, ~0.215 mm and ~2.5 px per module at 300 dpi).
# An earlier cap of 15 came from a harness that applied only an affine warp
# with linear interpolation: it measured resampling, not scanning. Re-measured
# with a 5x5 Gaussian blur, which is still gentler than a real flatbed,
# version 13 decoded 13 of 40 trials and version 15 decoded 0 of 40, while
# version 12 stayed clean. A realistically deep vault path needs only version
# 8, so the cap binds well above ordinary use.
QR_VERSION_CAP = 12


class QrCapacityError(ValueError):
    """A payload's ref does not fit in a QR code that still decodes reliably."""


def _ref_for(url: str) -> str:
    """Best-effort pretty ref for an error message; falls back to the raw url."""
    try:
        return Payload.parse(url).ref
    except PayloadError:
        return url


def _version(qr: segno.QRCode) -> int:
    """``mode="byte"`` never yields a Micro QR code, so version is always an int."""
    version = qr.version
    assert isinstance(version, int)
    return version


def _make(url: str) -> segno.QRCode:
    """Smallest QR version that holds ``url``, capped at ``QR_VERSION_CAP``.

    Tries error level M first, since it corrects more of a smudged scan. If
    the version M needs would exceed the cap, retries at L -- L packs more
    data per version, so it can still land under the cap when M alone
    would not. Only if L also needs more than the cap does this give up.
    """
    try:
        qr = segno.make(url, error="m", mode="byte", boost_error=False)
    except DataOverflowError:
        qr = None
    if qr is not None and _version(qr) <= QR_VERSION_CAP:
        return qr
    try:
        qr_l = segno.make(url, error="l", mode="byte", boost_error=False)
    except DataOverflowError as exc:
        if qr is None:
            raise QrCapacityError(
                f"ref {_ref_for(url)!r} is too long to encode as a QR code at all"
            ) from exc
        qr_l = None
    if qr_l is not None and _version(qr_l) <= QR_VERSION_CAP:
        return qr_l
    best = qr_l or qr
    assert best is not None
    raise QrCapacityError(
        f"ref {_ref_for(url)!r} is too long to encode in a QR code that still "
        f"decodes reliably at 300 dpi (needs version {_version(best)}, max is "
        f"{QR_VERSION_CAP})"
    )


def qr_svg(url: str) -> str:
    buf = io.BytesIO()
    _make(url).save(buf, kind="svg", border=0, scale=1)
    return buf.getvalue().decode()


def qr_matrix(url: str) -> list[list[int]]:
    """Module matrix with no quiet zone, for drawing modules as PDF rectangles."""
    return [list(row) for row in _make(url).matrix]
