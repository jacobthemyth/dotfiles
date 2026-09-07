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
