from datetime import date
from pathlib import Path

import pymupdf
import pytest

from papersync.model import Item
from papersync.render import engine
from papersync.render.templates.v1 import layout as L  # noqa: N812

OPTS = engine.RenderOptions(labels=["A", "B"], boxes_id=1)
TODAY = date(2026, 9, 7)


def _item(notes: str) -> Item:
    return Item(source="things", ref="A" * 22, title="Buy *milk* #eggs", notes=notes)


def test_short_item_fits_3x5() -> None:
    r = engine.render_auto(_item("one line"), OPTS, TODAY)
    assert r.size == "3x5" and r.pages == 1
    doc = pymupdf.open("pdf", r.pdf)
    assert doc.page_count == 1
    assert abs(doc[0].rect.width - 127 / 25.4 * 72) < 1


def test_long_item_goes_to_letter_and_paginates() -> None:
    r = engine.render_auto(_item("\n".join(f"line {i}" for i in range(400))), OPTS, TODAY)
    assert r.size == "letter" and r.pages > 1


def test_forced_size_fail() -> None:
    with pytest.raises(engine.RenderOverflow):
        engine.render_item(_item("\n".join(["x"] * 50)), "3x5", OPTS, TODAY)


def test_forced_size_paginate() -> None:
    opts = engine.RenderOptions(labels=["A"], boxes_id=1, overflow="paginate")
    r = engine.render_item(_item("\n".join(["x"] * 50)), "3x5", opts, TODAY)
    assert r.pages >= 2
    text = "".join(p.get_text() for p in pymupdf.open("pdf", r.pdf))
    assert "(cont.)" in text and f"2/{r.pages}" in text


def test_forced_size_truncate() -> None:
    opts = engine.RenderOptions(labels=["A"], boxes_id=1, overflow="truncate")
    r = engine.render_item(_item("\n".join(["x"] * 50)), "3x5", opts, TODAY)
    assert r.pages == 1 and r.truncated
    assert "[…]" in pymupdf.open("pdf", r.pdf)[0].get_text()


def test_too_many_labels_raises() -> None:
    opts = engine.RenderOptions(labels=[str(i) for i in range(10)], boxes_id=1)
    with pytest.raises(engine.RenderOverflow):
        engine.render_item(_item(""), "3x5", opts, TODAY)


def test_auto_moves_up_when_labels_do_not_fit() -> None:
    opts = engine.RenderOptions(labels=[str(i) for i in range(7)], boxes_id=1)
    assert engine.render_auto(_item("x"), opts, TODAY).size == "4x6"


def test_new_cards() -> None:
    cards = engine.render_new(2, "3x5", OPTS, TODAY)
    assert len(cards) == 2 and all(c.item is None and c.pages == 1 for c in cards)


def test_write_outputs_groups_by_size(tmp_path: Path) -> None:
    a = engine.render_auto(_item("a"), OPTS, TODAY)
    b = engine.render_auto(_item("b"), OPTS, TODAY)
    c = engine.render_auto(_item("\n".join(["x"] * 400)), OPTS, TODAY)
    paths = engine.write_outputs([a, b, c], tmp_path, "20260907-100000")
    names = sorted(p.name for p in paths)
    assert names == ["papersync-20260907-100000-3x5.pdf", "papersync-20260907-100000-letter.pdf"]
    assert pymupdf.open(tmp_path / names[0]).page_count == 2


def test_max_boxes_matches_layout() -> None:
    assert L.max_boxes(L.SIZES["3x5"]) == 6
