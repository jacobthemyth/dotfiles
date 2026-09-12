import pytest

from papersync.render.qr import QR_VERSION_CAP, QrCapacityError, qr_matrix, qr_svg


def test_svg_has_no_border_and_smallest_version() -> None:
    svg = qr_svg("papersync:///v1/things/ABC?size=3x5&boxes=1")
    assert svg.startswith("<?xml") or svg.startswith("<svg")
    assert 'width="33"' in svg  # short payload -> version 4 = 33 modules


def test_longer_payload_grows_the_version() -> None:
    short = qr_svg("papersync:///v1/things/ABC?size=3x5&boxes=1")
    url = "papersync:///v1/things/" + "A" * 22 + "?size=letter&boxes=100&page=100&pages=100"
    long = qr_svg(url)
    assert short != long
    assert 'width="41"' in long


def test_qr_matrix_is_square_with_no_border() -> None:
    m = qr_matrix("papersync:///v1/obsidian/Notes%2FAlpha?size=letter&boxes=1")
    assert len(m) == len(m[0]) == 33
    assert all(len(row) == len(m) for row in m)
    assert set(v for row in m for v in row) == {0, 1}
    # A finder pattern occupies the top-left 7x7 block, so its corner is dark.
    assert m[0][0] == 1


def test_qr_matrix_grows_the_version_for_a_longer_ref() -> None:
    long_ref = "A" * 40
    m = qr_matrix(f"papersync:///v1/obsidian/{long_ref}?size=letter&boxes=1&page=1&pages=9")
    assert len(m) == 41  # version 6 at error M, well under the cap


def test_ref_needing_a_version_over_the_cap_at_m_falls_back_to_l_and_stays_under() -> None:
    """A ref long enough that error M would exceed the cap must still fit via L."""
    ref = "x" * 240
    url = f"papersync:///v1/obsidian/{ref}?size=letter&boxes=1&page=10&pages=12"
    m = qr_matrix(url)
    modules = len(m)
    version = (modules - 17) // 4
    assert version <= QR_VERSION_CAP


def test_ref_too_long_for_any_version_under_the_cap_raises_clear_error() -> None:
    ref = "x" * 1000
    url = f"papersync:///v1/obsidian/{ref}?size=letter&boxes=1&page=10&pages=12"
    with pytest.raises(QrCapacityError, match="too long"):
        qr_matrix(url)


def test_capacity_error_names_the_ref() -> None:
    ref = "x" * 1000
    url = f"papersync:///v1/obsidian/{ref}?size=letter&boxes=1&page=10&pages=12"
    with pytest.raises(QrCapacityError, match="x" * 1000):
        qr_matrix(url)
