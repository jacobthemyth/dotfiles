# papersync Obsidian Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Print Obsidian notes as one PDF per note, rendered by Obsidian itself, with machine-readable chrome stamped on afterwards by pymupdf.

**Architecture:** A companion Obsidian plugin renders each note's body with `MarkdownRenderer` and prints it through a hidden Electron window. papersync then draws the fiducials, QR code, title bar, footer and meta boxes onto the finished PDF in PDF user space, so mark geometry never depends on Chromium scaling. The Things card path keeps using Typst and does not change.

**Tech Stack:** Python 3.12, click, pydantic, pymupdf, segno, uv. The bridge plugin is plain CommonJS with no build step.

**Spec:** `docs/superpowers/specs/2026-09-12-papersync-obsidian-design.md`

## Global Constraints

- Work inside `local/lib/papersync/`. Run every command with `uv run --project local/lib/papersync` or from that directory.
- Add **no new Python dependencies**. Obsidian renders the markdown and `obsidian properties` returns front matter already parsed as JSON.
- The bridge plugin is plain CommonJS. Do not add npm, a bundler, or a build step to this repository.
- Ruff config is fixed: line length 100, target py312, rules `E,F,I,B,UP,N,SIM,RUF`. Run `uv run ruff check` and `uv run ruff format` before every commit.
- Every module that imports the geometry does so as `from papersync.render.templates.v1 import layout as L  # noqa: N812`. Keep that exact form.
- Never restate a millimeter constant. Read it from `layout.py`.
- The `obsidian` CLI **always exits 0**. It reports failure by printing `Error: ...` on stdout. Never rely on the exit code.
- `obsidian eval` prefixes a successful result with `=> `. Strip that prefix.
- Do not change the Things renderer, the homography, the fiducial refinement, or the box scoring maths.
- Tests in the default suite must never call the `obsidian` binary or need Obsidian running.
- Full check command: `./script/test` from the repository root.

---

### Task 1: Percent-encode the ref in the QR payload

An Obsidian ref is a vault-relative path such as `Notes/Projects/Alpha`. It contains slashes, and `Payload.parse` splits the URL path into exactly three segments. Quoting the ref fixes this. Things UUIDs contain no characters that quoting changes, so old cards still parse.

**Files:**
- Modify: `local/lib/papersync/src/papersync/payload.py`
- Test: `local/lib/papersync/tests/test_payload.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `Payload.to_url()` percent-encodes `ref`. `Payload.parse()` decodes it. Signatures do not change.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_payload.py`:

```python
def test_ref_with_slashes_round_trips() -> None:
    p = Payload(1, "obsidian", "Notes/Projects/Alpha", "letter", 2, 3, 5)
    url = p.to_url()
    assert "Notes%2FProjects%2FAlpha" in url
    assert Payload.parse(url) == p


def test_ref_with_spaces_and_hash_round_trips() -> None:
    p = Payload(1, "obsidian", "Daily/2026-09-12 Notes #1", "letter", 1)
    assert Payload.parse(p.to_url()).ref == "Daily/2026-09-12 Notes #1"


def test_things_uuid_url_is_unchanged_by_quoting() -> None:
    p = Payload(1, "things", "ABC-123", "3x5", 1)
    assert p.to_url() == "papersync:///v1/things/ABC-123?size=3x5&boxes=1"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd local/lib/papersync && uv run pytest tests/test_payload.py -v`
Expected: the first two FAIL. `to_url` emits raw slashes, so `parse` sees five path segments and raises `PayloadError`.

- [ ] **Step 3: Quote and unquote the ref**

In `payload.py`, change the import line:

```python
from urllib.parse import parse_qs, quote, unquote, urlsplit
```

In `to_url`, replace `{self.ref}` with a quoted ref:

```python
    def to_url(self) -> str:
        ref = quote(self.ref, safe="")
        url = f"{SCHEME}v{self.version}/{self.source}/{ref}?size={self.size}&boxes={self.boxes}"
        if self.pages > 1:
            url += f"&page={self.page}&pages={self.pages}"
        return url
```

In `parse`, decode the third segment. Replace the final `return` with:

```python
        return cls(version, segments[1], unquote(segments[2]), size, boxes, page, pages)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd local/lib/papersync && uv run pytest tests/test_payload.py tests/test_assemble.py -v`
Expected: PASS. `test_assemble.py` is included because it round-trips real Things payloads through render and recognition.

- [ ] **Step 5: Commit**

```bash
git add local/lib/papersync/src/papersync/payload.py local/lib/papersync/tests/test_payload.py
git commit -m "papersync: percent-encode the ref in the QR payload"
```

---

### Task 2: Add `meta` to `Item`

Obsidian front matter needs somewhere to live in the neutral model. Things leaves the field empty.

**Files:**
- Modify: `local/lib/papersync/src/papersync/model.py`
- Test: `local/lib/papersync/tests/test_model.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `Item.meta: dict[str, Any]`, default empty. Task 10 fills it. Task 13 reads it.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_model.py`:

```python
def test_item_meta_defaults_to_empty_and_round_trips() -> None:
    from papersync.model import Item

    plain = Item(source="things", ref="T1", title="Foo")
    assert plain.meta == {}

    rich = Item(
        source="obsidian",
        ref="Notes/Alpha",
        title="Alpha",
        meta={"tags": ["project", "active"], "status": "open"},
    )
    assert Item.model_validate_json(rich.model_dump_json()) == rich
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd local/lib/papersync && uv run pytest tests/test_model.py -v`
Expected: FAIL with a pydantic validation error naming the extra field `meta`.

- [ ] **Step 3: Add the field**

In `model.py`, widen the typing import and add the field to `Item`:

```python
from typing import Any, Literal
```

```python
class Item(BaseModel):
    source: str
    ref: str
    title: str
    notes: str = ""
    meta: dict[str, Any] = Field(default_factory=dict)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd local/lib/papersync && uv run pytest -q`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add local/lib/papersync/src/papersync/model.py local/lib/papersync/tests/test_model.py
git commit -m "papersync: carry source metadata on Item"
```

---

### Task 3: Expose the QR module matrix

The chrome overlay draws QR modules as filled rectangles instead of embedding an SVG, so the modules land on exact millimeter boundaries. Both `qr_svg` and the new `qr_matrix` must use identical segno settings, so the shared code moves into one helper.

**Files:**
- Modify: `local/lib/papersync/src/papersync/render/qr.py`
- Test: `local/lib/papersync/tests/test_qr.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `qr_matrix(url: str) -> list[list[int]]`, a square matrix of `0`/`1` with no quiet zone. Version 5 gives 37 rows. Task 5 consumes it.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_qr.py`:

```python
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

    long_ref = "A" * 120
    m = qr_matrix(f"papersync:///v1/obsidian/{long_ref}?size=letter&boxes=1&page=1&pages=9")
    assert len(m) == 37
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd local/lib/papersync && uv run pytest tests/test_qr.py -v`
Expected: FAIL with `ImportError: cannot import name 'qr_matrix'`.

- [ ] **Step 3: Extract the shared maker and add the matrix**

Replace the body of `render/qr.py` below the imports with:

```python
QR_VERSION = 5


def _make(url: str) -> segno.QRCode:
    """Fixed version 5 so the printed footprint never changes."""
    try:
        return segno.make(url, version=QR_VERSION, error="m", mode="byte", boost_error=False)
    except DataOverflowError:
        return segno.make(url, version=QR_VERSION, error="l", mode="byte", boost_error=False)


def qr_svg(url: str) -> str:
    buf = io.BytesIO()
    _make(url).save(buf, kind="svg", border=0, scale=1)
    return buf.getvalue().decode()


def qr_matrix(url: str) -> list[list[int]]:
    """Module matrix with no quiet zone, for drawing modules as PDF rectangles."""
    return [list(row) for row in _make(url).matrix]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd local/lib/papersync && uv run pytest tests/test_qr.py tests/test_engine.py -v`
Expected: PASS. `test_engine.py` confirms `qr_svg` still behaves the same after the refactor.

- [ ] **Step 5: Commit**

```bash
git add local/lib/papersync/src/papersync/render/qr.py local/lib/papersync/tests/test_qr.py
git commit -m "papersync: expose the QR module matrix for direct PDF drawing"
```

---

### Task 4: Make the primary box optional in the geometry

An Obsidian note is a document, not a task, so it prints no primary done box. The geometry has to say so, because both the renderer and the recognizer read it.

**Files:**
- Modify: `local/lib/papersync/src/papersync/render/templates/v1/layout.py`
- Test: `local/lib/papersync/tests/test_layout.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `L.geometry(size, labels, primary_box: bool = True)` and a `"primary_box"` key in the returned dict. Existing callers keep working unchanged.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_layout.py`:

```python
def test_geometry_reports_a_primary_box_by_default() -> None:
    g = L.geometry(L.SIZES["3x5"], ["A"])
    assert g["primary_box"] is True


def test_geometry_can_drop_the_primary_box() -> None:
    g = L.geometry(L.SIZES["letter"], ["A"], primary_box=False)
    assert g["primary_box"] is False
    # The done box rectangle still exists; only the flag says whether to draw it.
    assert L.done_box(L.SIZES["letter"]).w == L.BOX_MM
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd local/lib/papersync && uv run pytest tests/test_layout.py -v`
Expected: FAIL with `KeyError: 'primary_box'`, then a `TypeError` for the unexpected keyword.

- [ ] **Step 3: Add the parameter and the key**

In `layout.py`, change the `geometry` signature and add the key:

```python
def geometry(size: PageSize, labels: list[str], primary_box: bool = True) -> dict[str, object]:
    return {
        "width": size.width,
        "height": size.height,
        "margin": MARGIN_MM,
        "top": TOP_MM,
        "bottom": BOTTOM_MM,
        "primary_box": primary_box,
        "fiducials": [r.as_dict() for r in fiducials(size)],
        "qr": qr_rect(size).as_dict(),
        "done_box": done_box(size).as_dict(),
        "title_bar": title_bar(size).as_dict(),
        "footer": footer_rect(size).as_dict(),
        "meta_boxes": [
            {"rect": meta_box(size, i).as_dict(), "label": label} for i, label in enumerate(labels)
        ],
    }
```

In `card.typ`, guard the done box so the Typst renderer honors the flag too. Change the line `rect_at(g.done_box, stroke: 0.4pt)` to:

```typst
    if g.primary_box { rect_at(g.done_box, stroke: 0.4pt) }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd local/lib/papersync && uv run pytest -q`
Expected: PASS, whole suite. Things cards default to `primary_box=True` and look identical.

- [ ] **Step 5: Commit**

```bash
git add local/lib/papersync/src/papersync/render/templates/v1/layout.py local/lib/papersync/src/papersync/render/templates/v1/card.typ local/lib/papersync/tests/test_layout.py
git commit -m "papersync: make the primary done box optional in the geometry"
```

---

### Task 5: Draw the geometric chrome with pymupdf

This is the accuracy-critical task. The overlay draws fiducials, the QR and the meta boxes in PDF user space at coordinates that come straight from `layout.py`, so Chromium's scaling cannot move them.

Two details matter. First, PyMuPDF uses a top-left origin with y growing downward, the same convention as `layout.py`, so no y flip is needed. Second, adjacent QR module rectangles can leave hairline antialiasing seams, so consecutive dark modules in a row are merged into one rectangle.

**Files:**
- Create: `local/lib/papersync/src/papersync/render/chrome.py`
- Test: `local/lib/papersync/tests/test_chrome.py`

**Interfaces:**
- Consumes: `qr_matrix` (Task 3), `L.geometry` constants (Task 4), `Payload` (Task 1).
- Produces:
  - `PT: float` — points per millimeter.
  - `class ChromeError(RuntimeError)`.
  - `blank(size: L.PageSize, pages: int) -> bytes` — a test and fallback helper.
  - `stamp_marks(doc: pymupdf.Document, size, labels, payloads, primary_box) -> None` — mutates in place.
  - Task 6 adds `stamp_text` and the public `stamp` to this same module.

- [ ] **Step 1: Write the failing test**

Create `tests/test_chrome.py`:

```python
import pymupdf
import pytest

from papersync.payload import Payload
from papersync.render import chrome
from papersync.render.templates.v1 import layout as L  # noqa: N812

SIZE = L.SIZES["letter"]
TOL_PT = 0.1 * chrome.PT  # 0.1 mm


def _payloads(n: int) -> list[Payload]:
    return [
        Payload(1, "obsidian", "Notes/Alpha", SIZE.name, 1, page=i + 1, pages=n)
        for i in range(n)
    ]


def _black_squares(page: pymupdf.Page, side_mm: float) -> list[pymupdf.Rect]:
    """Filled black rectangles whose side matches ``side_mm`` within tolerance."""
    want = side_mm * chrome.PT
    out = []
    for d in page.get_drawings():
        r = d["rect"]
        if d.get("fill") == (0.0, 0.0, 0.0) and abs(r.width - want) < TOL_PT:
            if abs(r.height - want) < TOL_PT:
                out.append(r)
    return out


def test_blank_makes_pages_of_the_requested_size() -> None:
    doc = pymupdf.open("pdf", chrome.blank(SIZE, 3))
    assert doc.page_count == 3
    assert abs(doc[0].rect.width - SIZE.width * chrome.PT) < TOL_PT
    assert abs(doc[0].rect.height - SIZE.height * chrome.PT) < TOL_PT


def test_fiducials_land_within_a_tenth_of_a_millimetre() -> None:
    doc = pymupdf.open("pdf", chrome.blank(SIZE, 1))
    chrome.stamp_marks(doc, SIZE, ["A", "B"], _payloads(1), primary_box=False)
    got = sorted((r.x0, r.y0) for r in _black_squares(doc[0], L.FIDUCIAL_MM))
    want = sorted((f.x * chrome.PT, f.y * chrome.PT) for f in L.fiducials(SIZE))
    assert len(got) == 4
    for (gx, gy), (wx, wy) in zip(got, want, strict=True):
        assert abs(gx - wx) < TOL_PT and abs(gy - wy) < TOL_PT


def test_meta_boxes_are_stroked_only_on_the_first_page() -> None:
    doc = pymupdf.open("pdf", chrome.blank(SIZE, 2))
    chrome.stamp_marks(doc, SIZE, ["A", "B", "C"], _payloads(2), primary_box=False)

    def stroked_small_squares(page: pymupdf.Page) -> list[pymupdf.Rect]:
        want = L.BOX_MM * chrome.PT
        return [
            d["rect"]
            for d in page.get_drawings()
            if d.get("color") is not None
            and d.get("fill") is None
            and abs(d["rect"].width - want) < TOL_PT
        ]

    first = sorted(r.x0 for r in stroked_small_squares(doc[0]))
    assert len(first) == 3
    for got, i in zip(first, range(3), strict=True):
        assert abs(got - L.meta_box(SIZE, i).x * chrome.PT) < TOL_PT
    assert stroked_small_squares(doc[1]) == []


def test_primary_box_is_drawn_only_when_requested() -> None:
    want = L.BOX_MM * chrome.PT
    doc_off = pymupdf.open("pdf", chrome.blank(SIZE, 1))
    chrome.stamp_marks(doc_off, SIZE, [], _payloads(1), primary_box=False)
    doc_on = pymupdf.open("pdf", chrome.blank(SIZE, 1))
    chrome.stamp_marks(doc_on, SIZE, [], _payloads(1), primary_box=True)

    def small_squares(page: pymupdf.Page) -> int:
        return sum(
            1
            for d in page.get_drawings()
            if d.get("fill") is None and abs(d["rect"].width - want) < TOL_PT
        )

    assert small_squares(doc_off[0]) == 0
    assert small_squares(doc_on[0]) == 1


def test_qr_modules_stay_inside_the_qr_rectangle() -> None:
    doc = pymupdf.open("pdf", chrome.blank(SIZE, 1))
    chrome.stamp_marks(doc, SIZE, [], _payloads(1), primary_box=False)
    q = L.qr_rect(SIZE)
    box = pymupdf.Rect(
        q.x * chrome.PT, q.y * chrome.PT, (q.x + q.w) * chrome.PT, (q.y + q.h) * chrome.PT
    )
    modules = [
        d["rect"]
        for d in doc[0].get_drawings()
        if d.get("fill") == (0.0, 0.0, 0.0) and d["rect"].width < L.FIDUCIAL_MM * chrome.PT
    ]
    assert len(modules) > 50  # merged runs, so far fewer than 37*37 but plenty
    for r in modules:
        assert r.x0 >= box.x0 - TOL_PT and r.x1 <= box.x1 + TOL_PT
        assert r.y0 >= box.y0 - TOL_PT and r.y1 <= box.y1 + TOL_PT


def test_wrong_page_size_is_rejected() -> None:
    doc = pymupdf.open("pdf", chrome.blank(L.SIZES["4x6"], 1))
    with pytest.raises(chrome.ChromeError, match="page 1 is"):
        chrome.stamp_marks(doc, SIZE, [], _payloads(1), primary_box=False)


def test_payload_count_must_match_page_count() -> None:
    doc = pymupdf.open("pdf", chrome.blank(SIZE, 2))
    with pytest.raises(chrome.ChromeError, match="1 payload"):
        chrome.stamp_marks(doc, SIZE, [], _payloads(1), primary_box=False)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd local/lib/papersync && uv run pytest tests/test_chrome.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'papersync.render.chrome'`.

- [ ] **Step 3: Write the overlay**

Create `src/papersync/render/chrome.py`:

```python
"""Draw papersync chrome onto a finished PDF, in PDF user space.

The marks must sit at the exact millimetre coordinates ``layout.py`` computes,
because ``recognize.geometry`` fits its homography to them and then looks every
box up in millimetres. Drawing them here, after the body renderer has finished,
keeps that guarantee independent of whatever produced the body.
"""

import pymupdf

from papersync.payload import Payload
from papersync.render.qr import qr_matrix
from papersync.render.templates.v1 import layout as L  # noqa: N812

PT = 72.0 / 25.4
TOLERANCE_PT = 0.1 * PT
BLACK = (0.0, 0.0, 0.0)


class ChromeError(RuntimeError):
    pass


def rect(r: L.Rect) -> pymupdf.Rect:
    return pymupdf.Rect(r.x * PT, r.y * PT, (r.x + r.w) * PT, (r.y + r.h) * PT)


def blank(size: L.PageSize, pages: int) -> bytes:
    doc = pymupdf.open()
    for _ in range(pages):
        doc.new_page(width=size.width * PT, height=size.height * PT)
    return doc.tobytes()


def _check_page(page: pymupdf.Page, size: L.PageSize, number: int) -> None:
    if page.rotation:
        raise ChromeError(f"page {number} is rotated {page.rotation} degrees")
    want_w, want_h = size.width * PT, size.height * PT
    if abs(page.rect.width - want_w) > TOLERANCE_PT or abs(page.rect.height - want_h) > TOLERANCE_PT:
        raise ChromeError(
            f"page {number} is {page.rect.width / PT:.1f}x{page.rect.height / PT:.1f} mm, "
            f"expected {size.width}x{size.height} mm"
        )


def _draw_qr(page: pymupdf.Page, size: L.PageSize, payload: Payload) -> None:
    """Draw modules as filled rectangles, merging runs so no seam shows."""
    matrix = qr_matrix(payload.to_url())
    q = L.qr_rect(size)
    step = q.w / len(matrix)
    for row, bits in enumerate(matrix):
        col = 0
        while col < len(bits):
            if not bits[col]:
                col += 1
                continue
            start = col
            while col < len(bits) and bits[col]:
                col += 1
            page.draw_rect(
                pymupdf.Rect(
                    (q.x + start * step) * PT,
                    (q.y + row * step) * PT,
                    (q.x + col * step) * PT,
                    (q.y + (row + 1) * step) * PT,
                ),
                color=None,
                fill=BLACK,
                width=0,
            )


def stamp_marks(
    doc: pymupdf.Document,
    size: L.PageSize,
    labels: list[str],
    payloads: list[Payload],
    primary_box: bool,
) -> None:
    """Draw fiducials, QR codes and boxes onto every page of ``doc`` in place."""
    if len(payloads) != doc.page_count:
        raise ChromeError(f"{len(payloads)} payload(s) for {doc.page_count} page(s)")
    for index, page in enumerate(doc):
        _check_page(page, size, index + 1)
        for f in L.fiducials(size):
            page.draw_rect(rect(f), color=None, fill=BLACK, width=0)
        _draw_qr(page, size, payloads[index])
        if index:
            continue
        if primary_box:
            page.draw_rect(rect(L.done_box(size)), color=BLACK, width=0.4)
        for i in range(len(labels)):
            page.draw_rect(rect(L.meta_box(size, i)), color=BLACK, width=0.4)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd local/lib/papersync && uv run pytest tests/test_chrome.py -v`
Expected: PASS, eight tests.

- [ ] **Step 5: Commit**

```bash
git add local/lib/papersync/src/papersync/render/chrome.py local/lib/papersync/tests/test_chrome.py
git commit -m "papersync: draw fiducials, QR and boxes onto finished PDFs"
```

---

### Task 6: Draw the text chrome and expose `stamp`

The title bar, the continuation bar, the box labels and the rotated right-margin footer complete the overlay. The footer runs down the page, so it uses `rotate=270`, which is PyMuPDF's clockwise quarter turn and matches what `card.typ` does with `rotate(90deg)`.

**Files:**
- Modify: `local/lib/papersync/src/papersync/render/chrome.py`
- Test: `local/lib/papersync/tests/test_chrome.py`

**Interfaces:**
- Consumes: `stamp_marks`, `rect`, `PT`, `ChromeError` (Task 5).
- Produces: `stamp(pdf: bytes, size: L.PageSize, labels: list[str], title: str, footer: str, payloads: list[Payload], primary_box: bool = False) -> bytes`. Task 13 calls it.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_chrome.py`:

```python
def _spans(page: pymupdf.Page) -> list[dict]:
    out = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            out += line["spans"]
    return out


def _stamped(pages: int, title: str = "Project Alpha") -> pymupdf.Document:
    pdf = chrome.stamp(
        chrome.blank(SIZE, pages),
        SIZE,
        ["A", "B"],
        title,
        "2026-09-12",
        _payloads(pages),
    )
    return pymupdf.open("pdf", pdf)


def test_first_page_shows_the_title_and_later_pages_show_the_continuation() -> None:
    doc = _stamped(2)
    first = " ".join(s["text"] for s in _spans(doc[0]))
    second = " ".join(s["text"] for s in _spans(doc[1]))
    assert "Project Alpha" in first and "(cont.)" not in first
    assert "Project Alpha (cont.)" in second


def test_box_labels_print_under_the_boxes_on_the_first_page_only() -> None:
    doc = _stamped(2)
    labels = [s for s in _spans(doc[0]) if s["text"].strip() in {"A", "B"}]
    assert len(labels) == 2
    for span in labels:
        assert span["bbox"][1] > L.meta_box(SIZE, 0).y * chrome.PT
    assert [s for s in _spans(doc[1]) if s["text"].strip() in {"A", "B"}] == []


def test_footer_runs_down_the_right_margin_and_carries_the_page_number() -> None:
    doc = _stamped(3)
    strip = L.footer_rect(SIZE)
    footers = [s for s in _spans(doc[1]) if "2026-09-12" in s["text"]]
    assert len(footers) == 1
    span = footers[0]
    assert "2/3" in span["text"]
    x0, y0, x1, y1 = span["bbox"]
    # Rotated text: the drawn box is taller than it is wide.
    assert (y1 - y0) > (x1 - x0)
    assert x0 >= (strip.x - 1.0) * chrome.PT


def test_single_page_footer_omits_the_page_number() -> None:
    doc = _stamped(1)
    footers = [s for s in _spans(doc[0]) if "2026-09-12" in s["text"]]
    assert len(footers) == 1
    assert "/" not in footers[0]["text"]


def test_stamp_returns_bytes_and_preserves_the_page_count() -> None:
    pdf = chrome.stamp(chrome.blank(SIZE, 4), SIZE, [], "T", "d", _payloads(4))
    assert isinstance(pdf, bytes)
    assert pymupdf.open("pdf", pdf).page_count == 4
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd local/lib/papersync && uv run pytest tests/test_chrome.py -v`
Expected: FAIL with `AttributeError: module 'papersync.render.chrome' has no attribute 'stamp'`.

- [ ] **Step 3: Add the text chrome**

Add to the top of `chrome.py`, after the existing imports:

```python
from pathlib import Path
```

and after the `BLACK` constant:

```python
FONT_DIR = Path(__file__).parent / "templates" / "v1" / "fonts"
FONT_REGULAR = ("psans", FONT_DIR / "NewCMSans10-Regular.otf")
FONT_BOLD = ("psansb", FONT_DIR / "NewCMSans10-Bold.otf")
TITLE_FILL = (0.882, 0.882, 0.882)  # luma 225, matching card.typ
FOOTER_GRAY = (0.431, 0.431, 0.431)  # luma 110, matching card.typ
TITLE_PT = 10
LABEL_PT = 6
FOOTER_PT = 6
```

Then append these functions:

```python
def _title_text(page: pymupdf.Page, size: L.PageSize, text: str) -> None:
    bar = L.title_bar(size)
    page.draw_rect(rect(bar), color=None, fill=TITLE_FILL, width=0)
    inner = pymupdf.Rect(
        (bar.x + 1.4) * PT, (bar.y + 0.6) * PT, (bar.x + bar.w - 1.4) * PT, (bar.y + bar.h) * PT
    )
    page.insert_textbox(inner, text, fontsize=TITLE_PT, fontname=FONT_BOLD[0], color=BLACK)


def _footer_text(page: pymupdf.Page, size: L.PageSize, text: str) -> None:
    """Rotated a quarter turn clockwise down the right margin.

    PyMuPDF measures ``rotate`` counterclockwise, so 270 is the clockwise
    quarter turn that ``card.typ`` writes as ``rotate(90deg)``.
    """
    strip = L.footer_rect(size)
    page.insert_textbox(
        rect(strip),
        text,
        fontsize=FOOTER_PT,
        fontname=FONT_REGULAR[0],
        color=FOOTER_GRAY,
        rotate=270,
    )


def _labels_text(page: pymupdf.Page, size: L.PageSize, labels: list[str]) -> None:
    for i, label in enumerate(labels):
        box = L.meta_box(size, i)
        page.insert_textbox(
            pymupdf.Rect(
                box.x * PT,
                (box.y + box.h + 0.5) * PT,
                (box.x + L.BOX_PITCH_MM) * PT,
                (box.y + box.h + 3.5) * PT,
            ),
            label,
            fontsize=LABEL_PT,
            fontname=FONT_REGULAR[0],
            color=BLACK,
        )


def stamp(
    pdf: bytes,
    size: L.PageSize,
    labels: list[str],
    title: str,
    footer: str,
    payloads: list[Payload],
    primary_box: bool = False,
) -> bytes:
    """Return ``pdf`` with papersync chrome drawn on every page."""
    doc = pymupdf.open("pdf", pdf)
    stamp_marks(doc, size, labels, payloads, primary_box)
    total = doc.page_count
    for index, page in enumerate(doc):
        for name, path in (FONT_REGULAR, FONT_BOLD):
            page.insert_font(fontname=name, fontfile=str(path))
        _footer_text(page, size, footer if total == 1 else f"{footer} · {index + 1}/{total}")
        _title_text(page, size, title if index == 0 else f"{title} (cont.)")
        if index == 0:
            _labels_text(page, size, labels)
    return doc.tobytes()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd local/lib/papersync && uv run pytest tests/test_chrome.py -v`
Expected: PASS, thirteen tests. If `test_footer_runs_down_the_right_margin_and_carries_the_page_number` reports a wider-than-tall bbox, the rotation constant is wrong for this PyMuPDF version. Change `rotate=270` to `rotate=90` and rerun. Do not change the assertion.

- [ ] **Step 5: Commit**

```bash
git add local/lib/papersync/src/papersync/render/chrome.py local/lib/papersync/tests/test_chrome.py
git commit -m "papersync: stamp title, labels and rotated footer onto finished PDFs"
```

---

### Task 7: Score the primary box only for sources that print one

A page with no done box must not report a `done` result, and a document must never come back marked complete.

**Files:**
- Modify: `local/lib/papersync/src/papersync/recognize/assemble.py`
- Test: `local/lib/papersync/tests/test_assemble.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `_score_boxes(gray, h, size, labels, overlay, primary: bool)`. `recognize_pages` sets `primary` from `payload.source == "things"`. Task 8 relies on this.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_assemble.py`:

```python
def test_a_source_without_a_primary_box_reports_no_done_result(tmp_path: Path) -> None:
    from papersync.payload import Payload
    from papersync.render import chrome

    size = L.SIZES["letter"]
    payload = Payload(1, "obsidian", "Notes/Alpha", size.name, 1, 1, 1)
    pdf = chrome.stamp(
        chrome.blank(size, 1), size, ["A", "B"], "Alpha", "2026-09-12", [payload]
    )
    gray = synthetic.rasterize(pdf)
    synthetic.draw_x(gray, L.meta_box(size, 1))

    def lookup(refs: list[str]) -> dict[str, Item]:
        return {r: Item(source="obsidian", ref=r, title="Alpha") for r in refs}

    rec = recognize_pages(
        [RasterPage("fake.pdf", 0, gray)], FakeOcr(), _registry(tmp_path), lookup, TODAY, ["fake"]
    )
    assert rec.plan.errors == []
    change = rec.plan.changes[0]
    assert change.source == "obsidian"
    assert change.ref == "Notes/Alpha"
    assert change.complete is False
    assert "done" not in change.boxes
    assert change.marks == ["B"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd local/lib/papersync && uv run pytest tests/test_assemble.py -v -k primary`
Expected: FAIL. `change.boxes` contains a `done` key, because `_score_boxes` always scores the done rectangle.

- [ ] **Step 3: Make the primary box conditional**

In `assemble.py`, change `_score_boxes` to take a flag:

```python
def _score_boxes(
    gray: np.ndarray,
    h: np.ndarray,
    size: L.PageSize,
    labels: list[str],
    overlay: PageOverlay,
    primary: bool,
) -> dict[str, BoxResult]:
    rects = [(lb, L.meta_box(size, i)) for i, lb in enumerate(labels)]
    if primary:
        rects.insert(0, ("done", L.done_box(size)))
    out: dict[str, BoxResult] = {}
    for label, rect in rects:
        result = marks.classify(marks.box_fill(gray, h, rect))
        out[label] = result
        overlay.boxes.append((rect, result))
    return out
```

In `recognize_pages`, derive the flag and use it. Replace the `boxes = _score_boxes(...)` line and the two `boxes["done"].checked` uses:

```python
        primary = payload.source == "things"
        boxes = _score_boxes(gray, h, size, labels, overlay, primary)
        marked = [lb for lb in labels if boxes[lb].checked]
        complete = primary and boxes["done"].checked
```

Then use `complete=complete` in both the `create` and the `update` `Change(...)` calls, in place of `complete=boxes["done"].checked`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd local/lib/papersync && uv run pytest tests/test_assemble.py -v`
Expected: PASS. Every existing Things test still scores a `done` box.

- [ ] **Step 5: Commit**

```bash
git add local/lib/papersync/src/papersync/recognize/assemble.py local/lib/papersync/tests/test_assemble.py
git commit -m "papersync: score the primary box only for sources that print one"
```

---

### Task 8: Prove the geometry end to end

This is the gate the whole overlay design rests on. If a stamped PDF survives rasterization and the real recognizer, then the marks are trustworthy without a printer in the loop. A second test holds the two chrome implementations in agreement, so Typst and pymupdf cannot drift apart.

**Files:**
- Create: `local/lib/papersync/tests/test_chrome_roundtrip.py`

**Interfaces:**
- Consumes: `chrome.stamp` (Task 6), `_score_boxes` behavior (Task 7), `synthetic` helpers.
- Produces: nothing. This task only adds tests.

- [ ] **Step 1: Write the failing test**

Create `tests/test_chrome_roundtrip.py`:

```python
"""End-to-end proof that stamped chrome is dimensionally trustworthy.

Stamp a blank page, rasterize it at scan resolution, then run the real
recognizer over it. If the QR decodes and every box lands where ``layout.py``
says it does, Chromium's page scaling cannot break recognition.
"""

from datetime import date
from pathlib import Path

import numpy as np

from papersync.boxsets import BoxSetRegistry
from papersync.model import Item
from papersync.payload import Payload
from papersync.recognize import geometry
from papersync.recognize.assemble import recognize_pages
from papersync.recognize.ocr import OcrLine
from papersync.recognize.raster import RasterPage
from papersync.render import chrome, engine
from papersync.render.templates.v1 import layout as L  # noqa: N812
from tests import synthetic

SIZE = L.SIZES["letter"]
TODAY = date(2026, 9, 12)
LABELS = ["A", "B", "C", "D"]


class NoOcr:
    def recognize(self, gray: np.ndarray) -> list[OcrLine]:
        return []


def _registry(tmp_path: Path) -> BoxSetRegistry:
    reg = BoxSetRegistry(tmp_path / "boxsets.toml")
    assert reg.id_for(LABELS) == 1
    return reg


def _lookup(refs: list[str]) -> dict[str, Item]:
    return {r: Item(source="obsidian", ref=r, title="Alpha") for r in refs}


def _stamped(pages: int, ref: str = "Notes/Projects/Alpha") -> bytes:
    payloads = [
        Payload(1, "obsidian", ref, SIZE.name, 1, page=i + 1, pages=pages) for i in range(pages)
    ]
    return chrome.stamp(
        chrome.blank(SIZE, pages), SIZE, LABELS, "Alpha", TODAY.isoformat(), payloads
    )


def test_stamped_page_survives_rasterization_and_recognition(tmp_path: Path) -> None:
    gray = synthetic.rasterize(_stamped(1))
    synthetic.draw_x(gray, L.meta_box(SIZE, 0))
    synthetic.draw_x(gray, L.meta_box(SIZE, 2))

    rec = recognize_pages(
        [RasterPage("fake.pdf", 0, gray)], NoOcr(), _registry(tmp_path), _lookup, TODAY, ["fake"]
    )

    assert rec.plan.errors == []
    change = rec.plan.changes[0]
    assert change.ref == "Notes/Projects/Alpha"
    assert change.marks == ["A", "C"]
    assert change.complete is False


def test_stamped_pages_survive_rotation_and_scaling(tmp_path: Path) -> None:
    """A real scan is never square to the platen. The homography must absorb that."""
    gray = synthetic.distort(synthetic.rasterize(_stamped(1)))

    rec = recognize_pages(
        [RasterPage("fake.pdf", 0, gray)], NoOcr(), _registry(tmp_path), _lookup, TODAY, ["fake"]
    )
    assert rec.plan.errors == []
    assert rec.plan.changes[0].ref == "Notes/Projects/Alpha"


def test_continuation_pages_are_gathered_into_one_change(tmp_path: Path) -> None:
    pdf = _stamped(3)
    pages = [
        RasterPage("fake.pdf", i, synthetic.rasterize(pdf, page=i)) for i in range(3)
    ]

    rec = recognize_pages(pages, NoOcr(), _registry(tmp_path), _lookup, TODAY, ["fake"])
    assert rec.plan.errors == []
    assert len(rec.plan.changes) == 1
    assert rec.plan.changes[0].pages == [1, 2, 3]


def test_both_renderers_place_their_marks_at_the_same_coordinates(tmp_path: Path) -> None:
    """Typst renders Things cards and pymupdf renders documents.

    Two chrome implementations now exist. This test stops them drifting: it
    recovers the fiducial centres from each renderer's raster and compares them.
    """
    size = L.SIZES["letter"]
    opts = engine.RenderOptions(labels=LABELS, boxes_id=1, size="letter", overflow="paginate")
    typst_pdf = engine.render_item(
        Item(source="things", ref="T1", title="Alpha"), "letter", opts, TODAY
    ).pdf
    payload = Payload(1, "obsidian", "Notes/Alpha", size.name, 1)
    overlay_pdf = chrome.stamp(
        chrome.blank(size, 1), size, LABELS, "Alpha", TODAY.isoformat(), [payload]
    )

    h = synthetic.identity_h()
    centres = [geometry.mm_to_px(h, *f.center) for f in L.fiducials(size)]

    # Both renderers must put ink at every coordinate layout.py names, and white
    # space just outside each square. That is what holds them in agreement.
    for pdf in (typst_pdf, overlay_pdf):
        gray = synthetic.rasterize(pdf)
        for cx, cy in centres:
            assert gray[int(cy), int(cx)] < 128
        for f in L.fiducials(size):
            ox, oy = geometry.mm_to_px(h, f.x - 1.5, f.y - 1.5)
            assert gray[int(oy), int(ox)] > 200
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd local/lib/papersync && uv run pytest tests/test_chrome_roundtrip.py -v`
Expected: FAIL only if an earlier task is incomplete. If Tasks 1 to 7 all landed, these tests may already pass. That is the correct outcome for a verification task, so record which tests passed on the first run.

- [ ] **Step 3: Fix whatever the tests catch**

If `test_stamped_page_survives_rasterization_and_recognition` fails on QR decoding, the module rectangles are misaligned. Check `_draw_qr` in `chrome.py`: `step` must be `q.w / len(matrix)` with no border added, because `qr_matrix` already excludes the quiet zone.

If `test_both_renderers_place_their_marks_at_the_same_coordinates` fails, one renderer is not reading `layout.py`. Fix the renderer, never the test.

- [ ] **Step 4: Run the whole suite**

Run: `cd local/lib/papersync && uv run pytest -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add local/lib/papersync/tests/test_chrome_roundtrip.py
git commit -m "papersync: prove stamped chrome survives scan recognition"
```

---

### Task 9: Configuration and the Obsidian CLI wrapper

The `obsidian` binary always exits 0 and reports failure by printing `Error: ...` on stdout. Every call has to check for that prefix. `eval` also prefixes success with `=> `.

**Files:**
- Modify: `local/lib/papersync/src/papersync/config.py`
- Create: `local/lib/papersync/src/papersync/integrations/obsidian/__init__.py`
- Create: `local/lib/papersync/src/papersync/integrations/obsidian/cli.py`
- Test: `local/lib/papersync/tests/test_obsidian_cli.py`
- Test: `local/lib/papersync/tests/test_config.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ObsidianConfig(vault: str = "", frontmatter_skip: list[str])` on `Config.obsidian`.
  - `class ObsidianError(RuntimeError)`.
  - `class ObsidianCli` with `__init__(self, vault: str, runner: Callable[[list[str]], str] = run_obsidian)`, and methods `call(command, **params) -> str`, `call_json(command, **params) -> Any`, `evaluate(js: str) -> str`.
  - Tasks 10, 11, 13 and 14 use `ObsidianCli`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_obsidian_cli.py`:

```python
import json

import pytest

from papersync.integrations.obsidian.cli import ObsidianCli, ObsidianError


def _recorder(reply: str) -> tuple[list[list[str]], object]:
    calls: list[list[str]] = []

    def runner(args: list[str]) -> str:
        calls.append(args)
        return reply

    return calls, runner


def test_call_passes_the_vault_and_the_parameters() -> None:
    calls, runner = _recorder("done")
    cli = ObsidianCli("Notes", runner=runner)
    assert cli.call("read", path="Notes/Alpha.md") == "done"
    assert calls == [["vault=Notes", "read", "path=Notes/Alpha.md"]]


def test_call_drops_parameters_that_are_none_and_renders_flags() -> None:
    calls, runner = _recorder("ok")
    ObsidianCli("Notes", runner=runner).call("files", folder=None, ext="md", total=True)
    assert calls == [["vault=Notes", "files", "ext=md", "total"]]


def test_an_error_line_on_stdout_raises_even_though_the_exit_code_is_zero() -> None:
    _, runner = _recorder('Error: File "missing.md" not found.')
    with pytest.raises(ObsidianError, match="missing.md"):
        ObsidianCli("Notes", runner=runner).call("read", path="missing.md")


def test_call_json_parses_the_reply() -> None:
    _, runner = _recorder(json.dumps({"title": "Alpha", "tags": ["a"]}))
    got = ObsidianCli("Notes", runner=runner).call_json("properties", path="Notes/Alpha.md")
    assert got == {"title": "Alpha", "tags": ["a"]}


def test_call_json_reports_unparseable_output() -> None:
    _, runner = _recorder("not json at all")
    with pytest.raises(ObsidianError, match="not JSON"):
        ObsidianCli("Notes", runner=runner).call_json("properties", path="x.md")


def test_evaluate_strips_the_result_arrow() -> None:
    calls, runner = _recorder("=> {\"ok\": true}")
    cli = ObsidianCli("Notes", runner=runner)
    assert cli.evaluate("window.papersync.version") == '{"ok": true}'
    assert calls == [["vault=Notes", "eval", "code=window.papersync.version"]]
```

Append to `tests/test_config.py`:

```python
def test_obsidian_config_defaults_and_parsing(tmp_path) -> None:
    from papersync.config import Config, load_config

    assert Config().obsidian.vault == ""
    assert Config().obsidian.frontmatter_skip == ["papersync-printed"]

    path = tmp_path / "config.toml"
    path.write_text('[obsidian]\nvault = "Notes"\nfrontmatter_skip = ["a", "b"]\n')
    cfg = load_config(path)
    assert cfg.obsidian.vault == "Notes"
    assert cfg.obsidian.frontmatter_skip == ["a", "b"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd local/lib/papersync && uv run pytest tests/test_obsidian_cli.py tests/test_config.py -v`
Expected: FAIL with `ModuleNotFoundError` for the new module, and `AttributeError` for `Config.obsidian`.

- [ ] **Step 3: Write the config and the wrapper**

In `config.py`, add the model and wire it into `Config`:

```python
class ObsidianConfig(BaseModel):
    vault: str = ""
    frontmatter_skip: list[str] = Field(default_factory=lambda: ["papersync-printed"])


class Config(BaseModel):
    render: RenderConfig = Field(default_factory=RenderConfig)
    things: ThingsConfig = Field(default_factory=ThingsConfig)
    obsidian: ObsidianConfig = Field(default_factory=ObsidianConfig)
```

Create `src/papersync/integrations/obsidian/__init__.py` as an empty file.

Create `src/papersync/integrations/obsidian/cli.py`:

```python
"""Thin wrapper around the Obsidian desktop CLI.

The binary always exits 0. It reports failure by printing a line that starts
with ``Error: `` on stdout, so the exit code carries no information and every
reply has to be inspected.
"""

import json
import subprocess
from collections.abc import Callable
from typing import Any

BINARY = "obsidian"
ERROR_PREFIX = "Error:"
RESULT_PREFIX = "=> "


class ObsidianError(RuntimeError):
    pass


def run_obsidian(args: list[str]) -> str:
    try:
        proc = subprocess.run(
            [BINARY, *args], capture_output=True, text=True, check=False, timeout=120
        )
    except FileNotFoundError as exc:
        raise ObsidianError("the obsidian CLI is not on PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise ObsidianError("the obsidian CLI timed out; is Obsidian running?") from exc
    if proc.returncode != 0 and not proc.stdout.strip():
        raise ObsidianError(f"obsidian exited {proc.returncode}: {proc.stderr.strip()}")
    return proc.stdout.strip()


class ObsidianCli:
    def __init__(self, vault: str, runner: Callable[[list[str]], str] = run_obsidian) -> None:
        self.vault = vault
        self.runner = runner

    def call(self, command: str, **params: Any) -> str:
        args = [f"vault={self.vault}", command]
        for key, value in params.items():
            if value is None or value is False:
                continue
            args.append(key if value is True else f"{key}={value}")
        reply = self.runner(args)
        if reply.startswith(ERROR_PREFIX):
            raise ObsidianError(f"{command}: {reply[len(ERROR_PREFIX):].strip()}")
        return reply

    def call_json(self, command: str, **params: Any) -> Any:
        reply = self.call(command, **params)
        try:
            return json.loads(reply)
        except ValueError as exc:
            raise ObsidianError(f"{command} returned output that is not JSON: {reply[:120]!r}") from exc

    def evaluate(self, js: str) -> str:
        reply = self.call("eval", code=js)
        return reply[len(RESULT_PREFIX):] if reply.startswith(RESULT_PREFIX) else reply
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd local/lib/papersync && uv run pytest tests/test_obsidian_cli.py tests/test_config.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add local/lib/papersync/src/papersync/config.py local/lib/papersync/src/papersync/integrations/obsidian/ local/lib/papersync/tests/test_obsidian_cli.py local/lib/papersync/tests/test_config.py
git commit -m "papersync: add the Obsidian CLI wrapper and configuration"
```

---

### Task 10: The Obsidian source

Selector parsing, note fetching and front matter. Front matter comes from `obsidian properties`, already parsed as JSON, so papersync needs no YAML parser. The body is the file text with the leading `---` block removed by a delimiter scan.

**Files:**
- Create: `local/lib/papersync/src/papersync/integrations/obsidian/source.py`
- Test: `local/lib/papersync/tests/test_obsidian_source.py`

**Interfaces:**
- Consumes: `ObsidianCli`, `ObsidianError` (Task 9), `Item.meta` (Task 2).
- Produces:
  - `PRINTED_PROPERTY = "papersync-printed"`.
  - `strip_frontmatter(text: str) -> str`.
  - `parse_selector(selector: str) -> tuple[str, str]` returning `(kind, argument)`.
  - `class ObsidianSource` with `name = "obsidian"`, `export(selector, skip_printed=True) -> list[Item]`, `lookup(refs) -> dict[str, Item]`, and the `skipped_printed` counter.
  - Tasks 13 and 14 use it.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_obsidian_source.py`:

```python
import json

import pytest

from papersync.integrations.obsidian.cli import ObsidianCli, ObsidianError
from papersync.integrations.obsidian.source import (
    ObsidianSource,
    parse_selector,
    strip_frontmatter,
)

ALPHA = """---
title: Alpha
tags:
  - project
---

# Alpha

Body text.
"""


class FakeVault:
    """Replays canned replies and records the commands it was asked for."""

    def __init__(self, files: dict[str, str], props: dict[str, dict]) -> None:
        self.files = files
        self.props = props
        self.calls: list[list[str]] = []

    def __call__(self, args: list[str]) -> str:
        self.calls.append(args)
        command = args[1]
        params = dict(a.split("=", 1) for a in args[2:] if "=" in a)
        if command == "read":
            return self.files[params["path"]]
        if command == "properties":
            return json.dumps(self.props.get(params["path"], {}))
        if command == "search":
            return json.dumps([{"path": p} for p in self.files])
        if command == "files":
            return "\n".join(self.files)
        if command == "base:query":
            return json.dumps([{"path": p} for p in self.files])
        raise AssertionError(f"unexpected command {command}")


def _source(files: dict[str, str], props: dict[str, dict] | None = None) -> ObsidianSource:
    fake = FakeVault(files, props or {})
    src = ObsidianSource(ObsidianCli("Notes", runner=fake))
    src.fake = fake  # type: ignore[attr-defined]
    return src


def test_strip_frontmatter_removes_only_a_leading_block() -> None:
    assert strip_frontmatter(ALPHA).startswith("# Alpha")
    assert strip_frontmatter("no frontmatter\n---\nnot a block\n") == "no frontmatter\n---\nnot a block\n"
    assert strip_frontmatter("---\na: 1\n---\n") == ""


def test_parse_selector_accepts_the_four_forms() -> None:
    assert parse_selector("search:tag:#project") == ("search", "tag:#project")
    assert parse_selector("base:Reading.base#Queue") == ("base", "Reading.base#Queue")
    assert parse_selector("path:Notes/Alpha.md") == ("path", "Notes/Alpha.md")
    assert parse_selector("folder:Notes/Projects") == ("folder", "Notes/Projects")


def test_parse_selector_rejects_an_unknown_prefix() -> None:
    with pytest.raises(ValueError, match="search:"):
        parse_selector("tag:#project")


def test_export_builds_items_with_body_and_frontmatter() -> None:
    src = _source({"Notes/Alpha.md": ALPHA}, {"Notes/Alpha.md": {"title": "Alpha", "tags": ["project"]}})
    items = src.export("path:Notes/Alpha.md")
    assert len(items) == 1
    item = items[0]
    assert item.source == "obsidian"
    assert item.ref == "Notes/Alpha"
    assert item.title == "Alpha"
    assert item.notes.startswith("# Alpha")
    assert item.meta == {"title": "Alpha", "tags": ["project"]}


def test_title_falls_back_to_the_basename_when_there_is_no_title_property() -> None:
    src = _source({"Notes/Some Note.md": "body only\n"})
    assert src.export("path:Notes/Some Note.md")[0].title == "Some Note"


def test_export_skips_notes_already_marked_printed() -> None:
    src = _source(
        {"a.md": "one\n", "b.md": "two\n"},
        {"a.md": {"papersync-printed": "2026-09-01"}},
    )
    assert [i.ref for i in src.export("folder:.")] == ["b"]
    assert src.skipped_printed == 1
    assert [i.ref for i in src.export("folder:.", skip_printed=False)] == ["a", "b"]
    assert src.skipped_printed == 0


def test_base_selector_splits_the_view_off_the_file() -> None:
    src = _source({"a.md": "one\n"})
    src.export("base:Reading.base#Queue")
    base_call = next(c for c in src.fake.calls if c[1] == "base:query")
    assert "file=Reading.base" in base_call and "view=Queue" in base_call


def test_search_selector_passes_the_query_through_unchanged() -> None:
    src = _source({"a.md": "one\n"})
    src.export("search:tag:#project -path:Archive")
    call = next(c for c in src.fake.calls if c[1] == "search")
    assert "query=tag:#project -path:Archive" in call


def test_lookup_returns_items_by_ref() -> None:
    src = _source({"Notes/Alpha.md": ALPHA}, {"Notes/Alpha.md": {"title": "Alpha"}})
    got = src.lookup(["Notes/Alpha"])
    assert got["Notes/Alpha"].title == "Alpha"


def test_a_missing_note_does_not_abort_the_whole_export() -> None:
    src = _source({"a.md": "one\n"})

    def runner(args: list[str]) -> str:
        if args[1] == "files":
            return "a.md\nghost.md"
        if "path=ghost.md" in args:
            return 'Error: File "ghost.md" not found.'
        return src.fake(args)

    src.cli.runner = runner
    items = src.export("folder:.")
    assert [i.ref for i in items] == ["a"]
    assert src.errors == ['read: File "ghost.md" not found.']
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd local/lib/papersync && uv run pytest tests/test_obsidian_source.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'papersync.integrations.obsidian.source'`.

- [ ] **Step 3: Write the source**

Create `src/papersync/integrations/obsidian/source.py`:

```python
"""Read notes out of an Obsidian vault through the desktop CLI."""

from pathlib import PurePosixPath
from typing import Any

from papersync.integrations.obsidian.cli import ObsidianCli, ObsidianError
from papersync.model import Item

PRINTED_PROPERTY = "papersync-printed"
KINDS = ("search", "base", "path", "folder")
FENCE = "---"


def strip_frontmatter(text: str) -> str:
    """Drop a leading ``---`` block. The file must open with the fence."""
    if not text.startswith(FENCE + "\n"):
        return text
    end = text.find(f"\n{FENCE}", len(FENCE))
    if end == -1:
        return text
    rest = text[end + len(FENCE) + 1 :]
    return rest.lstrip("\n")


def parse_selector(selector: str) -> tuple[str, str]:
    kind, _, argument = selector.partition(":")
    if kind not in KINDS or not argument:
        raise ValueError(
            f"unknown selector {selector!r}; use search:<query>, base:<file>[#view], "
            "path:<path> or folder:<path>"
        )
    return kind, argument


def _paths_from(rows: Any) -> list[str]:
    """Pull the ``path`` field out of a search or base reply."""
    if isinstance(rows, dict):
        rows = rows.get("results", rows.get("files", []))
    out = []
    for row in rows:
        path = row.get("path") if isinstance(row, dict) else row
        if isinstance(path, str) and path.endswith(".md"):
            out.append(path)
    return out


class ObsidianSource:
    name = "obsidian"

    def __init__(self, cli: ObsidianCli) -> None:
        self.cli = cli
        self.skipped_printed = 0
        self.errors: list[str] = []

    def resolve(self, selector: str) -> list[str]:
        kind, argument = parse_selector(selector)
        if kind == "path":
            return [argument]
        if kind == "folder":
            reply = self.cli.call("files", folder=argument, ext="md")
            return [line.strip() for line in reply.splitlines() if line.strip().endswith(".md")]
        if kind == "search":
            return _paths_from(self.cli.call_json("search", query=argument, format="json"))
        file_name, _, view = argument.partition("#")
        return _paths_from(
            self.cli.call_json("base:query", file=file_name, view=view or None, format="json")
        )

    def _item(self, path: str) -> Item:
        text = self.cli.call("read", path=path)
        meta = self.cli.call_json("properties", path=path, format="json") or {}
        title = str(meta.get("title") or PurePosixPath(path).stem)
        ref = path[: -len(".md")] if path.endswith(".md") else path
        return Item(
            source=self.name, ref=ref, title=title, notes=strip_frontmatter(text), meta=meta
        )

    def export(self, selector: str, skip_printed: bool = True) -> list[Item]:
        self.skipped_printed = 0
        self.errors = []
        items: list[Item] = []
        for path in self.resolve(selector):
            try:
                item = self._item(path)
            except ObsidianError as exc:
                self.errors.append(str(exc))
                continue
            if skip_printed and PRINTED_PROPERTY in item.meta:
                self.skipped_printed += 1
                continue
            items.append(item)
        return items

    def lookup(self, refs: list[str]) -> dict[str, Item]:
        out: dict[str, Item] = {}
        for ref in refs:
            try:
                out[ref] = self._item(f"{ref}.md")
            except ObsidianError as exc:
                self.errors.append(str(exc))
        return out
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd local/lib/papersync && uv run pytest tests/test_obsidian_source.py -v`
Expected: PASS, eleven tests.

- [ ] **Step 5: Commit**

```bash
git add local/lib/papersync/src/papersync/integrations/obsidian/source.py local/lib/papersync/tests/test_obsidian_source.py
git commit -m "papersync: read Obsidian notes for arbitrary vault queries"
```

---

### Task 11: The Obsidian sink

Only `mark_printed` and `check` do real work. The importer is a later project, so `apply` and `verify` refuse loudly rather than silently doing nothing.

**Files:**
- Create: `local/lib/papersync/src/papersync/integrations/obsidian/sink.py`
- Test: `local/lib/papersync/tests/test_obsidian_sink.py`

**Interfaces:**
- Consumes: `ObsidianCli`, `ObsidianError` (Task 9), `PRINTED_PROPERTY` (Task 10).
- Produces: `class ObsidianSink` with `name = "obsidian"`, `mark_printed(refs) -> list[str]`, `check() -> list[str]`, `describe(change) -> list[str]`, `warnings: list[str]`, and `apply`/`verify` raising `NotImplementedError`. Task 14 uses it.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_obsidian_sink.py`:

```python
from datetime import date

import pytest

from papersync.integrations.obsidian.cli import ObsidianCli
from papersync.integrations.obsidian.sink import ObsidianSink
from papersync.model import Change

TODAY = date(2026, 9, 12)


def _sink(replies: dict[str, str] | None = None) -> tuple[list[list[str]], ObsidianSink]:
    calls: list[list[str]] = []
    replies = replies or {}

    def runner(args: list[str]) -> str:
        calls.append(args)
        for needle, reply in replies.items():
            if any(needle in a for a in args):
                return reply
        return "ok"

    return calls, ObsidianSink(ObsidianCli("Notes", runner=runner), today=TODAY)


def test_mark_printed_sets_a_dated_property_on_each_note() -> None:
    calls, sink = _sink()
    assert sink.mark_printed(["Notes/Alpha", "Notes/Beta"]) == []
    assert calls[0] == [
        "vault=Notes",
        "property:set",
        "name=papersync-printed",
        "value=2026-09-12",
        "type=date",
        "path=Notes/Alpha.md",
    ]
    assert len(calls) == 2
    assert sink.warnings == []


def test_mark_printed_reports_the_refs_it_could_not_tag() -> None:
    calls, sink = _sink({"path=Notes/Ghost.md": 'Error: File "Notes/Ghost.md" not found.'})
    assert sink.mark_printed(["Notes/Alpha", "Notes/Ghost"]) == ["Notes/Ghost"]
    assert any("Notes/Ghost" in w for w in sink.warnings)


def test_check_reports_a_reachable_vault() -> None:
    _, sink = _sink({"vault": "Notes"})
    assert sink.check() == []


def test_check_reports_an_unreachable_vault() -> None:
    _, sink = _sink({"vault": "Error: no vault"})
    assert sink.check() == ["obsidian: no vault"]


def test_describe_names_the_note_and_its_marks() -> None:
    _, sink = _sink()
    change = Change(kind="update", source="obsidian", ref="Notes/Alpha", title="Alpha", marks=["B"])
    assert sink.describe(change) == ["mark B"]


def test_apply_and_verify_refuse_until_the_importer_exists() -> None:
    _, sink = _sink()
    with pytest.raises(NotImplementedError, match="importer"):
        sink.apply([])
    with pytest.raises(NotImplementedError, match="importer"):
        sink.verify([])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd local/lib/papersync && uv run pytest tests/test_obsidian_sink.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'papersync.integrations.obsidian.sink'`.

- [ ] **Step 3: Write the sink**

Create `src/papersync/integrations/obsidian/sink.py`:

```python
"""Write printed state back into an Obsidian vault.

Only the print side is implemented. Scanning documents back in is a later
project, so ``apply`` and ``verify`` refuse rather than quietly doing nothing.
"""

from datetime import date

from papersync.integrations.obsidian.cli import ObsidianCli, ObsidianError
from papersync.integrations.obsidian.source import PRINTED_PROPERTY
from papersync.model import Change

NOT_YET = "the Obsidian importer does not exist yet"


class ObsidianSink:
    name = "obsidian"

    def __init__(self, cli: ObsidianCli, today: date | None = None) -> None:
        self.cli = cli
        self.today = today or date.today()
        self.warnings: list[str] = []

    def describe(self, change: Change) -> list[str]:
        return [f"mark {m}" for m in change.marks]

    def mark_printed(self, refs: list[str]) -> list[str]:
        """Set the printed property on each note. Returns the refs that failed."""
        self.warnings = []
        failed: list[str] = []
        for ref in refs:
            try:
                self.cli.call(
                    "property:set",
                    name=PRINTED_PROPERTY,
                    value=self.today.isoformat(),
                    type="date",
                    path=f"{ref}.md",
                )
            except ObsidianError as exc:
                self.warnings.append(f"{ref}: {exc}")
                failed.append(ref)
        return failed

    def check(self) -> list[str]:
        try:
            self.cli.call("vault", info="name")
        except ObsidianError as exc:
            return [str(exc)]
        return []

    def apply(self, changes: list[Change]) -> None:
        raise NotImplementedError(NOT_YET)

    def verify(self, changes: list[Change]) -> list[str]:
        raise NotImplementedError(NOT_YET)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd local/lib/papersync && uv run pytest tests/test_obsidian_sink.py -v`
Expected: PASS, six tests.

- [ ] **Step 5: Commit**

```bash
git add local/lib/papersync/src/papersync/integrations/obsidian/sink.py local/lib/papersync/tests/test_obsidian_sink.py
git commit -m "papersync: mark Obsidian notes printed with a frontmatter property"
```

---

### Task 12: The bridge plugin and its installer

`require("obsidian")` fails inside `obsidian eval`, because Obsidian injects that module only into plugin sandboxes. A plugin is therefore the only way to reach `MarkdownRenderer`. The plugin is plain CommonJS so this repository needs no npm.

**Files:**
- Create: `local/lib/papersync/src/papersync/integrations/obsidian/bridge/manifest.json`
- Create: `local/lib/papersync/src/papersync/integrations/obsidian/bridge/main.js`
- Create: `local/lib/papersync/src/papersync/integrations/obsidian/bridge/page.css`
- Create: `local/lib/papersync/src/papersync/integrations/obsidian/bridge.py`
- Modify: `local/lib/papersync/pyproject.toml`
- Modify: `script/test`
- Test: `local/lib/papersync/tests/test_obsidian_bridge.py`

**Interfaces:**
- Consumes: `ObsidianCli`, `ObsidianError` (Task 9), `papersync.__version__`.
- Produces:
  - `BRIDGE_ID = "papersync-bridge"`, `BRIDGE_SRC: Path`.
  - `install(cli: ObsidianCli, vault_path: Path) -> Path`.
  - `installed_version(cli: ObsidianCli) -> str | None`.
  - `vault_path(cli: ObsidianCli) -> Path`.
  - `render(cli: ObsidianCli, spec: dict, spec_path: Path) -> int` returning the page count.
  - Tasks 13 and 14 use these.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_obsidian_bridge.py`:

```python
import json
from pathlib import Path

import pytest

from papersync import __version__
from papersync.integrations.obsidian import bridge
from papersync.integrations.obsidian.cli import ObsidianCli, ObsidianError


def test_the_shipped_manifest_matches_the_package_version() -> None:
    manifest = json.loads((bridge.BRIDGE_SRC / "manifest.json").read_text())
    assert manifest["id"] == bridge.BRIDGE_ID
    assert manifest["version"] == __version__
    assert manifest["isDesktopOnly"] is True


def test_the_bridge_ships_all_three_files() -> None:
    for name in ("manifest.json", "main.js", "page.css"):
        assert (bridge.BRIDGE_SRC / name).is_file()


def test_page_css_reserves_the_chrome_band_from_the_layout() -> None:
    from papersync.render.templates.v1 import layout as L  # noqa: N812

    css = (bridge.BRIDGE_SRC / "page.css").read_text()
    assert f"{L.TOP_MM}mm {L.MARGIN_MM}mm {L.BOTTOM_MM}mm {L.MARGIN_MM}mm" in css


def test_install_copies_the_files_and_enables_the_plugin(tmp_path: Path) -> None:
    calls: list[list[str]] = []

    def runner(args: list[str]) -> str:
        calls.append(args)
        return str(tmp_path) if args[1] == "vault" else "ok"

    cli = ObsidianCli("Notes", runner=runner)
    target = bridge.install(cli, tmp_path)
    assert target == tmp_path / ".obsidian" / "plugins" / bridge.BRIDGE_ID
    assert (target / "main.js").is_file()
    assert (target / "manifest.json").is_file()
    assert (target / "page.css").is_file()
    assert ["vault=Notes", "plugin:enable", f"id={bridge.BRIDGE_ID}"] in calls


def test_install_overwrites_a_stale_copy(tmp_path: Path) -> None:
    target = tmp_path / ".obsidian" / "plugins" / bridge.BRIDGE_ID
    target.mkdir(parents=True)
    (target / "main.js").write_text("stale")
    bridge.install(ObsidianCli("Notes", runner=lambda a: "ok"), tmp_path)
    assert (target / "main.js").read_text() != "stale"


def test_installed_version_reads_the_running_bridge() -> None:
    cli = ObsidianCli("Notes", runner=lambda a: f"=> {__version__}")
    assert bridge.installed_version(cli) == __version__


def test_installed_version_is_none_when_the_bridge_is_absent() -> None:
    cli = ObsidianCli("Notes", runner=lambda a: "=> undefined")
    assert bridge.installed_version(cli) is None


def test_render_returns_the_page_count(tmp_path: Path) -> None:
    spec_path = tmp_path / "spec.json"
    cli = ObsidianCli("Notes", runner=lambda a: '=> {"ok": true, "pages": 3}')
    assert bridge.render(cli, {"path": "a.md"}, spec_path) == 3
    assert json.loads(spec_path.read_text())["path"] == "a.md"


def test_render_raises_when_the_bridge_reports_failure(tmp_path: Path) -> None:
    cli = ObsidianCli("Notes", runner=lambda a: '=> {"ok": false, "error": "no such file"}')
    with pytest.raises(ObsidianError, match="no such file"):
        bridge.render(cli, {"path": "a.md"}, tmp_path / "spec.json")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd local/lib/papersync && uv run pytest tests/test_obsidian_bridge.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'papersync.integrations.obsidian.bridge'`.

- [ ] **Step 3a: Write the plugin manifest**

Create `src/papersync/integrations/obsidian/bridge/manifest.json`. Read the current version out of `src/papersync/__init__.py` and use it verbatim:

```json
{
  "id": "papersync-bridge",
  "name": "papersync bridge",
  "version": "0.1.0",
  "minAppVersion": "1.5.0",
  "description": "Renders notes to PDF for papersync. Installed and driven by the papersync CLI.",
  "author": "papersync",
  "isDesktopOnly": true
}
```

- [ ] **Step 3b: Write the page stylesheet**

Create `src/papersync/integrations/obsidian/bridge/page.css`:

```css
/* The @page margins reserve the band that papersync stamps chrome into.
   They must match layout.py: TOP_MM, MARGIN_MM, BOTTOM_MM, MARGIN_MM. */
@page {
  size: 215.9mm 279.4mm;
  margin: 22.0mm 12.0mm 27.0mm 12.0mm;
}

body {
  margin: 0;
  font-family: "New Computer Modern", Georgia, serif;
  font-size: 10pt;
  line-height: 1.45;
  color: #000;
}

table.papersync-frontmatter {
  width: 100%;
  border-collapse: collapse;
  margin: 0 0 6mm 0;
  font-size: 8pt;
}

table.papersync-frontmatter th,
table.papersync-frontmatter td {
  border: 0.3pt solid #999;
  padding: 1mm 1.5mm;
  text-align: left;
  vertical-align: top;
}

table.papersync-frontmatter th {
  width: 28%;
  background: #eee;
  font-weight: 600;
}

table.papersync-frontmatter ul {
  margin: 0;
  padding-left: 4mm;
}

.papersync-body img {
  max-width: 100%;
}

.papersync-body pre {
  white-space: pre-wrap;
  word-wrap: break-word;
}

.papersync-body h1,
.papersync-body h2,
.papersync-body h3 {
  break-after: avoid;
}

.papersync-body .task-list-item-checkbox {
  appearance: none;
  width: 3mm;
  height: 3mm;
  border: 0.4pt solid #000;
  margin-right: 1.5mm;
  vertical-align: middle;
}
```

- [ ] **Step 3c: Write the plugin**

Create `src/papersync/integrations/obsidian/bridge/main.js`:

```js
"use strict";

// papersync bridge. Renders one note to PDF with Obsidian's own renderer.
//
// require("obsidian") only resolves inside a plugin sandbox, which is the
// entire reason this plugin exists: the papersync CLI cannot reach
// MarkdownRenderer from `obsidian eval` on its own.

const obsidian = require("obsidian");
const fs = require("fs");
const path = require("path");

const MM_PER_INCH = 25.4;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function valueCell(value) {
  if (Array.isArray(value)) {
    const items = value.map((v) => `<li>${escapeHtml(v)}</li>`).join("");
    return `<ul>${items}</ul>`;
  }
  if (value === null || value === undefined) return "";
  return escapeHtml(value);
}

function frontmatterTable(pairs) {
  if (!pairs || pairs.length === 0) return "";
  const rows = pairs
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${valueCell(value)}</td></tr>`)
    .join("");
  return `<table class="papersync-frontmatter"><tbody>${rows}</tbody></table>`;
}

function pageStyle(spec, css) {
  const p = spec.page;
  const m = spec.margins_mm;
  const rule = `@page { size: ${p.width_mm}mm ${p.height_mm}mm; margin: ${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm; }`;
  return `${rule}\n${css}`;
}

async function renderBody(app, file) {
  const markdown = await app.vault.cachedRead(file);
  const container = createDiv();
  container.addClass("papersync-body");
  const component = new obsidian.Component();
  try {
    await obsidian.MarkdownRenderer.render(app, markdown, container, file.path, component);
  } finally {
    component.unload();
  }
  return container.innerHTML;
}

async function printHtml(html, spec) {
  const { remote } = require("electron");
  const win = new remote.BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    const buffer = await win.webContents.printToPDF({
      preferCSSPageSize: true,
      printBackground: true,
      scale: 1,
      pageSize: {
        width: spec.page.width_mm / MM_PER_INCH,
        height: spec.page.height_mm / MM_PER_INCH,
      },
    });
    fs.writeFileSync(spec.out, buffer);
    return buffer.length;
  } finally {
    win.destroy();
  }
}

class PapersyncBridge extends obsidian.Plugin {
  async onload() {
    const css = fs.readFileSync(
      path.join(this.app.vault.adapter.getBasePath(), this.manifest.dir, "page.css"),
      "utf8"
    );
    const self = this;
    window.papersync = {
      version: this.manifest.version,
      async renderFile(specPath) {
        try {
          const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
          const file = self.app.vault.getAbstractFileByPath(spec.path);
          if (!file) throw new Error(`no such note: ${spec.path}`);
          const body = await renderBody(self.app, file);
          const html =
            `<!doctype html><html><head><meta charset="utf-8">` +
            `<style>${pageStyle(spec, css)}</style></head><body>` +
            frontmatterTable(spec.frontmatter) +
            `<div class="papersync-body">${body}</div>` +
            `</body></html>`;
          const bytes = await printHtml(html, spec);
          const pdf = require("fs").readFileSync(spec.out);
          const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
          return JSON.stringify({ ok: true, pages: Math.max(pages, 1), bytes });
        } catch (err) {
          return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
        }
      },
    };
  }

  onunload() {
    delete window.papersync;
  }
}

module.exports = PapersyncBridge;
```

- [ ] **Step 3d: Write the installer**

Create `src/papersync/integrations/obsidian/bridge.py`:

```python
"""Install and drive the papersync bridge plugin."""

import json
import shutil
from pathlib import Path

from papersync import __version__
from papersync.integrations.obsidian.cli import ObsidianCli, ObsidianError

BRIDGE_ID = "papersync-bridge"
BRIDGE_SRC = Path(__file__).parent / "bridge"
FILES = ("manifest.json", "main.js", "page.css")


def vault_path(cli: ObsidianCli) -> Path:
    return Path(cli.call("vault", info="path"))


def install(cli: ObsidianCli, vault: Path) -> Path:
    target = vault / ".obsidian" / "plugins" / BRIDGE_ID
    target.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        shutil.copyfile(BRIDGE_SRC / name, target / name)
    cli.call("plugin:enable", id=BRIDGE_ID)
    return target


def installed_version(cli: ObsidianCli) -> str | None:
    reply = cli.evaluate("(window.papersync && window.papersync.version) || 'undefined'").strip()
    return None if reply in {"undefined", "null", ""} else reply


def require_bridge(cli: ObsidianCli) -> None:
    version = installed_version(cli)
    if version is None:
        raise ObsidianError(
            "the papersync bridge is not installed; run: papersync obsidian install-bridge"
        )
    if version != __version__:
        raise ObsidianError(
            f"the papersync bridge is version {version} but papersync is {__version__}; "
            "run: papersync obsidian install-bridge"
        )


def render(cli: ObsidianCli, spec: dict, spec_path: Path) -> int:
    """Render one note. Returns the page count of the written PDF."""
    spec_path.parent.mkdir(parents=True, exist_ok=True)
    spec_path.write_text(json.dumps(spec))
    reply = cli.evaluate(f'window.papersync.renderFile("{spec_path}")')
    try:
        result = json.loads(reply)
    except ValueError as exc:
        raise ObsidianError(f"the bridge returned unreadable output: {reply[:120]!r}") from exc
    if not result.get("ok"):
        raise ObsidianError(f"the bridge failed: {result.get('error', 'unknown error')}")
    return int(result["pages"])
```

- [ ] **Step 3e: Ship the plugin in the wheel and lint it**

In `local/lib/papersync/pyproject.toml`, extend the artifacts line:

```toml
artifacts = ["**/*.otf", "**/*.typ", "**/*.js", "**/*.json", "**/*.css"]
```

In `script/test`, add a bridge syntax check. Place it beside the existing shellcheck block, following the same style the file already uses for optional tools:

```sh
if command -v node >/dev/null 2>&1; then
  echo "==> node --check (obsidian bridge)"
  node --check local/lib/papersync/src/papersync/integrations/obsidian/bridge/main.js
else
  echo "==> node not installed, skipping bridge syntax check"
fi
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd local/lib/papersync && uv run pytest tests/test_obsidian_bridge.py -v`
Expected: PASS, nine tests. If the version test fails, copy the value of `__version__` from `src/papersync/__init__.py` into `manifest.json`.

Then run: `./script/test` from the repository root.
Expected: the bridge syntax check reports no error.

- [ ] **Step 5: Commit**

```bash
git add local/lib/papersync/src/papersync/integrations/obsidian/bridge.py local/lib/papersync/src/papersync/integrations/obsidian/bridge/ local/lib/papersync/pyproject.toml local/lib/papersync/tests/test_obsidian_bridge.py script/test
git commit -m "papersync: add the Obsidian bridge plugin and its installer"
```

---

### Task 13: Documents, slugs and the output directory

One PDF per note in a stamped directory, plus a manifest. Separate print jobs are what give duplex-for-continuations without any blank-page padding.

**Files:**
- Create: `local/lib/papersync/src/papersync/integrations/obsidian/documents.py`
- Test: `local/lib/papersync/tests/test_obsidian_documents.py`

**Interfaces:**
- Consumes: `Item.meta` (Task 2), `chrome.stamp` (Task 6), `bridge.render` (Task 12), `ObsidianCli` (Task 9), `L` geometry.
- Produces:
  - `slug(name: str) -> str`.
  - `frontmatter_pairs(meta: dict, skip: list[str]) -> list[list]`.
  - `build_spec(item, out_path, size, skip) -> dict`.
  - `@dataclass RenderedDocument(item: Item, pdf: bytes, pages: int, size: str)`.
  - `render_documents(cli, items, size, labels, boxes_id, skip, today, workdir) -> list[RenderedDocument]`.
  - `write_documents(docs, out_dir, stamp, vault) -> tuple[Path, list[Path]]`.
  - Task 14 calls `render_documents` and `write_documents`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_obsidian_documents.py`:

```python
import json
from datetime import date
from pathlib import Path

import pymupdf

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
    pairs = D.frontmatter_pairs({"title": "A", "papersync-printed": "d", "tags": ["x"]},
                                ["papersync-printed"])
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

    def fake_render(cli, spec, spec_path):  # noqa: ANN001
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd local/lib/papersync && uv run pytest tests/test_obsidian_documents.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'papersync.integrations.obsidian.documents'`.

- [ ] **Step 3: Write the module**

Create `src/papersync/integrations/obsidian/documents.py`:

```python
"""Turn Obsidian notes into stamped PDFs, one file per note.

One PDF per document is what makes duplex printing work for continuation pages
only: separate print jobs start each document on a sheet front, so no
blank-page padding is needed.
"""

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

import pymupdf

from papersync.integrations.obsidian import bridge
from papersync.model import Item
from papersync.payload import Payload
from papersync.render import chrome
from papersync.render.templates.v1 import layout as L  # noqa: N812

SLUG_MAX = 60
MANIFEST = "manifest.json"


def slug(name: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return (cleaned[:SLUG_MAX].rstrip("-")) or "note"


def frontmatter_pairs(meta: dict[str, Any], skip: list[str]) -> list[list[Any]]:
    return [[k, v] for k, v in meta.items() if k not in skip]


def build_spec(item: Item, out_path: Path, size: L.PageSize, skip: list[str]) -> dict[str, Any]:
    return {
        "papersync_spec": 1,
        "path": f"{item.ref}.md",
        "out": str(out_path),
        "page": {"width_mm": size.width, "height_mm": size.height},
        "margins_mm": {
            "top": L.TOP_MM,
            "right": L.MARGIN_MM,
            "bottom": L.BOTTOM_MM,
            "left": L.MARGIN_MM,
        },
        "frontmatter": frontmatter_pairs(item.meta, skip),
    }


@dataclass
class RenderedDocument:
    item: Item
    pdf: bytes
    pages: int
    size: str


def render_documents(
    cli: Any,
    items: list[Item],
    size: L.PageSize,
    labels: list[str],
    boxes_id: int,
    skip: list[str],
    today: date,
    workdir: Path,
    renderer: Callable[..., int] | None = None,
) -> list[RenderedDocument]:
    """Render each note through the bridge, then stamp chrome onto the result.

    ``renderer`` is resolved here rather than as a default argument, so a test
    can replace ``bridge.render`` on the module and have this call see it.
    """
    renderer = renderer or bridge.render
    workdir.mkdir(parents=True, exist_ok=True)
    out: list[RenderedDocument] = []
    for index, item in enumerate(items, start=1):
        body_path = workdir / f"{index:03d}-body.pdf"
        spec = build_spec(item, body_path, size, skip)
        renderer(cli, spec, workdir / f"{index:03d}-spec.json")
        body = body_path.read_bytes()
        # The bridge reports a page count too, but pymupdf is authoritative.
        pages = pymupdf.open("pdf", body).page_count
        payloads = [
            Payload(L.TEMPLATE_VERSION, item.source, item.ref, size.name, boxes_id, p, pages)
            for p in range(1, pages + 1)
        ]
        stamped = chrome.stamp(body, size, labels, item.title, today.isoformat(), payloads)
        out.append(RenderedDocument(item, stamped, pages, size.name))
    return out


def write_documents(
    docs: list[RenderedDocument], out_dir: Path, stamp: str, vault: str
) -> tuple[Path, list[Path]]:
    target = out_dir / f"papersync-{stamp}"
    target.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    entries: list[dict[str, Any]] = []
    for index, doc in enumerate(docs, start=1):
        name = f"{index:03d}-{slug(doc.item.title)}.pdf"
        path = target / name
        path.write_bytes(doc.pdf)
        paths.append(path)
        entries.append(
            {
                "index": index,
                "file": name,
                "ref": doc.item.ref,
                "path": f"{doc.item.ref}.md",
                "title": doc.item.title,
                "pages": doc.pages,
                "size": doc.size,
            }
        )
    manifest = {
        "papersync_manifest": 1,
        "created": datetime.now().isoformat(timespec="seconds"),
        "vault": vault,
        "source": "obsidian",
        "documents": entries,
    }
    (target / MANIFEST).write_text(json.dumps(manifest, indent=2))
    return target, paths
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd local/lib/papersync && uv run pytest tests/test_obsidian_documents.py -v`
Expected: PASS, six tests.

- [ ] **Step 5: Commit**

```bash
git add local/lib/papersync/src/papersync/integrations/obsidian/documents.py local/lib/papersync/tests/test_obsidian_documents.py
git commit -m "papersync: write one stamped PDF per Obsidian note with a manifest"
```

---

### Task 14: Wire up the CLI

Add the `obsidian` command group, make printed-state tagging dispatch by source, and extend `doctor`.

**Files:**
- Modify: `local/lib/papersync/src/papersync/cli.py`
- Test: `local/lib/papersync/tests/test_cli.py`

**Interfaces:**
- Consumes: everything from Tasks 9 to 13.
- Produces: `papersync obsidian export|print|install-bridge`, and a `_sinks(cfg)` mapping used by `_do_render`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_cli.py`. Match the invocation style the file already uses for the Things commands:

```python
def test_obsidian_export_emits_items_json(monkeypatch, tmp_path) -> None:
    from click.testing import CliRunner

    from papersync import cli as C  # noqa: N812
    from papersync.model import Item

    class FakeSource:
        name = "obsidian"
        skipped_printed = 1
        errors: list[str] = []

        def __init__(self, *_a, **_k) -> None:
            pass

        def export(self, selector: str, skip_printed: bool = True) -> list[Item]:
            assert selector == "search:tag:#project"
            return [Item(source="obsidian", ref="Notes/Alpha", title="Alpha", meta={"a": 1})]

    monkeypatch.setattr(C, "ObsidianSource", FakeSource)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    result = CliRunner().invoke(C.main, ["obsidian", "export", "search:tag:#project"])
    assert result.exit_code == 0, result.output
    assert '"ref": "Notes/Alpha"' in result.output
    assert '"meta"' in result.output


def test_obsidian_print_rejects_auto_size(monkeypatch, tmp_path) -> None:
    from click.testing import CliRunner

    from papersync import cli as C  # noqa: N812

    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    result = CliRunner().invoke(
        C.main, ["obsidian", "print", "path:Notes/Alpha.md", "--size", "auto"]
    )
    assert result.exit_code != 0
    assert "auto" in result.output


def test_obsidian_print_needs_a_configured_vault(monkeypatch, tmp_path) -> None:
    from click.testing import CliRunner

    from papersync import cli as C  # noqa: N812

    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    result = CliRunner().invoke(C.main, ["obsidian", "print", "path:Notes/Alpha.md"])
    assert result.exit_code != 0
    assert "vault" in result.output


def test_obsidian_print_writes_a_directory_of_pdfs(monkeypatch, tmp_path) -> None:
    import json

    from click.testing import CliRunner

    from papersync import cli as C  # noqa: N812
    from papersync.integrations.obsidian import documents as D  # noqa: N812
    from papersync.model import Item
    from papersync.render import chrome
    from papersync.render.templates.v1 import layout as L  # noqa: N812

    config = tmp_path / "papersync"
    config.mkdir(parents=True)
    (config / "config.toml").write_text('[obsidian]\nvault = "Notes"\n[render]\nopen = false\n')
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))

    class FakeSource:
        name = "obsidian"
        skipped_printed = 0
        errors: list[str] = []

        def __init__(self, *_a, **_k) -> None:
            pass

        def export(self, selector: str, skip_printed: bool = True) -> list[Item]:
            return [Item(source="obsidian", ref="Notes/Alpha", title="Alpha")]

    tagged: list[list[str]] = []

    class FakeSink:
        name = "obsidian"
        warnings: list[str] = []

        def __init__(self, *_a, **_k) -> None:
            pass

        def mark_printed(self, refs: list[str]) -> list[str]:
            tagged.append(refs)
            return []

    def fake_render(cli, spec, spec_path):  # noqa: ANN001
        from pathlib import Path

        Path(spec["out"]).write_bytes(chrome.blank(L.SIZES["letter"], 2))
        return 2

    monkeypatch.setattr(C, "ObsidianSource", FakeSource)
    monkeypatch.setattr(C, "ObsidianSink", FakeSink)
    monkeypatch.setattr(C, "require_bridge", lambda cli: None)
    monkeypatch.setattr(D.bridge, "render", fake_render)

    out = tmp_path / "out"
    result = CliRunner().invoke(
        C.main, ["obsidian", "print", "path:Notes/Alpha.md", "-o", str(out)]
    )
    assert result.exit_code == 0, result.output

    directories = list(out.glob("papersync-*"))
    assert len(directories) == 1
    pdfs = sorted(p.name for p in directories[0].glob("*.pdf"))
    assert pdfs == ["001-alpha.pdf"]
    manifest = json.loads((directories[0] / "manifest.json").read_text())
    assert manifest["documents"][0]["pages"] == 2
    assert tagged == [["Notes/Alpha"]]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd local/lib/papersync && uv run pytest tests/test_cli.py -v -k obsidian`
Expected: FAIL. `papersync obsidian` is not a command, and `C.ObsidianSource` does not exist.

- [ ] **Step 3: Add the command group**

In `cli.py`, add these imports beside the existing Things imports:

```python
from papersync.integrations.obsidian import documents as odocs
from papersync.integrations.obsidian.bridge import install, installed_version, require_bridge
from papersync.integrations.obsidian.bridge import vault_path as bridge_vault_path
from papersync.integrations.obsidian.cli import ObsidianCli, ObsidianError
from papersync.integrations.obsidian.sink import ObsidianSink
from papersync.integrations.obsidian.source import ObsidianSource
```

Add a helper that builds the CLI wrapper and refuses without a vault:

```python
def _obsidian(cfg: Config) -> ObsidianCli:
    if not cfg.obsidian.vault:
        raise click.ClickException(
            'no Obsidian vault configured; set [obsidian] vault = "<name>" in config.toml'
        )
    return ObsidianCli(cfg.obsidian.vault)
```

Make printed-state tagging dispatch by source. Replace the Things-only tagging block at the end of `_do_render` with a call to this helper, and add the helper above `_do_render`:

```python
def _sinks(cfg: Config) -> dict[str, Any]:
    sinks: dict[str, Any] = {"things": lambda: _sink(cfg)}
    if cfg.obsidian.vault:
        sinks["obsidian"] = lambda: ObsidianSink(ObsidianCli(cfg.obsidian.vault))
    return sinks


def _tag_printed(cfg: Config, refs_by_source: dict[str, list[str]]) -> None:
    for source, refs in refs_by_source.items():
        factory = _sinks(cfg).get(source)
        if factory is None or not refs:
            continue
        sink = factory()
        try:
            untagged = sink.mark_printed(refs)
        except (RuntimeError, ObsidianError) as exc:
            raise click.ClickException(str(exc)) from exc
        for warning in sink.warnings:
            _err(f"WARNING: {warning}")
        for ref in untagged:
            _err(f"NOT TAGGED: {ref}")
        _err(f"tagged {len(refs) - len(untagged)} {source} item(s) printed")
```

In `_do_render`, replace the final block that starts `things_refs = [...]` with:

```python
    if tag:
        by_source: dict[str, list[str]] = {}
        for r in rendered:
            if r.item is not None:
                by_source.setdefault(r.item.source, []).append(r.item.ref)
        _tag_printed(cfg, by_source)
    return paths
```

Add the command group at the end of the file, before `if __name__ == "__main__":`:

```python
@main.group()
def obsidian() -> None:
    """Obsidian integration."""


_OBSIDIAN_SELECTOR = click.argument("selector")


@obsidian.command("export")
@_OBSIDIAN_SELECTOR
@_SKIP_PRINTED
def obsidian_export(selector: str, skip_printed: bool) -> None:
    """Export notes as JSON: search:<query> | base:<file>[#view] | path:<p> | folder:<p>."""
    cfg = load_config()
    source = ObsidianSource(_obsidian(cfg))
    try:
        items = source.export(selector, skip_printed=skip_printed)
    except (ValueError, ObsidianError) as exc:
        raise click.ClickException(str(exc)) from exc
    for message in source.errors:
        _err(f"WARNING: {message}")
    if source.skipped_printed:
        _err(
            f"skipped {source.skipped_printed} note(s) already marked papersync-printed"
            " (use --no-skip-printed to include them)"
        )
    click.echo(json.dumps([i.model_dump() for i in items], indent=2))


@obsidian.command("install-bridge")
def obsidian_install_bridge() -> None:
    """Copy the papersync bridge plugin into the vault and enable it."""
    cli = _obsidian(load_config())
    try:
        target = install(cli, bridge_vault_path(cli))
    except ObsidianError as exc:
        raise click.ClickException(str(exc)) from exc
    _err(f"installed {target}")
    _err("reload Obsidian if the bridge does not answer yet")


@obsidian.command("print")
@_OBSIDIAN_SELECTOR
@_SKIP_PRINTED
@_render_common
def obsidian_print(
    selector: str,
    skip_printed: bool,
    size: str | None,
    overflow: str | None,
    boxes: str | None,
    new: int,
    output_dir: str | None,
    open_pdf: bool | None,
    tag: bool | None,
) -> None:
    """Render an Obsidian selector to one PDF per note."""
    cfg = load_config()
    chosen = size or "letter"
    if chosen == "auto":
        raise click.ClickException("auto sizing is meaningless for documents; use --size letter")
    if new:
        raise click.ClickException("--new is a Things card option and does not apply to documents")
    page_size = L.SIZES[chosen]
    opts = _render_options(cfg, chosen, "paginate", boxes)
    cli = _obsidian(cfg)
    source = ObsidianSource(cli)
    try:
        require_bridge(cli)
        items = source.export(selector, skip_printed=skip_printed)
    except (ValueError, ObsidianError) as exc:
        raise click.ClickException(str(exc)) from exc
    for message in source.errors:
        _err(f"WARNING: {message}")
    if source.skipped_printed:
        _err(f"skipped {source.skipped_printed} note(s) already marked papersync-printed")
    if not items:
        _err("nothing to print")
        return

    today = date.today()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    with tempfile.TemporaryDirectory(prefix="papersync-") as work:
        try:
            docs = odocs.render_documents(
                cli,
                items,
                page_size,
                opts.labels,
                opts.boxes_id,
                cfg.obsidian.frontmatter_skip,
                today,
                Path(work),
            )
        except ObsidianError as exc:
            raise click.ClickException(str(exc)) from exc
    out_dir, paths = odocs.write_documents(
        docs, Path(output_dir or cfg.render.output_dir), stamp, cfg.obsidian.vault
    )

    ledger = _ledger()
    for doc, path in zip(docs, paths, strict=True):
        ledger.record(
            LedgerEntry(
                ts=datetime.now(),
                event="render",
                source=doc.item.source,
                ref=doc.item.ref,
                title=doc.item.title,
                size=doc.size,
                boxes=opts.boxes_id,
                file=str(path),
            )
        )
    _err(f"wrote {len(paths)} document(s) to {out_dir}")
    _err(f'print with: for f in "{out_dir}"/*.pdf; do lpr -o sides=two-sided-long-edge "$f"; done')
    should_open = cfg.render.open if open_pdf is None else open_pdf
    if should_open:
        subprocess.run(["open", str(out_dir)], check=False)
    if cfg.render.tag if tag is None else tag:
        _tag_printed(cfg, {"obsidian": [d.item.ref for d in docs]})
```

Add `import tempfile` to the imports at the top of the file.

Extend `doctor`. Insert this block before the final `if not ok:` check:

```python
    cfg = load_config()
    if not cfg.obsidian.vault:
        report("Obsidian vault", "not configured (the obsidian commands are unavailable)")
    else:
        cli = ObsidianCli(cfg.obsidian.vault)
        try:
            cli.call("vault", info="name")
            report("Obsidian app", None)
        except ObsidianError as exc:
            report("Obsidian app", str(exc))
        try:
            version = installed_version(cli)
            if version is None:
                report("papersync bridge", "not installed (papersync obsidian install-bridge)")
            elif version != __version__:
                report("papersync bridge", f"version {version}, expected {__version__}")
            else:
                report("papersync bridge", None)
        except ObsidianError as exc:
            report("papersync bridge", str(exc))
```

The "not configured" case must not fail `doctor`. Change `report` so a caller can flag an advisory:

```python
    def report(name: str, problem: str | None, fatal: bool = True) -> None:
        nonlocal ok
        status = "ok  " if problem is None else ("FAIL" if fatal else "warn")
        detail = "" if problem is None else f": {problem}"
        click.echo(f"{status} {name}{detail}")
        ok = ok and (problem is None or not fatal)
```

and pass `fatal=False` for the "not configured" and "not installed" reports.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd local/lib/papersync && uv run pytest tests/test_cli.py -v`
Expected: PASS, including the four new tests and every existing Things test.

Then run: `cd local/lib/papersync && uv run pytest -q && uv run ruff check && uv run ruff format --check`
Expected: PASS and no lint findings.

- [ ] **Step 5: Commit**

```bash
git add local/lib/papersync/src/papersync/cli.py local/lib/papersync/tests/test_cli.py
git commit -m "papersync: add the obsidian command group"
```

---

### Task 15: Documentation and the live integration test

The default suite never touches Obsidian. One opt-in test does, mirroring how `PAPERSYNC_REAL_OCR=1` gates the real OCR test.

**Files:**
- Create: `local/lib/papersync/tests/test_obsidian_real.py`
- Modify: `local/lib/papersync/README.md`
- Modify: `config/papersync/config.toml`

**Interfaces:**
- Consumes: everything.
- Produces: documentation and one gated test.

- [ ] **Step 1: Write the gated test**

Create `tests/test_obsidian_real.py`:

```python
"""Live test against a running Obsidian. Skipped unless PAPERSYNC_REAL_OBSIDIAN=1.

Run it with:

    PAPERSYNC_REAL_OBSIDIAN=1 PAPERSYNC_REAL_VAULT=Notes \
        uv run pytest tests/test_obsidian_real.py -q
"""

import os
from datetime import date
from pathlib import Path

import pytest

from papersync.integrations.obsidian import documents as D  # noqa: N812
from papersync.integrations.obsidian.bridge import install, installed_version, vault_path
from papersync.integrations.obsidian.cli import ObsidianCli
from papersync.integrations.obsidian.source import ObsidianSource
from papersync.render.templates.v1 import layout as L  # noqa: N812

pytestmark = pytest.mark.skipif(
    os.environ.get("PAPERSYNC_REAL_OBSIDIAN") != "1",
    reason="set PAPERSYNC_REAL_OBSIDIAN=1 to run against a live Obsidian",
)


@pytest.fixture
def cli() -> ObsidianCli:
    vault = os.environ.get("PAPERSYNC_REAL_VAULT")
    if not vault:
        pytest.skip("set PAPERSYNC_REAL_VAULT to the vault name")
    return ObsidianCli(vault)


def test_the_bridge_installs_and_answers(cli: ObsidianCli) -> None:
    install(cli, vault_path(cli))
    assert installed_version(cli) is not None


def test_one_real_note_renders_and_stamps(cli: ObsidianCli, tmp_path: Path) -> None:
    install(cli, vault_path(cli))
    source = ObsidianSource(cli)
    notes = source.export("folder:.", skip_printed=False)
    if not notes:
        pytest.skip("the vault has no notes")

    docs = D.render_documents(
        cli,
        notes[:1],
        L.SIZES["letter"],
        ["A", "B"],
        1,
        ["papersync-printed"],
        date.today(),
        tmp_path,
    )
    assert docs[0].pages >= 1
    out_dir, paths = D.write_documents(docs, tmp_path / "out", "live", cli.vault)
    assert paths[0].stat().st_size > 1000
    assert (out_dir / "manifest.json").is_file()
```

- [ ] **Step 2: Run it both ways**

Run: `cd local/lib/papersync && uv run pytest tests/test_obsidian_real.py -q`
Expected: two tests SKIPPED.

Run with Obsidian open: `cd local/lib/papersync && PAPERSYNC_REAL_OBSIDIAN=1 PAPERSYNC_REAL_VAULT=Notes uv run pytest tests/test_obsidian_real.py -q`
Expected: PASS. If the bridge does not answer immediately after install, restart Obsidian with `obsidian restart` and rerun.

- [ ] **Step 3: Document the round trip**

Add this section to `local/lib/papersync/README.md`, after the existing "Round trip" section:

````markdown
## Obsidian documents

papersync also prints Obsidian notes. A note is a document, not a task, so it
prints without a primary checkbox, and each note becomes its own PDF.

Set the vault in `~/.config/papersync/config.toml`:

```toml
[obsidian]
vault = "Notes"
```

Install the bridge plugin once. papersync never writes to the vault on its own:

```
papersync obsidian install-bridge
```

Then print. The selector takes four forms:

```
papersync obsidian print 'search:tag:#project -path:Archive'
papersync obsidian print 'base:Reading.base#Queue'
papersync obsidian print 'path:Notes/Projects/Alpha.md'
papersync obsidian print 'folder:Notes/Projects'
```

`search:` passes the query straight to Obsidian, so the whole search grammar
works: `tag:`, `path:`, `file:`, `line:` and `[property]`.

The output is one directory of PDFs plus a manifest:

```
out/papersync-20260912-101500/
├── 001-project-alpha.pdf
├── 002-reading-queue.pdf
└── manifest.json
```

Print them duplex. Separate jobs start each document on a sheet front, so
continuation pages land on the backs and nothing is padded:

```
for f in out/papersync-*/*.pdf; do lpr -o sides=two-sided-long-edge "$f"; done
```

Obsidian renders the body with its own renderer, so wikilinks, embeds, block
references, callouts and math all print the way they look on screen. papersync
draws the corner squares, the QR code and the checkboxes onto the finished PDF,
so the marks sit at exact millimetre positions no matter how Obsidian paginated.

`print` marks each note with a `papersync-printed` date property, and skips
notes that already carry it. Pass `--no-skip-printed` to include them.

Scanning documents back in is not implemented yet.

### Live test

`tests/test_obsidian_real.py` drives a running Obsidian. It is skipped unless
you set both variables:

```
PAPERSYNC_REAL_OBSIDIAN=1 PAPERSYNC_REAL_VAULT=Notes uv run pytest tests/test_obsidian_real.py -q
```
````

- [ ] **Step 4: Document the configuration**

Append to `config/papersync/config.toml`:

```toml
# Obsidian. The vault name is what `obsidian vaults` lists.
# papersync needs Obsidian running, and the bridge plugin installed with
# `papersync obsidian install-bridge`.
[obsidian]
vault = ""
# Front matter keys that do not print in the document's property table.
frontmatter_skip = ["papersync-printed"]
```

- [ ] **Step 5: Run the full check and commit**

Run: `./script/test` from the repository root.
Expected: PASS, with the bridge syntax check reporting no error.

```bash
git add local/lib/papersync/tests/test_obsidian_real.py local/lib/papersync/README.md config/papersync/config.toml
git commit -m "papersync: document the Obsidian document workflow"
```
