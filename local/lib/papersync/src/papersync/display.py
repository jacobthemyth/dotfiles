import difflib
from collections.abc import Callable

from papersync.model import Change, Plan


def _pages(change: Change) -> str:
    if len(change.pages) <= 1:
        return f"(page {change.pages[0]})" if change.pages else ""
    return f"(pages {change.pages[0]}-{change.pages[-1]})"


def _header(change: Change, ref_url: Callable[[Change], str]) -> str:
    if change.kind == "create":
        parts = [f"NEW  {change.title}", _pages(change)]
    else:
        parts = [change.title, ref_url(change), _pages(change)]
    return "  ".join(p for p in parts if p)


def _notes_diff(before: str, after: str) -> list[str]:
    diff = difflib.unified_diff(
        before.splitlines(), after.splitlines(), "notes", "notes", lineterm="", n=3
    )
    return list(diff)


def format_plan(
    plan: Plan,
    describe: Callable[[Change], list[str]],
    current_notes: Callable[[Change], str],
    ref_url: Callable[[Change], str],
) -> str:
    blocks: list[str] = []
    for change in plan.changes:
        lines = [_header(change, ref_url), *describe(change)]
        for label, box in change.boxes.items():
            if box.uncertain:
                lines.append(f"? {label:<8} fill {box.fill:.2f}, treated as unchecked")
        if change.kind == "create" and change.notes:
            lines.append(f"+ notes: {change.notes}")
        if change.append_notes:
            before = current_notes(change)
            lines += _notes_diff(before, before + change.append_notes)
        blocks.append("\n".join(lines) + "\n")
    for err in plan.errors:
        blocks.append(f"ERROR page {err.page}: {err.message}\n")
    return "\n".join(blocks)
