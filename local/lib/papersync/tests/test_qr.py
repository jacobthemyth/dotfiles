from papersync.render.qr import qr_svg


def test_svg_has_no_border_and_fixed_version() -> None:
    svg = qr_svg("papersync:///v1/things/ABC?size=3x5&boxes=1")
    assert svg.startswith("<?xml") or svg.startswith("<svg")
    assert 'width="37"' in svg  # version 5 = 37 modules, scale 1, border 0


def test_long_payload_falls_back_to_level_l() -> None:
    url = "papersync:///v1/things/" + "A" * 22 + "?size=letter&boxes=100&page=100&pages=100"
    assert 'width="37"' in qr_svg(url)


def test_qr_matrix_is_square_version_5_with_no_border() -> None:
    from papersync.render.qr import qr_matrix

    m = qr_matrix("papersync:///v1/obsidian/Notes%2FAlpha?size=letter&boxes=1")
    assert len(m) == 37
    assert all(len(row) == 37 for row in m)
    assert set(v for row in m for v in row) == {0, 1}
    # A finder pattern occupies the top-left 7x7 block, so its corner is dark.
    assert m[0][0] == 1


def test_qr_matrix_falls_back_to_low_error_for_long_refs() -> None:
    from papersync.render.qr import qr_matrix

    long_ref = "A" * 40
    m = qr_matrix(f"papersync:///v1/obsidian/{long_ref}?size=letter&boxes=1&page=1&pages=9")
    assert len(m) == 37
