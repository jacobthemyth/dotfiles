#!/usr/bin/env python3
"""Export Linear issue descendants to Markdown and apply edited content back."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable


OPEN_MARKER_RE = re.compile(r"<!-- LINEAR-ISSUE: ([A-Za-z][A-Za-z0-9]*-\d+) -->")
OPEN_MARKER_PREFIX = "<!-- LINEAR-ISSUE:"
CLOSE_MARKER = "<!-- /LINEAR-ISSUE -->"
BLOCK_RE = re.compile(
    r"<!-- LINEAR-ISSUE: ([A-Za-z][A-Za-z0-9]*-\d+) -->(.*?)"
    + re.escape(CLOSE_MARKER),
    re.DOTALL,
)
LIST_CANDIDATE_RE = re.compile(
    r"^(?P<indent> *)(?P<marker>[-+*]|\d{1,9}[.)])(?P<padding> {1,4})"
)
FENCE_CANDIDATE_RE = re.compile(
    r"^(?P<indent> *)(?P<marker>`{3,}|~{3,})(?P<rest>.*?)(?:\r?\n)?$"
)
BLOCKQUOTE_RE = re.compile(r"^(?P<prefix> {0,3}(?:> ?)+)(?P<body>.*)$")
CONTENT_FIELDS = "identifier,title,description"
DISCOVERY_FIELDS = "identifier,children"


class RoundTripError(Exception):
    """A user-actionable workflow error."""


@dataclass(frozen=True)
class IssueText:
    identifier: str
    title: str
    description: str


@dataclass(frozen=True)
class Change:
    issue: IssueText
    original: IssueText
    fields: tuple[str, ...]


def natural_identifier_key(identifier: str) -> tuple[str, int]:
    prefix, number = identifier.rsplit("-", 1)
    return prefix, int(number)


def normalize_markdown(value: str) -> str:
    """Match Linear's canonical unordered-list marker for comparison."""
    normalized: list[str] = []
    fence_character: str | None = None
    fence_length = 0
    active_list_content_indents: list[int] = []
    current_quote_depth: int | None = None

    def parent_index_for(indent: int) -> int | None:
        for index in range(len(active_list_content_indents) - 1, -1, -1):
            content_indent = active_list_content_indents[index]
            if content_indent <= indent <= content_indent + 3:
                return index
        return None

    def is_container_indent(indent: int) -> bool:
        return indent <= 3 or parent_index_for(indent) is not None

    for line in value.splitlines(keepends=True):
        blockquote = BLOCKQUOTE_RE.match(line)
        prefix = blockquote.group("prefix") if blockquote else ""
        body = blockquote.group("body") if blockquote else line
        quote_depth = prefix.count(">")
        if quote_depth != current_quote_depth and fence_character is None:
            active_list_content_indents = []
            current_quote_depth = quote_depth

        fence = FENCE_CANDIDATE_RE.match(body)
        if fence_character is not None:
            if (
                fence
                and fence.group("marker")[0] == fence_character
                and len(fence.group("marker")) >= fence_length
                and not fence.group("rest").strip()
            ):
                fence_character = None
                fence_length = 0
            normalized.append(line)
            continue

        if fence and is_container_indent(len(fence.group("indent"))):
            marker = fence.group("marker")
            fence_character = marker[0]
            fence_length = len(marker)
            normalized.append(line)
            continue

        candidate = LIST_CANDIDATE_RE.match(body)
        if candidate and is_container_indent(len(candidate.group("indent"))):
            indent = len(candidate.group("indent"))
            marker = candidate.group("marker")
            if marker in "-+*":
                marker_at = candidate.start("marker")
                normalized.append(
                    prefix + body[:marker_at] + "*" + body[marker_at + 1 :]
                )
            else:
                normalized.append(line)
            parent_index = parent_index_for(indent)
            if parent_index is None:
                active_list_content_indents = []
            else:
                active_list_content_indents = active_list_content_indents[
                    : parent_index + 1
                ]
            active_list_content_indents.append(
                indent + len(marker) + len(candidate.group("padding"))
            )
            continue

        normalized.append(line)
        if body.strip():
            indent = len(body) - len(body.lstrip(" "))
            while (
                active_list_content_indents
                and indent < active_list_content_indents[-1]
            ):
                active_list_content_indents.pop()
    return "".join(normalized)


def run_linear(arguments: list[str]) -> Any:
    command = ["linear-cli", *arguments]
    try:
        result = subprocess.run(command, text=True, capture_output=True, check=False)
    except FileNotFoundError as exc:
        raise RoundTripError("linear-cli was not found on PATH") from exc
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        safe_command = " ".join(command[:3])
        raise RoundTripError(f"{safe_command} failed: {detail}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RoundTripError("linear-cli returned invalid JSON") from exc


def get_issues(
    identifiers: Iterable[str], fields: str = CONTENT_FIELDS
) -> list[dict[str, Any]]:
    ids = list(identifiers)
    if not ids:
        return []
    payload = run_linear(
        ["i", "get", *ids, "--output", "json", "--no-cache", "--fields", fields]
    )
    issues = payload if isinstance(payload, list) else [payload]
    for index, issue in enumerate(issues):
        if not isinstance(issue, dict):
            requested = ids[index] if index < len(ids) else "<unknown>"
            raise RoundTripError(f"Linear returned invalid issue data for {requested}")
    returned = {issue.get("identifier") for issue in issues}
    missing = [identifier for identifier in ids if identifier not in returned]
    if missing:
        raise RoundTripError(f"Linear did not return: {', '.join(missing)}")
    return issues


def child_ids(issue: dict[str, Any]) -> list[str]:
    identifier = issue.get("identifier", "<unknown>")
    children = issue.get("children")
    if not isinstance(children, dict) or not isinstance(children.get("nodes"), list):
        raise RoundTripError(f"Issue {identifier} returned invalid children data")
    nodes = children["nodes"]
    if any(not isinstance(node, dict) for node in nodes):
        raise RoundTripError(f"Issue {identifier} returned an invalid child record")
    ids = [node.get("identifier") for node in nodes]
    invalid = [
        value
        for value in ids
        if not isinstance(value, str)
        or not OPEN_MARKER_RE.fullmatch(f"<!-- LINEAR-ISSUE: {value} -->")
    ]
    if invalid:
        raise RoundTripError(f"Issue {identifier} returned an invalid child identifier")
    return ids


def discover_two_levels(root_identifier: str, jobs: int) -> tuple[list[str], list[str]]:
    root = get_issues([root_identifier], DISCOVERY_FIELDS)[0]
    direct = sorted(set(child_ids(root)), key=natural_identifier_key)
    grandchildren: set[str] = set()
    if direct:
        with ThreadPoolExecutor(max_workers=min(jobs, len(direct))) as executor:
            futures = {
                executor.submit(get_issues, [identifier], DISCOVERY_FIELDS): identifier
                for identifier in direct
            }
            for future in as_completed(futures):
                issue = future.result()[0]
                grandchildren.update(child_ids(issue))
    grandchildren.difference_update(direct)
    grandchildren.discard(root_identifier)
    return direct, sorted(grandchildren, key=natural_identifier_key)


def issue_text(issue: dict[str, Any]) -> IssueText:
    identifier = issue.get("identifier")
    title = issue.get("title")
    description = issue.get("description")
    if not isinstance(identifier, str) or not isinstance(title, str):
        raise RoundTripError("Linear returned an issue without a valid identifier or title")
    if description is None:
        description = ""
    if not isinstance(description, str):
        raise RoundTripError(f"Linear returned a non-text description for {identifier}")
    return IssueText(identifier, title, description)


def validate_issue_content(issue: IssueText) -> None:
    if any(
        marker in value
        for marker in (OPEN_MARKER_PREFIX, CLOSE_MARKER)
        for value in (issue.title, issue.description)
    ):
        raise RoundTripError(
            f"{issue.identifier}: title or description contains reserved LINEAR-ISSUE marker syntax"
        )


def render_markdown(root_identifier: str, issues: Iterable[IssueText]) -> str:
    sections = [
        f"# {root_identifier} descendant issues\n\n"
        "Edit the text under each `## Title` and `## Description` heading. "
        "Keep the `LINEAR-ISSUE` markers and issue IDs unchanged so the file can be mapped back to Linear.\n\n"
        "---\n"
    ]
    for issue in issues:
        validate_issue_content(issue)
        sections.append(
            f"\n<!-- LINEAR-ISSUE: {issue.identifier} -->\n"
            f"# {issue.identifier}\n\n"
            f"## Title\n\n{issue.title}\n\n"
            f"## Description\n\n{issue.description}\n\n"
            f"{CLOSE_MARKER}\n\n---\n"
        )
    return "".join(sections)


def atomic_write(path: Path, content: str, *, force: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
        os.chmod(temporary_name, 0o644)
        if force:
            os.replace(temporary_name, path)
        else:
            try:
                os.link(temporary_name, path)
            except FileExistsError as exc:
                raise RoundTripError(
                    f"Output already exists: {path}; pass --force to replace it"
                ) from exc
            os.unlink(temporary_name)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def parse_markdown(path: Path) -> list[IssueText]:
    try:
        source = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise RoundTripError(f"Markdown file not found: {path}") from exc

    open_ids = OPEN_MARKER_RE.findall(source)
    close_count = source.count(CLOSE_MARKER)
    matches = list(BLOCK_RE.finditer(source))
    if len(open_ids) != close_count or len(matches) != len(open_ids):
        raise RoundTripError("Unbalanced or nested LINEAR-ISSUE markers")
    duplicates = sorted({identifier for identifier in open_ids if open_ids.count(identifier) > 1})
    if duplicates:
        raise RoundTripError(f"Duplicate issue markers: {', '.join(duplicates)}")

    sections: list[IssueText] = []
    for match in matches:
        identifier, body = match.groups()
        prefix = f"\n# {identifier}\n\n## Title\n\n"
        delimiter = "\n\n## Description\n\n"
        if not body.startswith(prefix):
            raise RoundTripError(f"{identifier}: malformed issue or title heading")
        rest = body[len(prefix):]
        description_at = rest.find(delimiter)
        if description_at < 0:
            raise RoundTripError(f"{identifier}: missing description heading")
        title = rest[:description_at]
        description = rest[description_at + len(delimiter):]
        if description.endswith("\n\n"):
            description = description[:-2]
        elif description:
            raise RoundTripError(f"{identifier}: expected a blank line before the closing marker")
        if not title.strip():
            raise RoundTripError(f"{identifier}: title cannot be empty")
        if "\n" in title:
            raise RoundTripError(f"{identifier}: title must be one line")
        issue = IssueText(identifier, title, description)
        validate_issue_content(issue)
        sections.append(issue)
    return sections


def build_changes(expected: list[IssueText], current: list[dict[str, Any]]) -> list[Change]:
    current_by_id = {issue["identifier"]: issue_text(issue) for issue in current}
    changes: list[Change] = []
    for wanted in expected:
        actual = current_by_id[wanted.identifier]
        fields: list[str] = []
        if wanted.title != actual.title:
            fields.append("title")
        if normalize_markdown(wanted.description) != normalize_markdown(actual.description):
            fields.append("description")
        if fields:
            changes.append(Change(wanted, actual, tuple(fields)))
    return changes


def plan_file(path: Path) -> tuple[list[IssueText], list[Change]]:
    expected = parse_markdown(path)
    current = get_issues(issue.identifier for issue in expected)
    return expected, build_changes(expected, current)


def change_payload(change: Change) -> dict[str, str]:
    payload: dict[str, str] = {}
    if "title" in change.fields:
        payload["title"] = change.issue.title
    if "description" in change.fields:
        payload["description"] = change.issue.description
    return payload


def update_arguments(change: Change, dry_run: bool) -> list[str]:
    arguments = ["i", "update", change.issue.identifier]
    if "title" in change.fields:
        arguments.append(f"--title={change.issue.title}")
    if "description" in change.fields:
        arguments.append(f"--description={change.issue.description}")
    if dry_run:
        arguments.append("--dry-run")
    arguments.extend(["--output", "json"])
    return arguments


def collect_parallel(
    changes: list[Change], jobs: int, operation: Callable[[Change], Any]
) -> tuple[dict[str, Any], list[str]]:
    if not changes:
        return {}, []
    results: dict[str, Any] = {}
    failures: list[str] = []
    with ThreadPoolExecutor(max_workers=min(jobs, len(changes))) as executor:
        futures = {executor.submit(operation, change): change.issue.identifier for change in changes}
        for future in as_completed(futures):
            identifier = futures[future]
            try:
                results[identifier] = future.result()
            except Exception as exc:  # collect every per-issue failure before stopping
                failures.append(f"{identifier}: {exc}")
    return results, sorted(failures)


def run_parallel(changes: list[Change], jobs: int, operation: Callable[[Change], Any]) -> dict[str, Any]:
    results, failures = collect_parallel(changes, jobs, operation)
    if failures:
        raise RoundTripError("; ".join(failures))
    return results


def dry_run_changes(changes: list[Change], jobs: int) -> None:
    responses = run_parallel(changes, jobs, lambda change: run_linear(update_arguments(change, True)))
    for change in changes:
        response = responses[change.issue.identifier]
        expected = change_payload(change)
        if not isinstance(response, dict):
            raise RoundTripError(
                f"Invalid dry-run response for {change.issue.identifier}: expected an object"
            )
        would_update = response.get("would_update")
        if not isinstance(would_update, dict):
            raise RoundTripError(
                f"Invalid dry-run response for {change.issue.identifier}: missing would_update"
            )
        actual = would_update.get("input")
        returned_id = would_update.get("id")
        if (
            response.get("dry_run") is not True
            or returned_id != change.issue.identifier
            or actual != expected
        ):
            raise RoundTripError(
                f"Dry-run response did not match the plan for {change.issue.identifier}"
            )


def apply_changes(changes: list[Change], jobs: int) -> list[str]:
    _, failures = collect_parallel(
        changes, jobs, lambda change: run_linear(update_arguments(change, False))
    )
    return failures


def ensure_changes_fresh(changes: list[Change]) -> None:
    if not changes:
        return
    current = get_issues(change.issue.identifier for change in changes)
    current_by_id = {issue["identifier"]: issue_text(issue) for issue in current}
    stale: list[str] = []
    for change in changes:
        latest = current_by_id[change.issue.identifier]
        fields: list[str] = []
        if latest.title != change.original.title:
            fields.append("title")
        if normalize_markdown(latest.description) != normalize_markdown(
            change.original.description
        ):
            fields.append("description")
        if fields:
            stale.append(f"{change.issue.identifier} ({', '.join(fields)})")
    if stale:
        raise RoundTripError(
            "Linear content changed after planning: "
            + ", ".join(stale)
            + "; review the latest content and try again"
        )


def verification_mismatches(expected: list[IssueText]) -> list[str]:
    current = get_issues(issue.identifier for issue in expected)
    current_by_id = {issue["identifier"]: issue_text(issue) for issue in current}
    mismatches: list[str] = []
    for wanted in expected:
        actual = current_by_id[wanted.identifier]
        if wanted.title != actual.title:
            mismatches.append(f"{wanted.identifier}: title")
        if normalize_markdown(wanted.description) != normalize_markdown(actual.description):
            mismatches.append(f"{wanted.identifier}: description")
    return mismatches


def verify_file(expected: list[IssueText]) -> None:
    mismatches = verification_mismatches(expected)
    if mismatches:
        raise RoundTripError(f"Verification failed: {', '.join(mismatches)}")


def plan_summary(command: str, path: Path, issues: list[IssueText], changes: list[Change]) -> dict[str, Any]:
    return {
        "command": command,
        "file": str(path),
        "issues": len(issues),
        "changed_issues": len(changes),
        "unchanged_issues": len(issues) - len(changes),
        "title_changes": sum("title" in change.fields for change in changes),
        "description_changes": sum("description" in change.fields for change in changes),
        "changes": [
            {"identifier": change.issue.identifier, "fields": list(change.fields)}
            for change in changes
        ],
    }


def emit(summary: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(summary, indent=2))
        return
    for key, value in summary.items():
        if key != "changes":
            print(f"{key}: {value}")
    if summary.get("changes"):
        for change in summary["changes"]:
            print(f"change: {change['identifier']} ({', '.join(change['fields'])})")


def command_export(args: argparse.Namespace) -> dict[str, Any]:
    output = Path(args.output)
    if output.exists() and not args.force:
        raise RoundTripError(f"Output already exists: {output}; pass --force to replace it")
    direct, grandchildren = discover_two_levels(args.root, args.jobs)
    identifiers = sorted(set(direct + grandchildren), key=natural_identifier_key)
    issues = sorted((issue_text(issue) for issue in get_issues(identifiers)), key=lambda issue: natural_identifier_key(issue.identifier))
    atomic_write(output, render_markdown(args.root, issues), force=args.force)
    return {
        "command": "export",
        "root": args.root,
        "output": str(output),
        "direct_children": len(direct),
        "grandchildren": len(grandchildren),
        "issues_exported": len(issues),
    }


def command_plan(args: argparse.Namespace) -> dict[str, Any]:
    path = Path(args.file)
    issues, changes = plan_file(path)
    return plan_summary("plan", path, issues, changes)


def command_apply(args: argparse.Namespace) -> dict[str, Any]:
    path = Path(args.file)
    issues, changes = plan_file(path)
    dry_run_changes(changes, args.jobs)
    ensure_changes_fresh(changes)
    update_failures = apply_changes(changes, args.jobs)
    mismatches = verification_mismatches(issues)
    if update_failures or mismatches:
        parts = []
        if update_failures:
            parts.append(f"Update failed: {'; '.join(update_failures)}")
        if mismatches:
            parts.append(f"Verification failed: {', '.join(mismatches)}")
        raise RoundTripError("; ".join(parts))
    summary = plan_summary("apply", path, issues, changes)
    summary["updated_issues"] = len(changes)
    summary["verified_issues"] = len(issues)
    return summary


def positive_jobs(value: str) -> int:
    jobs = int(value)
    if not 1 <= jobs <= 16:
        raise argparse.ArgumentTypeError("jobs must be between 1 and 16")
    return jobs


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="linear-issue-roundtrip")
    subparsers = parser.add_subparsers(dest="command", required=True)

    export = subparsers.add_parser("export", help="Export a root issue's children and grandchildren")
    export.add_argument("root", help="Root Linear issue identifier, such as NUR-2749")
    export.add_argument("output", help="Markdown output path")
    export.add_argument("--force", action="store_true", help="Replace an existing output file")
    export.add_argument("--jobs", type=positive_jobs, default=4, help="Concurrent Linear calls (default: 4)")
    export.add_argument("--json", action="store_true", help="Emit a JSON summary")
    export.set_defaults(handler=command_export)

    plan = subparsers.add_parser("plan", help="Validate a Markdown file and show content changes")
    plan.add_argument("file", help="Edited Markdown file")
    plan.add_argument("--json", action="store_true", help="Emit a JSON summary")
    plan.set_defaults(handler=command_plan)

    apply = subparsers.add_parser("apply", help="Dry-run, apply, and verify title/description changes")
    apply.add_argument("file", help="Edited Markdown file")
    apply.add_argument("--jobs", type=positive_jobs, default=4, help="Concurrent Linear calls (default: 4)")
    apply.add_argument("--json", action="store_true", help="Emit a JSON summary")
    apply.set_defaults(handler=command_apply)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        summary = args.handler(args)
    except RoundTripError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    emit(summary, args.json)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
