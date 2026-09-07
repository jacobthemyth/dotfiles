from papersync.render.qr import qr_svg


def test_svg_has_no_border_and_fixed_version() -> None:
    svg = qr_svg("papersync:///v1/things/ABC?size=3x5&boxes=1")
    assert svg.startswith("<?xml") or svg.startswith("<svg")
    assert 'width="37"' in svg  # version 5 = 37 modules, scale 1, border 0


def test_long_payload_falls_back_to_level_l() -> None:
    url = "papersync:///v1/things/" + "A" * 22 + "?size=letter&boxes=100&page=100&pages=100"
    assert 'width="37"' in qr_svg(url)
