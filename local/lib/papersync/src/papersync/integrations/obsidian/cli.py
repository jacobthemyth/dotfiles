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
            raise ObsidianError(f"{command}: {reply[len(ERROR_PREFIX) :].strip()}")
        return reply

    def call_json(self, command: str, **params: Any) -> Any:
        reply = self.call(command, **params)
        try:
            return json.loads(reply)
        except ValueError as exc:
            raise ObsidianError(
                f"{command} returned output that is not JSON: {reply[:120]!r}"
            ) from exc

    def evaluate(self, js: str) -> str:
        reply = self.call("eval", code=js)
        return reply[len(RESULT_PREFIX) :] if reply.startswith(RESULT_PREFIX) else reply
