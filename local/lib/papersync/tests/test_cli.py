import json
from datetime import datetime
from pathlib import Path

from click.testing import CliRunner

from papersync.cli import main
from papersync.model import Change, Plan, PlanError
from tests import synthetic
from tests.things_fixture import make_db


def _env(tmp_path: Path) -> dict[str, str]:
    cfg = tmp_path / "cfg"
    state = tmp_path / "state"
    cfg.mkdir()
    (cfg / "papersync").mkdir()
    (cfg / "papersync" / "config.toml").write_text(
        '[render]\nopen = false\noutput_dir = "%s"\n' % (tmp_path / "out")
    )
    return {
        "XDG_CONFIG_HOME": str(cfg),
        "XDG_STATE_HOME": str(state),
        "PAPERSYNC_THINGS_DB": str(make_db(tmp_path / "main.sqlite")),
        "PAPERSYNC_OPENER": "none",
    }


def test_version() -> None:
    result = CliRunner().invoke(main, ["--version"])
    assert result.exit_code == 0
    assert "papersync" in result.output


def test_things_export_json(tmp_path: Path) -> None:
    r = CliRunner().invoke(main, ["things", "export", "inbox"], env=_env(tmp_path))
    assert r.exit_code == 0, r.output
    data = json.loads(r.stdout)
    assert [d["title"] for d in data] == ["FOO"] and data[0]["source"] == "things"


def test_render_from_stdin_and_ledger(tmp_path: Path) -> None:
    env = _env(tmp_path)
    items = json.dumps([{"source": "things", "ref": "T1", "title": "FOO", "notes": ""}])
    r = CliRunner().invoke(main, ["render", "-", "--boxes", "A,B"], input=items, env=env)
    assert r.exit_code == 0, r.output
    out = sorted((tmp_path / "out").glob("*.pdf"))
    assert len(out) == 1 and out[0].name.endswith("-3x5.pdf")
    # state tag: opener "none" prints the update URL; runner "none" prints the AppleScript
    assert "things:///update?" in r.output and "papersync%3Aprinted" in r.output
    assert 'osascript: tell application "Things3"' in r.output
    r2 = CliRunner().invoke(
        main, ["render", "-", "--boxes", "A,B", "--no-tag"], input=items, env=env
    )
    assert r2.exit_code == 0 and "things:///update?" not in r2.output
    ledger = (tmp_path / "state" / "papersync" / "prints.jsonl").read_text()
    assert '"event":"render"' in ledger and '"ref":"T1"' in ledger
    boxsets = (tmp_path / "cfg" / "papersync" / "boxsets.toml").read_text()
    assert 'labels = ["A", "B"]' in boxsets


def test_print_then_status(tmp_path: Path) -> None:
    env = _env(tmp_path)
    r = CliRunner().invoke(main, ["print", "next"], env=env)
    assert r.exit_code == 0, r.output
    s = CliRunner().invoke(main, ["status"], env=env)
    assert s.exit_code == 0 and "BAR" in s.output and "Dated" in s.output


def _record(tmp_path: Path, source: str, ref: str, ts: datetime) -> None:
    from papersync.ledger import Ledger, LedgerEntry

    Ledger(tmp_path / "state" / "papersync" / "prints.jsonl").record(
        LedgerEntry(ts=ts, event="render", source=source, ref=ref, title=ref)
    )


def test_status_never_looks_up_an_obsidian_ref_in_things(tmp_path: Path) -> None:
    """An Obsidian ref has no Things row, and none should ever be sought for one.

    ``PAPERSYNC_THINGS_DB`` points at a path that doesn't exist, so if status
    tried to open the Things database at all -- even just to look up an
    Obsidian ref -- this would fail loudly instead of silently passing.
    """
    env = {**_env(tmp_path), "PAPERSYNC_THINGS_DB": str(tmp_path / "no-such.sqlite")}
    _record(tmp_path, "obsidian", "Notes/Alpha", datetime(2026, 9, 1))
    s = CliRunner().invoke(main, ["status"], env=env)
    assert s.exit_code == 0, s.output
    assert "outstanding" in s.output
    assert "done in Things" not in s.output


def test_forget_clears_an_unambiguous_ref_regardless_of_source(tmp_path: Path) -> None:
    env = _env(tmp_path)
    _record(tmp_path, "obsidian", "Notes/Alpha", datetime(2026, 9, 1))
    f = CliRunner().invoke(main, ["status", "--forget", "Notes/Alpha"], env=env)
    assert f.exit_code == 0, f.output
    assert "obsidian" in f.output
    s = CliRunner().invoke(main, ["status"], env=env)
    assert "Notes/Alpha" not in s.output


def test_forget_an_unknown_ref_is_rejected(tmp_path: Path) -> None:
    env = _env(tmp_path)
    f = CliRunner().invoke(main, ["status", "--forget", "nope"], env=env)
    assert f.exit_code != 0
    assert "no outstanding card" in f.output


def test_forget_a_ref_outstanding_in_two_sources_needs_source_to_disambiguate(
    tmp_path: Path,
) -> None:
    env = _env(tmp_path)
    _record(tmp_path, "things", "T1", datetime(2026, 9, 1))
    _record(tmp_path, "obsidian", "T1", datetime(2026, 9, 2))

    ambiguous = CliRunner().invoke(main, ["status", "--forget", "T1"], env=env)
    assert ambiguous.exit_code != 0
    assert "more than one source" in ambiguous.output

    resolved = CliRunner().invoke(
        main, ["status", "--forget", "T1", "--source", "obsidian"], env=env
    )
    assert resolved.exit_code == 0, resolved.output
    s = CliRunner().invoke(main, ["status"], env=env)
    # The things-sourced T1 is still outstanding; only the obsidian one was forgotten.
    assert s.output.count("T1") == 1


def test_render_overflow_fail_exits_nonzero(tmp_path: Path) -> None:
    items = json.dumps(
        [{"source": "things", "ref": "T1", "title": "FOO", "notes": "\n".join(["x"] * 80)}]
    )
    r = CliRunner().invoke(main, ["render", "-", "--size", "3x5"], input=items, env=_env(tmp_path))
    assert r.exit_code != 0 and "does not fit" in r.output


def test_apply_requires_yes_and_records(tmp_path: Path) -> None:
    env = _env(tmp_path)
    plan = Plan(
        created=datetime.now(),
        inputs=[],
        errors=[],
        changes=[
            Change(kind="update", source="things", ref="T1", title="FOO", complete=True, pages=[1])
        ],
    )
    p = tmp_path / "plan.json"
    p.write_text(plan.to_json())
    r = CliRunner().invoke(main, ["apply", str(p), "--no-verify"], input="no\n", env=env)
    assert r.exit_code != 0 and "aborted" in r.output.lower()
    r = CliRunner().invoke(main, ["apply", str(p), "--no-verify"], input="yes\n", env=env)
    assert r.exit_code == 0, r.output
    assert "things:///update?" in r.output  # opener "none" prints URLs instead of opening them
    assert '"event":"apply"' in (tmp_path / "state" / "papersync" / "prints.jsonl").read_text()


def test_apply_auto_approve_refuses_errors(tmp_path: Path) -> None:
    plan = Plan(
        created=datetime.now(), inputs=[], changes=[], errors=[PlanError(page=1, message="x")]
    )
    p = tmp_path / "plan.json"
    p.write_text(plan.to_json())
    r = CliRunner().invoke(main, ["apply", str(p), "--auto-approve"], env=_env(tmp_path))
    assert r.exit_code != 0 and "error" in r.output.lower()


def test_recognize_round_trip(tmp_path: Path) -> None:
    import cv2

    from papersync.render.templates.v1 import layout as L  # noqa: N812

    env = _env(tmp_path)
    # print through the CLI so the box set registry has set 1 = A,B
    assert (
        CliRunner()
        .invoke(
            main,
            ["render", "-", "--boxes", "A,B"],
            input=json.dumps([{"source": "things", "ref": "T1", "title": "FOO", "notes": ""}]),
            env=env,
        )
        .exit_code
        == 0
    )
    pdf = next((tmp_path / "out").glob("*.pdf"))
    gray = synthetic.rasterize(pdf.read_bytes())
    synthetic.draw_x(gray, L.done_box(L.SIZES["3x5"]))
    scan = tmp_path / "scan.png"
    cv2.imwrite(str(scan), synthetic.distort(gray))
    r = CliRunner().invoke(
        main, ["recognize", str(scan), "--review", str(tmp_path / "rev.pdf")], env=env
    )
    assert r.exit_code == 0, r.output
    plan = Plan.from_json(r.stdout)
    assert (
        plan.changes[0].ref == "T1" and plan.changes[0].complete and plan.changes[0].title == "FOO"
    )
    assert (tmp_path / "rev.pdf").exists()


def test_doctor_runs(tmp_path: Path) -> None:
    r = CliRunner().invoke(main, ["doctor"], env=_env(tmp_path))
    assert "uv" in r.output and "Things database" in r.output


def test_doctor_reports_missing_uv_and_continues(tmp_path: Path) -> None:
    env = _env(tmp_path)
    empty = tmp_path / "emptybin"
    empty.mkdir()
    env["PATH"] = str(empty)
    r = CliRunner().invoke(main, ["doctor"], env=env)
    assert r.exit_code != 0
    assert "FAIL uv" in r.output and "Things database" in r.output


def test_doctor_reports_unreadable_database_and_continues(tmp_path: Path) -> None:
    env = _env(tmp_path)
    junk = tmp_path / "junk.sqlite"
    junk.write_bytes(b"\x00not a database\xff" * 8)
    env["PAPERSYNC_THINGS_DB"] = str(junk)
    r = CliRunner().invoke(main, ["doctor"], env=env)
    assert "FAIL Things database" in r.output and "Typst template" in r.output


def test_render_missing_file_is_a_clean_error(tmp_path: Path) -> None:
    r = CliRunner().invoke(main, ["render", "/nope.json"], env=_env(tmp_path))
    assert r.exit_code != 0 and "no such file" in r.output
    assert "Traceback" not in r.output


def test_apply_missing_file_is_a_clean_error(tmp_path: Path) -> None:
    r = CliRunner().invoke(main, ["apply", "/nope.json"], env=_env(tmp_path))
    assert r.exit_code != 0 and "no such file" in r.output
    assert "Traceback" not in r.output


def test_recognize_missing_scan_is_a_usage_error(tmp_path: Path) -> None:
    r = CliRunner().invoke(main, ["recognize", "/nope.pdf"], env=_env(tmp_path))
    assert r.exit_code == 2 and "Traceback" not in r.output


def test_render_invalid_items_json_is_a_clean_error(tmp_path: Path) -> None:
    r = CliRunner().invoke(main, ["render", "-"], input='[{"nope": 1}]', env=_env(tmp_path))
    assert r.exit_code != 0 and "invalid items JSON" in r.output
    assert "Traceback" not in r.output


def _plan_json() -> str:
    return Plan(
        created=datetime.now(),
        inputs=[],
        errors=[],
        changes=[
            Change(kind="update", source="things", ref="T1", title="FOO", complete=True, pages=[1])
        ],
    ).to_json()


def test_apply_from_stdin_without_a_tty_explains_itself(tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    import papersync.cli as cli_module

    def no_tty() -> object:
        raise OSError("no controlling terminal")

    monkeypatch.setattr(cli_module, "_open_tty", no_tty)
    r = CliRunner().invoke(
        main, ["apply", "-", "--no-verify"], input=_plan_json(), env=_env(tmp_path)
    )
    assert r.exit_code != 0 and "--auto-approve" in r.output


def test_apply_from_stdin_with_auto_approve_succeeds(tmp_path: Path) -> None:
    env = _env(tmp_path)
    r = CliRunner().invoke(
        main, ["apply", "-", "--auto-approve", "--no-verify"], input=_plan_json(), env=env
    )
    assert r.exit_code == 0, r.output
    assert "things:///update?" in r.output


def test_record_applied_skips_unmet_changes(tmp_path: Path) -> None:
    from papersync.cli import _record_applied
    from papersync.ledger import Ledger

    ledger = Ledger(tmp_path / "prints.jsonl")
    changes = [
        Change(kind="update", source="things", ref="T1", title="FOO", pages=[1]),
        Change(kind="update", source="things", ref="T2", title="BAR", pages=[2]),
    ]
    assert _record_applied(ledger, changes, ["FOO: not completed"]) == 1
    written = (tmp_path / "prints.jsonl").read_text()
    assert '"ref":"T2"' in written and '"ref":"T1"' not in written


def test_render_new_card_qr(tmp_path: Path) -> None:
    import pymupdf
    import zxingcpp

    env = _env(tmp_path)
    r = CliRunner().invoke(
        main, ["render", "-", "--new", "1", "--size", "3x5"], input="[]", env=env
    )
    assert r.exit_code == 0, r.output
    pdf = next((tmp_path / "out").glob("*.pdf"))
    assert pymupdf.open(pdf).page_count == 1
    texts = [b.text for b in zxingcpp.read_barcodes(synthetic.rasterize(pdf.read_bytes()))]
    assert texts == ["papersync:///v1/things/new?size=3x5&boxes=1"]


def test_export_and_print_skip_printed_unless_asked(tmp_path: Path) -> None:
    import sqlite3

    env = _env(tmp_path)
    with sqlite3.connect(env["PAPERSYNC_THINGS_DB"]) as c:
        c.execute("INSERT INTO TMTag VALUES ('G5', 'papersync:printed')")
        c.execute("INSERT INTO TMTaskTag VALUES ('T1', 'G5')")
    r = CliRunner().invoke(main, ["things", "export", "inbox"], env=env)
    assert r.exit_code == 0 and json.loads(r.stdout) == []
    assert "skipped 1" in r.output
    r = CliRunner().invoke(main, ["things", "export", "inbox", "--no-skip-printed"], env=env)
    assert [d["title"] for d in json.loads(r.stdout)] == ["FOO"]
    r = CliRunner().invoke(main, ["print", "inbox", "--no-tag"], env=env)
    assert r.exit_code == 0 and "skipped 1" in r.output and "wrote" not in r.output
    r = CliRunner().invoke(main, ["print", "inbox", "--no-tag", "--no-skip-printed"], env=env)
    assert r.exit_code == 0 and "wrote" in r.output


def test_tag_summary_reports_only_items_that_actually_landed(monkeypatch, tmp_path: Path) -> None:
    """A partial mark_printed failure must be reported by what landed, not what was attempted."""
    from typing import ClassVar

    from papersync import cli as C  # noqa: N812
    from papersync.integrations.things.sink import STATE_PRINTED

    class PartialFailureSink:
        name = "things"
        marker = STATE_PRINTED
        warnings: ClassVar[list[str]] = []

        def __init__(self, *_a, **_k) -> None:
            pass

        def mark_printed(self, refs: list[str]) -> list[str]:
            # first ref lands, the rest do not
            return refs[1:]

    monkeypatch.setattr(C, "_sink", lambda cfg: PartialFailureSink())
    env = _env(tmp_path)
    items = json.dumps(
        [
            {"source": "things", "ref": "T1", "title": "FOO", "notes": ""},
            {"source": "things", "ref": "T2", "title": "BAR", "notes": ""},
        ]
    )
    r = CliRunner().invoke(C.main, ["render", "-", "--boxes", "A,B"], input=items, env=env)
    assert r.exit_code == 0, r.output
    assert f"set {STATE_PRINTED} on 1 things item(s)" in r.output
    assert "NOT TAGGED: T2" in r.output


def test_obsidian_export_emits_items_json(monkeypatch, tmp_path) -> None:
    from typing import ClassVar

    from click.testing import CliRunner

    from papersync import cli as C  # noqa: N812
    from papersync.model import Item

    class FakeSource:
        name = "obsidian"
        skipped_printed = 1
        errors: ClassVar[list[str]] = []

        def __init__(self, *_a, **_k) -> None:
            pass

        def export(self, selector: str, skip_printed: bool = True) -> list[Item]:
            assert selector == "search:tag:#project"
            return [Item(source="obsidian", ref="Notes/Alpha", title="Alpha", meta={"a": 1})]

    monkeypatch.setattr(C, "ObsidianSource", FakeSource)
    config = tmp_path / "papersync"
    config.mkdir(parents=True)
    (config / "config.toml").write_text('[obsidian]\nvault = "Notes"\n')
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
    from typing import ClassVar

    from click.testing import CliRunner

    from papersync import cli as C  # noqa: N812
    from papersync.integrations.obsidian import documents as D  # noqa: N812
    from papersync.integrations.obsidian.source import PRINTED_PROPERTY
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
        errors: ClassVar[list[str]] = []

        def __init__(self, *_a, **_k) -> None:
            pass

        def export(self, selector: str, skip_printed: bool = True) -> list[Item]:
            return [Item(source="obsidian", ref="Notes/Alpha", title="Alpha")]

    tagged: list[list[str]] = []

    class FakeSink:
        name = "obsidian"
        marker = PRINTED_PROPERTY
        warnings: ClassVar[list[str]] = []

        def __init__(self, *_a, **_k) -> None:
            pass

        def mark_printed(self, refs: list[str]) -> list[str]:
            tagged.append(refs)
            return []

    def fake_render(cli, spec, spec_path):
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


def _obsidian_print_env(monkeypatch, tmp_path, fake_render) -> None:  # type: ignore[no-untyped-def]
    """Shared setup for the two failure-path tests below."""
    from typing import ClassVar

    from papersync import cli as C  # noqa: N812
    from papersync.integrations.obsidian import documents as D  # noqa: N812
    from papersync.model import Item

    config = tmp_path / "papersync"
    config.mkdir(parents=True)
    (config / "config.toml").write_text('[obsidian]\nvault = "Notes"\n[render]\nopen = false\n')
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))

    class FakeSource:
        name = "obsidian"
        skipped_printed = 0
        errors: ClassVar[list[str]] = []

        def __init__(self, *_a, **_k) -> None:
            pass

        def export(self, selector: str, skip_printed: bool = True) -> list[Item]:
            return [Item(source="obsidian", ref="Notes/Alpha", title="Alpha")]

    monkeypatch.setattr(C, "ObsidianSource", FakeSource)
    monkeypatch.setattr(C, "require_bridge", lambda cli: None)
    monkeypatch.setattr(D.bridge, "render", fake_render)


def test_obsidian_print_reports_a_clean_error_when_chrome_stamping_fails(
    monkeypatch, tmp_path
) -> None:
    """A ChromeError (e.g. the bridge wrote the wrong page size) must not traceback."""
    from click.testing import CliRunner

    from papersync import cli as C  # noqa: N812
    from papersync.render import chrome
    from papersync.render.templates.v1 import layout as L  # noqa: N812

    def fake_render(cli, spec, spec_path):
        Path(spec["out"]).write_bytes(chrome.blank(L.SIZES["3x5"], 1))  # wrong size
        return 1

    _obsidian_print_env(monkeypatch, tmp_path, fake_render)
    result = CliRunner().invoke(C.main, ["obsidian", "print", "path:Notes/Alpha.md"])
    assert result.exit_code != 0
    assert "Traceback" not in result.output
    assert "mm" in result.output  # ChromeError names the mismatched page size


def test_obsidian_print_reports_a_clean_error_when_the_bridge_writes_no_file(
    monkeypatch, tmp_path
) -> None:
    """The bridge reports success but ``spec["out"]`` was never written."""
    from click.testing import CliRunner

    from papersync import cli as C  # noqa: N812

    def fake_render(cli, spec, spec_path):
        return 1  # no file written

    _obsidian_print_env(monkeypatch, tmp_path, fake_render)
    result = CliRunner().invoke(C.main, ["obsidian", "print", "path:Notes/Alpha.md"])
    assert result.exit_code != 0
    assert "Traceback" not in result.output
    assert "wrote no file" in result.output
