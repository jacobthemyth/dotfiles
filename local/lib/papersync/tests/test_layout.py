from papersync.render.templates.v1 import layout as L  # noqa: N812


def test_sizes() -> None:
    assert L.SIZES["3x5"].width == 127.0 and L.SIZES["3x5"].height == 76.2
    assert L.SIZE_ORDER == ["3x5", "4x6", "letter"]


def test_fiducials_are_inset_squares() -> None:
    size = L.SIZES["3x5"]
    tl, tr, bl, br = L.fiducials(size)
    assert (tl.x, tl.y, tl.w, tl.h) == (4.0, 4.0, 5.0, 5.0)
    assert br.center == (127.0 - 6.5, 76.2 - 6.5)
    assert tr.x == 127.0 - 9.0 and bl.y == 76.2 - 9.0


def test_qr_is_inside_bottom_right_frame() -> None:
    size = L.SIZES["3x5"]
    q = L.qr_rect(size)
    br = L.fiducials(size)[3]
    assert q.x + q.w < br.x and q.y + q.h < br.y


def test_meta_boxes_never_reach_qr() -> None:
    for size in L.SIZES.values():
        last = L.meta_box(size, L.max_boxes(size) - 1)
        assert last.x + last.w + 2.0 < L.qr_rect(size).x
    assert L.max_boxes(L.SIZES["3x5"]) == 6


def test_geometry_json_is_plain_numbers() -> None:
    g = L.geometry(L.SIZES["3x5"], ["A", "B"])
    assert g["width"] == 127.0 and len(g["meta_boxes"]) == 2  # ty: ignore[invalid-argument-type]
    assert all(isinstance(v, int | float | str | list | dict) for v in g.values())


def test_rect_inset_and_corners() -> None:
    r = L.Rect(10, 20, 4, 4).inset(1)
    assert (r.x, r.y, r.w, r.h) == (11, 21, 2, 2)
    assert r.corners() == [(11, 21), (13, 21), (13, 23), (11, 23)]


def test_title_bar_spans_to_right_margin_and_date_strip_sits_in_right_margin() -> None:
    for size in L.SIZES.values():
        tb = L.title_bar(size)
        assert tb.x + tb.w == size.width - L.MARGIN_MM
        f = L.footer_rect(size)
        fid_tr = L.fiducials(size)[1]
        assert f.x >= size.width - L.MARGIN_MM  # right of the text margin
        assert f.x + f.w <= fid_tr.x  # left of the corner-square column
        assert f.y >= fid_tr.y + fid_tr.h + 1.0  # below the top-right square
        assert f.y + f.h <= L.qr_rect(size).y - 1.0  # above the QR
        assert f.h >= 20.0  # room for "2026-09-07 · 12/12" at 6pt
