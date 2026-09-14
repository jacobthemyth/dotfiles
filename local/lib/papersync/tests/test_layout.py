from papersync.render.templates.v1 import layout as L  # noqa: N812


def test_sizes() -> None:
    assert L.SIZES["3x5"].width == 127.0 and L.SIZES["3x5"].height == 76.2
    assert L.SIZE_ORDER == ["3x5", "4x6", "letter"]


def test_fiducials_are_inset_squares() -> None:
    size = L.SIZES["3x5"]
    tl, tr, bl, br = L.fiducials(size)
    assert (tl.x, tl.y, tl.w, tl.h) == (6.0, 6.0, 5.0, 5.0)
    assert br.center == (127.0 - 8.5, 76.2 - 8.5)
    assert tr.x == 127.0 - 11.0 and bl.y == 76.2 - 11.0


def test_v1_geometry_is_kept_for_scanning_old_cards() -> None:
    size = L.SIZES["3x5"]
    tl = L.fiducials(size, 1)[0]
    assert (tl.x, tl.y) == (4.0, 4.0)
    q = L.qr_rect(size, 1)
    assert (q.x + q.w, q.y + q.h) == (127.0 - 11.0, 76.2 - 11.0)
    assert L.notes_region(size, 1).h == 76.2 - L.TOP_MM - 27.0


# A Brother HL-L8360CDW cannot print within 0.16 in (4.23 mm) of any edge.
PRINTER_DEAD_ZONE_MM = 4.23


def test_every_mark_clears_the_printer_dead_zone() -> None:
    for size in L.SIZES.values():
        marks = [
            *L.fiducials(size),
            L.qr_rect(size),
            L.title_bar(size),
            L.footer_rect(size),
            *(L.label_band(size, i) for i in range(L.max_boxes(size))),
        ]
        for r in marks:
            assert r.x >= PRINTER_DEAD_ZONE_MM and r.y >= PRINTER_DEAD_ZONE_MM, (size.name, r)
            assert size.width - (r.x + r.w) >= PRINTER_DEAD_ZONE_MM, (size.name, r)
            assert size.height - (r.y + r.h) >= PRINTER_DEAD_ZONE_MM, (size.name, r)


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
        assert (
            f.x + f.w <= size.width - L.FIDUCIAL_INSET_MM
        )  # inside the corner squares' outer edge
        assert f.y >= fid_tr.y + fid_tr.h + 1.0  # below the top-right square
        assert f.y + f.h <= L.qr_rect(size).y - 1.0  # above the QR
        assert f.h >= 20.0  # room for "2026-09-07 · 12/12" at 6pt


def test_geometry_reports_a_primary_box_by_default() -> None:
    g = L.geometry(L.SIZES["3x5"], ["A"])
    assert g["primary_box"] is True


def test_geometry_can_drop_the_primary_box() -> None:
    g = L.geometry(L.SIZES["letter"], ["A"], primary_box=False)
    assert g["primary_box"] is False
    # The done box rectangle still exists; only the flag says whether to draw it.
    assert L.done_box(L.SIZES["letter"]).w == L.BOX_MM


def _intersects(a: L.Rect, b: L.Rect) -> bool:
    return not (a.x + a.w <= b.x or b.x + b.w <= a.x or a.y + a.h <= b.y or b.y + b.h <= a.y)


def test_chrome_never_intersects_the_notes_region() -> None:
    """The single-source-of-truth invariant page.css depends on: ``layout.py``

    is the only place the page box is drawn from, so nothing it hands out as
    chrome may ever overlap the region it hands out for notes. Measured
    clearances are small (the title bar ends 11-17mm against a TOP_MM of 22,
    the QR top sits 2mm above a body bottom of 252.4 on letter, the footer
    sits 0.5mm inside the right margin), so this is checked directly rather
    than trusted by inspection.
    """
    for size in L.SIZES.values():
        notes = L.notes_region(size)
        chrome_rects = [
            L.title_bar(size),
            L.footer_rect(size),
            L.qr_rect(size),
            *(L.meta_box(size, i) for i in range(L.max_boxes(size))),
            *(L.label_band(size, i) for i in range(L.max_boxes(size))),
        ]
        for r in chrome_rects:
            assert not _intersects(r, notes), f"{size.name}: {r} intersects notes region {notes}"
