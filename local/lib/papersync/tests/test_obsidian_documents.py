import json
from datetime import date
from pathlib import Path

import pymupdf
import pytest

from papersync.integrations.obsidian import documents as D  # noqa: N812
from papersync.model import Item
from papersync.render import chrome
from papersync.render.templates.v1 import layout as L  # noqa: N812

SIZE = L.SIZES["letter"]
TODAY = date(2026, 9, 12)


def _item(ref: str = "Notes/Projects/Alpha", title: str = "Project Alpha") -> Item:
    return Item(
        source="obsidian",
        ref=ref,
        title=title,
        notes="# Alpha\n",
        meta={"title": title, "tags": ["a"], "papersync-printed": "2026-09-01"},
    )


def test_slug_lowercases_collapses_and_caps() -> None:
    assert D.slug("Project Alpha") == "project-alpha"
    assert D.slug("2026-09-12 Daily / Notes!") == "2026-09-12-daily-notes"
    assert D.slug("~~~") == "note"
    assert len(D.slug("x" * 200)) == 60


def test_frontmatter_pairs_keep_file_order_and_drop_skipped_keys() -> None:
    pairs = D.frontmatter_pairs(
        {"title": "A", "papersync-printed": "d", "tags": ["x"]}, ["papersync-printed"]
    )
    assert pairs == [["title", "A"], ["tags", ["x"]]]


def test_build_spec_reads_its_margins_from_the_layout(tmp_path: Path) -> None:
    spec = D.build_spec(_item(), tmp_path / "001.pdf", SIZE, ["papersync-printed"])
    assert spec["papersync_spec"] == 1
    assert spec["path"] == "Notes/Projects/Alpha.md"
    assert spec["out"] == str(tmp_path / "001.pdf")
    assert spec["page"] == {"width_mm": SIZE.width, "height_mm": SIZE.height}
    assert spec["margins_mm"] == {
        "top": L.TOP_MM,
        "right": L.MARGIN_MM,
        "bottom": L.BOTTOM_MM,
        "left": L.MARGIN_MM,
    }
    assert ["papersync-printed", "2026-09-01"] not in spec["frontmatter"]


def test_render_documents_stamps_chrome_onto_what_the_bridge_produced(tmp_path: Path) -> None:
    """The fake bridge writes a blank page. The real one writes Obsidian's HTML."""
    written: list[dict] = []

    def fake_render(cli, spec, spec_path):
        written.append(spec)
        Path(spec["out"]).write_bytes(chrome.blank(SIZE, 2))
        return 2

    docs = D.render_documents(
        cli=None,
        items=[_item()],
        size=SIZE,
        labels=["A", "B"],
        boxes_id=1,
        skip=["papersync-printed"],
        today=TODAY,
        workdir=tmp_path,
        renderer=fake_render,
    )
    assert len(docs) == 1 and docs[0].pages == 2
    assert written[0]["path"] == "Notes/Projects/Alpha.md"

    page = pymupdf.open("pdf", docs[0].pdf)[0]
    black = [d for d in page.get_drawings() if d.get("fill") == (0.0, 0.0, 0.0)]
    assert len(black) > 4  # four fiducials plus QR module runs


def test_render_documents_reports_a_clean_error_when_the_bridge_writes_no_file(
    tmp_path: Path,
) -> None:
    """The bridge said ok, but ``spec["out"]`` was never written."""

    def fake_render(cli, spec, spec_path):
        return 1  # no file written at spec["out"]

    with pytest.raises(D.DocumentRenderError, match="wrote no file"):
        D.render_documents(
            cli=None,
            items=[_item()],
            size=SIZE,
            labels=["A", "B"],
            boxes_id=1,
            skip=["papersync-printed"],
            today=TODAY,
            workdir=tmp_path,
            renderer=fake_render,
        )


def test_render_documents_reports_a_clean_error_for_a_truncated_pdf(tmp_path: Path) -> None:
    """The bridge said ok and wrote a file, but it is not a valid PDF."""

    def fake_render(cli, spec, spec_path):
        Path(spec["out"]).write_bytes(b"not actually a pdf")
        return 1

    with pytest.raises(D.DocumentRenderError, match="not a readable PDF"):
        D.render_documents(
            cli=None,
            items=[_item()],
            size=SIZE,
            labels=["A", "B"],
            boxes_id=1,
            skip=["papersync-printed"],
            today=TODAY,
            workdir=tmp_path,
            renderer=fake_render,
        )


def test_write_documents_creates_one_pdf_per_note_and_a_manifest(tmp_path: Path) -> None:
    docs = [
        D.RenderedDocument(_item("Notes/Alpha", "Alpha"), chrome.blank(SIZE, 2), 2, "letter"),
        D.RenderedDocument(_item("Notes/Beta", "Beta"), chrome.blank(SIZE, 1), 1, "letter"),
    ]
    out_dir, paths = D.write_documents(docs, tmp_path, "20260912-101500", "Notes")

    assert out_dir == tmp_path / "papersync-20260912-101500"
    assert [p.name for p in paths] == ["001-alpha.pdf", "002-beta.pdf"]
    manifest = json.loads((out_dir / "manifest.json").read_text())
    assert manifest["papersync_manifest"] == 1
    assert manifest["vault"] == "Notes"
    assert manifest["source"] == "obsidian"
    assert [d["ref"] for d in manifest["documents"]] == ["Notes/Alpha", "Notes/Beta"]
    assert manifest["documents"][0]["pages"] == 2
    assert manifest["documents"][0]["file"] == "001-alpha.pdf"


def test_two_notes_with_the_same_slug_stay_apart(tmp_path: Path) -> None:
    docs = [
        D.RenderedDocument(_item("A/Alpha", "Alpha"), chrome.blank(SIZE, 1), 1, "letter"),
        D.RenderedDocument(_item("B/Alpha", "Alpha"), chrome.blank(SIZE, 1), 1, "letter"),
    ]
    _, paths = D.write_documents(docs, tmp_path, "stamp", "Notes")
    assert [p.name for p in paths] == ["001-alpha.pdf", "002-alpha.pdf"]
