import json
from collections.abc import Callable

import pytest

from papersync.integrations.obsidian.cli import ObsidianCli, ObsidianError


def _recorder(reply: str) -> tuple[list[list[str]], Callable[[list[str]], str]]:
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
    with pytest.raises(ObsidianError, match=r"missing\.md"):
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
    calls, runner = _recorder('=> {"ok": true}')
    cli = ObsidianCli("Notes", runner=runner)
    assert cli.evaluate("window.papersync.version") == '{"ok": true}'
    assert calls == [["vault=Notes", "eval", "code=window.papersync.version"]]
