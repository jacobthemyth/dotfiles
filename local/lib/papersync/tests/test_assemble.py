from datetime import date
from pathlib import Path

import numpy as np

from papersync.boxsets import BoxSetRegistry
from papersync.model import Item
from papersync.recognize.assemble import recognize_pages
from papersync.recognize.ocr import OcrLine
from papersync.recognize.raster import RasterPage
from papersync.render import engine
from papersync.render.templates.v1 import layout as L  # noqa: N812
from tests import synthetic

SIZE = L.SIZES["3x5"]
TODAY = date(2026, 9, 7)


class FakeOcr:
    def recognize(self, gray: np.ndarray) -> list[OcrLine]:
        if gray.shape == (1000, 1500):  # synthetic.handwriting_page
            return [OcrLine("some handwriting", 0.9, 200, 350, 800, 60)]
        # a "new" card: one title line and one notes line inside the notes region
        h = synthetic.identity_h()
        from papersync.recognize.geometry import mm_to_px

        tx, ty = mm_to_px(h, L.title_bar(SIZE).x + 2, L.title_bar(SIZE).y + 1)
        nx, ny = mm_to_px(h, L.notes_region(SIZE).x + 2, L.notes_region(SIZE).y + 2)
        return [
            OcrLine("Call mom", 0.9, tx, ty, 300, 40),
            OcrLine("about sunday", 0.9, nx, ny, 300, 40),
        ]


def _registry(tmp_path: Path) -> BoxSetRegistry:
    reg = BoxSetRegistry(tmp_path / "boxsets.toml")
    reg.id_for(["A", "B"])
    return reg


def _card(ref: str, title: str, notes: str, marked: list[L.Rect]) -> np.ndarray:
    opts = engine.RenderOptions(labels=["A", "B"], boxes_id=1)
    pdf = engine.render_item(
        Item(source="things", ref=ref, title=title, notes=notes), "3x5", opts, TODAY
    ).pdf
    gray = synthetic.rasterize(pdf)
    for r in marked:
        synthetic.draw_x(gray, r)
    return synthetic.distort(gray)


def _lookup(refs: list[str]) -> dict[str, Item]:
    known = {
        "F" * 22: Item(source="things", ref="F" * 22, title="FOO"),
        "B" * 22: Item(source="things", ref="B" * 22, title="BAR", notes="BAZ"),
    }
    return {r: known[r] for r in refs if r in known}


def test_spec_example(tmp_path: Path) -> None:
    pages = [
        RasterPage(
            "scan.pdf", 0, _card("F" * 22, "FOO", "", [L.done_box(SIZE), L.meta_box(SIZE, 1)])
        ),
        RasterPage("scan.pdf", 1, _card("B" * 22, "BAR", "BAZ", [L.meta_box(SIZE, 0)])),
        RasterPage("scan.pdf", 2, synthetic.handwriting_page()),
    ]
    rec = recognize_pages(pages, FakeOcr(), _registry(tmp_path), _lookup, TODAY, ["scan.pdf"])
    plan = rec.plan
    assert plan.errors == []
    foo, bar = plan.changes
    assert foo.ref == "F" * 22 and foo.complete and foo.marks == ["B"] and foo.append_notes is None
    assert bar.ref == "B" * 22 and not bar.complete and bar.marks == ["A"]
    assert bar.append_notes == "\n\n## Scanned 2026-09-07\n\n> some handwriting"
    assert bar.pages == [2] and foo.title == "FOO"
    assert set(foo.boxes) == {"done", "A", "B"}
    assert len(rec.overlays) == 3


def test_handwriting_before_any_card_is_an_error(tmp_path: Path) -> None:
    pages = [RasterPage("scan.pdf", 0, synthetic.handwriting_page())]
    plan = recognize_pages(pages, FakeOcr(), _registry(tmp_path), _lookup, TODAY, ["scan.pdf"]).plan
    assert plan.changes == [] and plan.errors[0].page == 1 and "no card" in plan.errors[0].message


def test_unknown_box_set_is_an_error(tmp_path: Path) -> None:
    reg = BoxSetRegistry(tmp_path / "boxsets.toml")  # empty: set 1 unknown
    pages = [RasterPage("scan.pdf", 0, _card("F" * 22, "FOO", "", []))]
    plan = recognize_pages(pages, FakeOcr(), reg, _lookup, TODAY, ["scan.pdf"]).plan
    assert plan.changes == [] and "box set 1" in plan.errors[0].message


def test_new_card_becomes_create(tmp_path: Path) -> None:
    opts = engine.RenderOptions(labels=["A", "B"], boxes_id=1)
    gray = synthetic.rasterize(engine.render_new(1, "3x5", opts, TODAY)[0].pdf)
    synthetic.draw_x(gray, L.meta_box(SIZE, 0))
    pages = [
        RasterPage("scan.pdf", 0, gray),
        RasterPage("scan.pdf", 1, synthetic.handwriting_page()),
    ]
    plan = recognize_pages(pages, FakeOcr(), _registry(tmp_path), _lookup, TODAY, ["scan.pdf"]).plan
    assert plan.errors == []
    (new,) = plan.changes
    assert new.kind == "create" and new.title == "Call mom" and new.marks == ["A"]
    assert new.notes == "about sunday\n\nsome handwriting"


def test_continuation_without_first_page_is_an_error(tmp_path: Path) -> None:
    opts = engine.RenderOptions(labels=["A"], boxes_id=1, overflow="paginate")
    item = Item(source="things", ref="L" * 22, title="Long", notes="\n".join(["x"] * 60))
    pdf = engine.render_item(item, "3x5", opts, TODAY).pdf
    page2 = synthetic.rasterize(pdf, page=1)
    plan = recognize_pages(
        [RasterPage("s.pdf", 0, page2)], FakeOcr(), _registry(tmp_path), _lookup, TODAY, ["s.pdf"]
    ).plan
    assert plan.changes == [] and "continuation" in plan.errors[0].message


def test_write_review(tmp_path: Path) -> None:
    import pymupdf

    from papersync.recognize.review import write_review

    pages = [RasterPage("scan.pdf", 0, _card("F" * 22, "FOO", "", [L.done_box(SIZE)]))]
    rec = recognize_pages(pages, FakeOcr(), _registry(tmp_path), _lookup, TODAY, ["scan.pdf"])
    out = tmp_path / "review.pdf"
    write_review(rec.overlays, out)
    assert pymupdf.open(out).page_count == 1
