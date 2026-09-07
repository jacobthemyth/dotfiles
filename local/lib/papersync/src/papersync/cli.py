import json
import os
import shutil
import subprocess
import sys
from collections.abc import Callable
from datetime import date, datetime
from pathlib import Path
from typing import Any, TextIO

import click

from papersync import __version__
from papersync.boxsets import BoxSetRegistry
from papersync.config import Config, config_dir, load_config, state_dir
from papersync.display import format_plan
from papersync.integrations.things import auth as things_auth
from papersync.integrations.things.db import ThingsDb, ThingsDbNotFound, find_db_path
from papersync.integrations.things.sink import ThingsSink
from papersync.integrations.things.source import ThingsSource
from papersync.ledger import Ledger, LedgerEntry
from papersync.model import Change, Item, Plan
from papersync.recognize.assemble import recognize_pages
from papersync.recognize.ocr import OcrmacBackend
from papersync.recognize.raster import iter_pages
from papersync.recognize.review import write_review
from papersync.render import engine
from papersync.render.qr import qr_svg
from papersync.render.templates.v1 import layout as L  # noqa: N812

SIZES = ["auto", *L.SIZE_ORDER]
OVERFLOWS = ["fail", "paginate", "truncate"]


def _err(msg: str) -> None:
    click.echo(msg, err=True)


def _db() -> ThingsDb:
    override = os.environ.get("PAPERSYNC_THINGS_DB")
    try:
        return ThingsDb(Path(override) if override else find_db_path())
    except ThingsDbNotFound as exc:
        raise click.ClickException(str(exc)) from exc


def _sink(cfg: Config) -> ThingsSink:
    if os.environ.get("PAPERSYNC_OPENER") == "none":
        return ThingsSink(
            _db(),
            cfg.things,
            opener=click.echo,
            token_provider=lambda: "TEST",
            sleeper=lambda _s: None,
            runner=lambda script: click.echo(f"osascript: {script}"),
        )
    return ThingsSink(_db(), cfg.things)


def _ledger() -> Ledger:
    return Ledger(state_dir() / "prints.jsonl")


def _registry() -> BoxSetRegistry:
    return BoxSetRegistry(config_dir() / "boxsets.toml")


def _require_file(path: str) -> str:
    """Check a path argument that also accepts ``-`` for stdin."""
    if path != "-" and not Path(path).is_file():
        raise click.ClickException(f"no such file: {path}")
    return path


def _read_items(src: str) -> list[Item]:
    text = sys.stdin.read() if src == "-" else Path(src).read_text()
    try:
        return [Item.model_validate(d) for d in json.loads(text)]
    except (ValueError, TypeError) as exc:
        raise click.ClickException(f"invalid items JSON: {exc}") from exc


@click.group()
@click.version_option(__version__, prog_name="papersync")
def main() -> None:
    """Print Things items to index cards and scan them back."""


@main.group()
def things() -> None:
    """Things integration."""


@things.command("export")
@click.argument("selector")
def things_export(selector: str) -> None:
    """Export open items as JSON: inbox | next | someday | things:///show?id=UUID."""
    try:
        items = ThingsSource(_db()).export(selector)
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc
    click.echo(json.dumps([i.model_dump() for i in items], indent=2))


@things.command("auth")
def things_auth_cmd() -> None:
    """Store or rotate the Things URL-scheme token in the keychain."""
    token = click.prompt("Things auth token", hide_input=True)
    things_auth.set_token(token)
    _err("stored")


def _render_options(
    cfg: Config, size: str | None, overflow: str | None, boxes: str | None
) -> engine.RenderOptions:
    labels = [b.strip() for b in boxes.split(",") if b.strip()] if boxes else list(cfg.render.boxes)
    return engine.RenderOptions(
        labels=labels,
        boxes_id=_registry().id_for(labels),
        size=size or cfg.render.size,
        overflow=overflow or cfg.render.overflow,
    )


def _do_render(
    cfg: Config,
    items: list[Item],
    opts: engine.RenderOptions,
    new: int,
    out: Path,
    open_pdf: bool,
    tag: bool,
) -> list[Path]:
    today = date.today()
    rendered: list[engine.RenderedItem] = []
    try:
        for item in items:
            r = (
                engine.render_auto(item, opts, today)
                if opts.size == "auto"
                else engine.render_item(item, opts.size, opts, today)
            )
            if r.truncated:
                _err(f"truncated: {item.title}")
            rendered.append(r)
        if new:
            rendered += engine.render_new(
                new, "3x5" if opts.size == "auto" else opts.size, opts, today
            )
    except engine.RenderOverflow as exc:
        raise click.ClickException(str(exc)) from exc
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    paths = engine.write_outputs(rendered, out, stamp)
    ledger = _ledger()
    for r in rendered:
        if r.item is not None:
            ledger.record(
                LedgerEntry(
                    ts=datetime.now(),
                    event="render",
                    source=r.item.source,
                    ref=r.item.ref,
                    title=r.item.title,
                    size=r.size,
                    boxes=opts.boxes_id,
                    file=str(next(p for p in paths if p.name.endswith(f"-{r.size}.pdf"))),
                )
            )
    for p in paths:
        _err(f"wrote {p}")
        if open_pdf:
            subprocess.run(["open", str(p)], check=False)
    things_refs = [r.item.ref for r in rendered if r.item is not None and r.item.source == "things"]
    if tag and things_refs:
        try:
            untagged = _sink(cfg).mark_printed(things_refs)
        except RuntimeError as exc:
            raise click.ClickException(str(exc)) from exc
        for ref in untagged:
            _err(f"NOT TAGGED: {ref}")
        _err(f"tagged {len(things_refs)} item(s) papersync:printed")
    return paths


def _render_common(f: Callable[..., Any]) -> Callable[..., Any]:
    for opt in reversed(
        [
            click.option("--size", type=click.Choice(SIZES), default=None),
            click.option("--overflow", type=click.Choice(OVERFLOWS), default=None),
            click.option("--boxes", default=None, help="comma-separated box labels"),
            click.option(
                "--new", "new", type=int, default=0, help="also print N blank new-item cards"
            ),
            click.option("-o", "--output-dir", default=None),
            click.option("--open/--no-open", "open_pdf", default=None),
            click.option(
                "--tag/--no-tag", "tag", default=None, help="add papersync:printed in Things"
            ),
        ]
    ):
        f = opt(f)
    return f


@main.command()
@click.argument("items_file", default="-")
@_render_common
def render(
    items_file: str,
    size: str | None,
    overflow: str | None,
    boxes: str | None,
    new: int,
    output_dir: str | None,
    open_pdf: bool | None,
    tag: bool | None,
) -> None:
    """Render items JSON (file or -) to one PDF per page size."""
    cfg = load_config()
    opts = _render_options(cfg, size, overflow, boxes)
    items = _read_items(_require_file(items_file))
    _do_render(
        cfg,
        items,
        opts,
        new,
        Path(output_dir or cfg.render.output_dir),
        cfg.render.open if open_pdf is None else open_pdf,
        cfg.render.tag if tag is None else tag,
    )


@main.command("print")
@click.argument("selector")
@_render_common
def print_cmd(
    selector: str,
    size: str | None,
    overflow: str | None,
    boxes: str | None,
    new: int,
    output_dir: str | None,
    open_pdf: bool | None,
    tag: bool | None,
) -> None:
    """Export a Things selector and render it."""
    cfg = load_config()
    opts = _render_options(cfg, size, overflow, boxes)
    try:
        items = ThingsSource(_db()).export(selector)
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc
    _do_render(
        cfg,
        items,
        opts,
        new,
        Path(output_dir or cfg.render.output_dir),
        cfg.render.open if open_pdf is None else open_pdf,
        cfg.render.tag if tag is None else tag,
    )


def _recognize(scans: tuple[str, ...], review: str | None) -> Plan:
    source = ThingsSource(_db())
    rec = recognize_pages(
        iter_pages([Path(s) for s in scans]),
        OcrmacBackend(),
        _registry(),
        source.lookup,
        date.today(),
        list(scans),
    )
    if review:
        write_review(rec.overlays, Path(review))
        _err(f"wrote {review}")
    return rec.plan


def _display(cfg: Config, plan: Plan) -> str:
    sink = _sink(cfg)
    db = _db()

    def current_notes(change: Change) -> str:
        row = db.get(change.ref) if change.ref else None
        return row.notes if row else ""

    return format_plan(plan, sink.describe, current_notes)


@main.command()
@click.argument("scans", nargs=-1, required=True, type=click.Path(exists=True, dir_okay=False))
@click.option("--review", default=None, help="write an annotated PDF for debugging")
def recognize(scans: tuple[str, ...], review: str | None) -> None:
    """Recognize scanned cards and write the plan JSON to stdout."""
    plan = _recognize(scans, review)
    if sys.stderr.isatty():
        _err(_display(load_config(), plan))
    click.echo(plan.to_json())


def _open_tty() -> TextIO:
    return open("/dev/tty")


def _confirm(prompt_text: str, use_tty: bool) -> str:
    """Read the confirmation answer.

    When the plan arrived on stdin, stdin is exhausted and cannot be prompted
    on, so the question goes to the controlling terminal instead.
    """
    if not use_tty:
        return click.prompt(prompt_text, default="", show_default=False)
    try:
        tty = _open_tty()
    except OSError as exc:
        raise click.ClickException("stdin is the plan; use --auto-approve or a plan file") from exc
    with tty:
        click.echo(f"{prompt_text}: ", err=True, nl=False)
        return tty.readline()


def _apply(
    cfg: Config, plan: Plan, auto_approve: bool, verify: bool, plan_on_stdin: bool = False
) -> None:
    click.echo(_display(cfg, plan), err=True)
    if plan.errors:
        raise click.ClickException(
            f"plan has {len(plan.errors)} error(s); fix the plan JSON and retry"
        )
    if not plan.changes:
        _err("nothing to do")
        return
    if not auto_approve:
        answer = _confirm("Apply these changes? Only 'yes' is accepted", plan_on_stdin)
        if answer.strip() != "yes":
            raise click.ClickException("aborted")
    sink = _sink(cfg)
    try:
        sink.apply(plan.changes)
    except RuntimeError as exc:
        raise click.ClickException(str(exc)) from exc
    ledger = _ledger()
    for ch in plan.changes:
        if ch.ref:
            ledger.record(
                LedgerEntry(
                    ts=datetime.now(), event="apply", source=ch.source, ref=ch.ref, title=ch.title
                )
            )
    if verify:
        unmet = sink.verify(plan.changes)
        for line in unmet:
            _err(f"NOT APPLIED: {line}")
        if unmet:
            raise click.ClickException(f"{len(unmet)} change(s) did not land")
    _err(f"applied {len(plan.changes)} change(s)")


@main.command()
@click.argument("plan_file", default="-")
@click.option("--auto-approve", is_flag=True)
@click.option("--verify/--no-verify", default=True)
def apply(plan_file: str, auto_approve: bool, verify: bool) -> None:
    """Apply a plan JSON (file or -) to Things after confirmation."""
    _require_file(plan_file)
    text = sys.stdin.read() if plan_file == "-" else Path(plan_file).read_text()
    try:
        plan = Plan.from_json(text)
    except ValueError as exc:
        raise click.ClickException(f"invalid plan: {exc}") from exc
    _apply(load_config(), plan, auto_approve, verify, plan_on_stdin=plan_file == "-")


@main.command()
@click.argument("scans", nargs=-1, required=True, type=click.Path(exists=True, dir_okay=False))
@click.option("--review", default=None)
@click.option("--auto-approve", is_flag=True)
@click.option("--verify/--no-verify", default=True)
def scan(scans: tuple[str, ...], review: str | None, auto_approve: bool, verify: bool) -> None:
    """recognize | apply in one step."""
    _apply(load_config(), _recognize(scans, review), auto_approve, verify)


@main.command()
@click.option("--forget", default=None, help="drop one ref from the outstanding list")
def status(forget: str | None) -> None:
    """List cards that were printed but never scanned back."""
    ledger = _ledger()
    if forget:
        ledger.record(LedgerEntry(ts=datetime.now(), event="forget", source="things", ref=forget))
        _err(f"forgot {forget}")
        return
    entries = ledger.outstanding()
    if not entries:
        click.echo("no outstanding cards")
        return
    rows = _db().get_many([e.ref for e in entries])
    for e in entries:
        row = rows.get(e.ref)
        state = "done in Things" if row and row.status != 0 else "outstanding"
        click.echo(f"{e.ts:%Y-%m-%d}  {e.size:<6} {e.title:<40} {state}")


@main.command()
def doctor() -> None:
    """Check the environment."""
    ok = True

    def report(name: str, problem: str | None) -> None:
        nonlocal ok
        status = "ok  " if problem is None else "FAIL"
        detail = "" if problem is None else f": {problem}"
        click.echo(f"{status} {name}{detail}")
        ok = ok and problem is None

    report("uv", None if shutil.which("uv") else "not on PATH")
    try:
        _db().select("inbox")
        report("Things database", None)
    except click.ClickException as exc:
        report("Things database", exc.message)
    except Exception as exc:
        report("Things database", str(exc))
    try:
        import keyring

        report(
            "keychain token",
            None
            if keyring.get_password(things_auth.SERVICE, things_auth.ACCOUNT)
            else "missing (apply will prompt)",
        )
    except Exception as exc:
        report("keychain token", str(exc))
    try:
        probe = qr_svg("papersync:///v1/things/doctor?size=3x5&boxes=1")
        engine.compile_pages(L.SIZES["3x5"], [], "doctor", "", [probe], "", "", False)
        report("Typst template", None)
    except Exception as exc:
        report("Typst template", str(exc))
    try:
        import ocrmac  # noqa: F401

        report("ocrmac", None)
    except Exception as exc:
        report("ocrmac", str(exc))
    if not ok:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
