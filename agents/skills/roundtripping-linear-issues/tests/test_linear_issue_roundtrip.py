#!/usr/bin/env python3
"""Integration tests for the Linear/Markdown round-trip CLI."""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "linear_issue_roundtrip.py"


FAKE_LINEAR_CLI = r'''#!/usr/bin/env python3
import json
import os
import re
import sys
import fcntl
import time
from pathlib import Path

state_path = Path(os.environ["FAKE_LINEAR_STATE"])
args = sys.argv[1:]

def load_state():
    with state_path.open("r", encoding="utf-8") as state_file:
        fcntl.flock(state_file, fcntl.LOCK_SH)
        return json.load(state_file)

state = load_state()

def save():
    state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

def append_call(call):
    with state_path.open("r+", encoding="utf-8") as state_file:
        fcntl.flock(state_file, fcntl.LOCK_EX)
        live = json.load(state_file)
        live.setdefault("calls", []).append(call)
        state_file.seek(0)
        json.dump(live, state_file, indent=2)
        state_file.write("\n")
        state_file.truncate()

def option(name, default=None):
    try:
        return args[args.index(name) + 1]
    except ValueError:
        return default

if args[:2] == ["i", "get"]:
    ids = []
    for value in args[2:]:
        if value.startswith("-"):
            break
        ids.append(value)
    missing = [identifier for identifier in ids if identifier not in state["issues"]]
    if missing:
        print(json.dumps({"error": f"not found: {', '.join(missing)}"}))
        raise SystemExit(2)
    append_call({
        "operation": "get",
        "identifiers": ids,
        "fields": option("--fields"),
    })
    time.sleep(state.get("get_delay", 0))
    values = [state["issues"][identifier] for identifier in ids]
    values = [
        [] if identifier in state.get("bad_get_entries", []) else value
        for identifier, value in zip(ids, values)
    ]
    print(json.dumps(values[0] if len(values) == 1 else values))
    raise SystemExit(0)

if args[:2] == ["i", "update"]:
    identifier = args[2]
    dry_run = "--dry-run" in args
    updates = {}
    if "-T" in args:
        updates["title"] = option("-T")
        if updates["title"].startswith("-"):
            print("error: unexpected argument", file=sys.stderr)
            raise SystemExit(2)
    for value in args:
        if value.startswith("--title="):
            updates["title"] = value.removeprefix("--title=")
    if "-d" in args:
        updates["description"] = option("-d")
        if updates["description"].startswith("-"):
            print("error: unexpected argument", file=sys.stderr)
            raise SystemExit(2)
    for value in args:
        if value.startswith("--description="):
            updates["description"] = value.removeprefix("--description=")
    with state_path.open("r+", encoding="utf-8") as state_file:
        fcntl.flock(state_file, fcntl.LOCK_EX)
        live = json.load(state_file)
        live.setdefault("calls", []).append({
            "operation": "update",
            "identifier": identifier,
            "dry_run": dry_run,
            "updates": updates,
        })
        failed = dry_run and identifier in live.get("dry_run_failures", [])
        bad_dry_run_shape = dry_run and identifier in live.get("bad_dry_run_shapes", [])
        update_failed = not dry_run and identifier in live.get("update_failures", [])
        if dry_run and identifier in live.get("mutate_after_dry_run", {}):
            live["issues"][identifier].update(live["mutate_after_dry_run"][identifier])
        if not dry_run and not update_failed:
            issue = live["issues"][identifier]
            issue.update(updates)
            if "description" in updates:
                issue["description"] = re.sub(r"(?m)^(\s*)[-+] ", r"\1* ", issue["description"])
        state_file.seek(0)
        json.dump(live, state_file, indent=2)
        state_file.write("\n")
        state_file.truncate()
    if failed:
        print(json.dumps({"error": "forced dry-run failure"}))
        raise SystemExit(1)
    if update_failed:
        print(json.dumps({"error": "forced update failure"}))
        raise SystemExit(1)
    if bad_dry_run_shape:
        print(json.dumps([]))
        raise SystemExit(0)
    if dry_run:
        print(json.dumps({"dry_run": True, "would_update": {"id": identifier, "input": updates}}))
    else:
        print(json.dumps(issue))
    raise SystemExit(0)

print(json.dumps({"error": f"unsupported arguments: {args}"}))
raise SystemExit(2)
'''


def issue(identifier, title, description, children=(), parent=None):
    return {
        "id": f"uuid-{identifier}",
        "identifier": identifier,
        "title": title,
        "description": description,
        "parent": parent,
        "children": {
            "nodes": [
                {"identifier": child, "title": f"Title {child}", "state": {"name": "Backlog"}}
                for child in children
            ]
        },
        "state": {"name": "Backlog"},
    }


def initial_state():
    return {
        "issues": {
            "NUR-500": issue("NUR-500", "Root", "Root description", ("NUR-501", "NUR-502")),
            "NUR-501": issue("NUR-501", "First child", "First description", ("NUR-503",), "NUR-500"),
            "NUR-502": issue("NUR-502", "Second child", "* Existing item", ("NUR-504",), "NUR-500"),
            "NUR-503": issue("NUR-503", "First grandchild", "Grandchild description", ("NUR-505",), "NUR-501"),
            "NUR-504": issue("NUR-504", "Second grandchild", "Other grandchild", (), "NUR-502"),
            "NUR-505": issue("NUR-505", "Great-grandchild", "Must not export", (), "NUR-503"),
        },
        "calls": [],
        "dry_run_failures": [],
        "bad_dry_run_shapes": [],
        "update_failures": [],
        "mutate_after_dry_run": {},
        "bad_get_entries": [],
        "get_delay": 0,
    }


class RoundTripCliTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name)
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self.fake_cli = self.bin_dir / "linear-cli"
        self.fake_cli.write_text(FAKE_LINEAR_CLI, encoding="utf-8")
        self.fake_cli.chmod(0o755)
        self.state_path = self.root / "state.json"
        self.write_state(initial_state())
        self.markdown_path = self.root / "NUR-500.md"

    def write_state(self, state):
        self.state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

    def read_state(self):
        return json.loads(self.state_path.read_text(encoding="utf-8"))

    def run_cli(self, *args):
        return subprocess.run(
            ["python3", str(SCRIPT), *map(str, args)],
            text=True,
            capture_output=True,
            env=self.cli_env(),
            check=False,
        )

    def cli_env(self):
        env = os.environ.copy()
        env["PATH"] = f"{self.bin_dir}{os.pathsep}{env.get('PATH', '')}"
        env["FAKE_LINEAR_STATE"] = str(self.state_path)
        return env

    def export(self):
        result = self.run_cli("export", "NUR-500", self.markdown_path, "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def replace_section(self, identifier, *, title=None, description=None):
        text = self.markdown_path.read_text(encoding="utf-8")
        marker = f"<!-- LINEAR-ISSUE: {identifier} -->"
        end_marker = "<!-- /LINEAR-ISSUE -->"
        start = text.index(marker)
        end = text.index(end_marker, start) + len(end_marker)
        block = text[start:end]
        match = re.fullmatch(
            rf"<!-- LINEAR-ISSUE: {re.escape(identifier)} -->\n"
            rf"# {re.escape(identifier)}\n\n## Title\n\n"
            rf"(?P<title>.*?)\n\n## Description\n\n"
            rf"(?P<description>.*?)\n\n<!-- /LINEAR-ISSUE -->",
            block,
            re.DOTALL,
        )
        self.assertIsNotNone(match)
        new_title = match.group("title") if title is None else title
        new_description = match.group("description") if description is None else description
        replacement = (
            f"{marker}\n# {identifier}\n\n## Title\n\n{new_title}\n\n"
            f"## Description\n\n{new_description}\n\n{end_marker}"
        )
        self.markdown_path.write_text(text[:start] + replacement + text[end:], encoding="utf-8")

    def test_export_includes_exactly_children_and_grandchildren_in_flat_sections(self):
        summary = self.export()
        text = self.markdown_path.read_text(encoding="utf-8")

        self.assertEqual(summary["issues_exported"], 4)
        self.assertEqual(summary["direct_children"], 2)
        self.assertEqual(summary["grandchildren"], 2)
        self.assertEqual(
            re.findall(r"<!-- LINEAR-ISSUE: (NUR-\d+) -->", text),
            ["NUR-501", "NUR-502", "NUR-503", "NUR-504"],
        )
        self.assertNotIn("<!-- LINEAR-ISSUE: NUR-500 -->", text)
        self.assertNotIn("<!-- LINEAR-ISSUE: NUR-505 -->", text)
        self.assertNotIn("linear-parent", text)
        self.assertIn("## Title\n\nFirst child\n\n## Description\n\nFirst description", text)

    def test_export_refuses_to_overwrite_without_force(self):
        self.export()
        original = self.markdown_path.read_text(encoding="utf-8")
        result = self.run_cli("export", "NUR-500", self.markdown_path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("already exists", result.stderr)
        self.assertEqual(self.markdown_path.read_text(encoding="utf-8"), original)

    def test_export_rejects_issue_content_containing_reserved_markers(self):
        state = self.read_state()
        state["issues"]["NUR-501"]["description"] = (
            "Text before\n<!-- /LINEAR-ISSUE -->\nText after"
        )
        self.write_state(state)

        result = self.run_cli("export", "NUR-500", self.markdown_path)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("reserved", result.stderr.lower())
        self.assertIn("NUR-501", result.stderr)
        self.assertFalse(self.markdown_path.exists())

    def test_concurrent_exports_without_force_publish_only_once(self):
        state = self.read_state()
        state["get_delay"] = 0.1
        self.write_state(state)
        command = [
            "python3",
            str(SCRIPT),
            "export",
            "NUR-500",
            str(self.markdown_path),
            "--json",
        ]

        first = subprocess.Popen(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.cli_env())
        second = subprocess.Popen(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.cli_env())
        first_output = first.communicate()
        second_output = second.communicate()

        self.assertEqual(sorted([first.returncode, second.returncode]), [0, 1], (first_output, second_output))
        self.assertTrue(self.markdown_path.exists())
        self.assertEqual(
            len(re.findall(r"<!-- LINEAR-ISSUE: NUR-50[1-4] -->", self.markdown_path.read_text(encoding="utf-8"))),
            4,
        )

    def test_plan_skips_markdown_bullet_marker_only_differences(self):
        self.export()
        self.replace_section("NUR-501", title="Revised title")
        self.replace_section("NUR-502", description="- Existing item")

        result = self.run_cli("plan", self.markdown_path, "--json")

        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(summary["changed_issues"], 1)
        self.assertEqual(summary["changes"], [{"identifier": "NUR-501", "fields": ["title"]}])

    def test_plan_does_not_normalize_bullet_markers_inside_fenced_code(self):
        state = self.read_state()
        state["issues"]["NUR-502"]["description"] = "```text\n* code\n```\n\n* list"
        self.write_state(state)
        self.export()
        self.replace_section(
            "NUR-502", description="```text\n- code\n```\n\n- list"
        )

        result = self.run_cli("plan", self.markdown_path, "--json")

        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(
            summary["changes"],
            [{"identifier": "NUR-502", "fields": ["description"]}],
        )

    def test_plan_does_not_normalize_bullet_markers_inside_indented_code(self):
        state = self.read_state()
        state["issues"]["NUR-502"]["description"] = "    * literal code"
        self.write_state(state)
        self.export()
        self.replace_section("NUR-502", description="    - literal code")

        result = self.run_cli("plan", self.markdown_path, "--json")

        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(
            summary["changes"],
            [{"identifier": "NUR-502", "fields": ["description"]}],
        )

    def test_plan_normalizes_bullet_markers_inside_blockquotes(self):
        state = self.read_state()
        state["issues"]["NUR-502"]["description"] = "> * quoted item"
        self.write_state(state)
        self.export()
        self.replace_section("NUR-502", description="> - quoted item")

        result = self.run_cli("plan", self.markdown_path, "--json")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["changes"], [])

    def test_plan_normalizes_nested_list_markers_with_four_space_indent(self):
        state = self.read_state()
        state["issues"]["NUR-502"]["description"] = "* parent\n    * child"
        self.write_state(state)
        self.export()
        self.replace_section("NUR-502", description="- parent\n    - child")

        result = self.run_cli("plan", self.markdown_path, "--json")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["changes"], [])

    def test_apply_verifies_linear_canonicalized_nested_list_markers(self):
        self.export()
        self.replace_section(
            "NUR-502", description="New text\n\n- parent\n    - child"
        )

        result = self.run_cli("apply", self.markdown_path, "--json")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.read_state()["issues"]["NUR-502"]["description"],
            "New text\n\n* parent\n    * child",
        )

    def test_plan_normalizes_unordered_child_under_ordered_parent(self):
        state = self.read_state()
        state["issues"]["NUR-502"]["description"] = "1. parent\n    * child"
        self.write_state(state)
        self.export()
        self.replace_section("NUR-502", description="1. parent\n    - child")

        result = self.run_cli("plan", self.markdown_path, "--json")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["changes"], [])

    def test_apply_verifies_unordered_child_under_ordered_parent(self):
        self.export()
        self.replace_section(
            "NUR-502", description="New text\n\n1. parent\n    - child"
        )

        result = self.run_cli("apply", self.markdown_path, "--json")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.read_state()["issues"]["NUR-502"]["description"],
            "New text\n\n1. parent\n    * child",
        )

    def test_export_and_import_request_only_the_fields_each_phase_needs(self):
        self.export()
        calls = [call for call in self.read_state()["calls"] if call["operation"] == "get"]
        discovery = [call for call in calls if call["fields"] == "identifier,children"]
        content = [call for call in calls if call["fields"] == "identifier,title,description"]
        self.assertEqual(len(discovery), 3)
        self.assertEqual(len(content), 1)

        state = self.read_state()
        state["calls"] = []
        self.write_state(state)
        result = self.run_cli("plan", self.markdown_path, "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        plan_calls = [call for call in self.read_state()["calls"] if call["operation"] == "get"]
        self.assertTrue(plan_calls)
        self.assertTrue(all(call["fields"] == "identifier,title,description" for call in plan_calls))
        self.assertTrue(all("NUR-500" not in call["identifiers"] for call in plan_calls))

    def test_malformed_get_issue_is_reported_without_traceback(self):
        self.export()
        state = self.read_state()
        state["bad_get_entries"] = ["NUR-501"]
        self.write_state(state)

        result = self.run_cli("plan", self.markdown_path)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid", result.stderr.lower())
        self.assertIn("NUR-501", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_malformed_children_payload_is_reported_without_traceback(self):
        state = self.read_state()
        state["issues"]["NUR-500"]["children"] = None
        self.write_state(state)

        result = self.run_cli("export", "NUR-500", self.markdown_path)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("children", result.stderr.lower())
        self.assertIn("NUR-500", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_apply_preserves_metacharacters_clears_empty_description_and_verifies(self):
        self.export()
        title = "New 'title' with `$()`; && literal text"
        description = "Literal '$HOME', `backticks`, $(no-op), and ; &&\n\n- list item"
        self.replace_section("NUR-501", title=title, description="")
        self.replace_section("NUR-503", description=description)

        result = self.run_cli("apply", self.markdown_path, "--jobs", "2", "--json")

        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(summary["updated_issues"], 2)
        self.assertEqual(summary["verified_issues"], 4)
        state = self.read_state()
        self.assertEqual(state["issues"]["NUR-501"]["title"], title)
        self.assertEqual(state["issues"]["NUR-501"]["description"], "")
        self.assertEqual(
            state["issues"]["NUR-503"]["description"],
            "Literal '$HOME', `backticks`, $(no-op), and ; &&\n\n* list item",
        )
        self.assertEqual(state["issues"]["NUR-501"]["parent"], "NUR-500")

        rerun = self.run_cli("plan", self.markdown_path, "--json")
        self.assertEqual(rerun.returncode, 0, rerun.stderr)
        self.assertEqual(json.loads(rerun.stdout)["changed_issues"], 0)

    def test_apply_accepts_titles_and_descriptions_that_begin_with_hyphens(self):
        self.export()
        self.replace_section("NUR-501", title="--help", description="- first item")

        result = self.run_cli("apply", self.markdown_path, "--json")

        self.assertEqual(result.returncode, 0, result.stderr)
        current = self.read_state()["issues"]["NUR-501"]
        self.assertEqual(current["title"], "--help")
        self.assertEqual(current["description"], "* first item")

    def test_failed_dry_run_aborts_before_any_real_update(self):
        self.export()
        self.replace_section("NUR-501", title="Would change")
        self.replace_section("NUR-503", title="Would also change")
        state = self.read_state()
        state["dry_run_failures"] = ["NUR-503"]
        self.write_state(state)

        result = self.run_cli("apply", self.markdown_path, "--jobs", "2", "--json")

        self.assertNotEqual(result.returncode, 0)
        current = self.read_state()
        self.assertEqual(current["issues"]["NUR-501"]["title"], "First child")
        self.assertEqual(current["issues"]["NUR-503"]["title"], "First grandchild")
        update_calls = [call for call in current["calls"] if call["operation"] == "update"]
        self.assertTrue(update_calls)
        self.assertTrue(all(call["dry_run"] for call in update_calls))

    def test_malformed_dry_run_response_is_reported_without_traceback(self):
        self.export()
        self.replace_section("NUR-501", title="Would change")
        state = self.read_state()
        state["bad_dry_run_shapes"] = ["NUR-501"]
        self.write_state(state)

        result = self.run_cli("apply", self.markdown_path, "--json")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("NUR-501", result.stderr)
        self.assertIn("dry-run response", result.stderr.lower())
        self.assertNotIn("Traceback", result.stderr)
        update_calls = [
            call for call in self.read_state()["calls"] if call["operation"] == "update"
        ]
        self.assertTrue(update_calls)
        self.assertTrue(all(call["dry_run"] for call in update_calls))

    def test_apply_aborts_if_linear_content_changes_after_dry_run(self):
        self.export()
        self.replace_section("NUR-501", title="File edit")
        state = self.read_state()
        state["mutate_after_dry_run"] = {
            "NUR-501": {"title": "Concurrent Linear edit"}
        }
        self.write_state(state)

        result = self.run_cli("apply", self.markdown_path, "--json")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("changed after planning", result.stderr.lower())
        self.assertIn("NUR-501", result.stderr)
        current = self.read_state()
        self.assertEqual(current["issues"]["NUR-501"]["title"], "Concurrent Linear edit")
        update_calls = [
            call for call in current["calls"] if call["operation"] == "update"
        ]
        self.assertTrue(update_calls)
        self.assertTrue(all(call["dry_run"] for call in update_calls))

    def test_partial_update_failure_still_runs_verification(self):
        self.export()
        self.replace_section("NUR-501", title="Successful write")
        self.replace_section("NUR-503", title="Failed write")
        state = self.read_state()
        state["update_failures"] = ["NUR-503"]
        self.write_state(state)

        result = self.run_cli("apply", self.markdown_path, "--jobs", "2", "--json")

        self.assertNotEqual(result.returncode, 0)
        current = self.read_state()
        self.assertEqual(current["issues"]["NUR-501"]["title"], "Successful write")
        self.assertEqual(current["issues"]["NUR-503"]["title"], "First grandchild")
        self.assertIn("NUR-503", result.stderr)
        self.assertIn("Verification failed", result.stderr)

    def test_apply_uses_file_ids_after_hierarchy_changes(self):
        self.export()
        self.replace_section("NUR-501", title="Still in file scope")
        state = self.read_state()
        state["issues"]["NUR-500"]["children"] = {"nodes": []}
        state["issues"]["NUR-501"]["parent"] = "NUR-999"
        self.write_state(state)

        result = self.run_cli("apply", self.markdown_path, "--json")

        self.assertEqual(result.returncode, 0, result.stderr)
        current = self.read_state()
        self.assertEqual(current["issues"]["NUR-501"]["title"], "Still in file scope")
        self.assertEqual(current["issues"]["NUR-501"]["parent"], "NUR-999")

    def test_duplicate_marker_is_rejected_before_updates(self):
        self.export()
        state = self.read_state()
        state["calls"] = []
        self.write_state(state)
        text = self.markdown_path.read_text(encoding="utf-8")
        start = text.index("<!-- LINEAR-ISSUE: NUR-501 -->")
        end = text.index("<!-- /LINEAR-ISSUE -->", start) + len("<!-- /LINEAR-ISSUE -->")
        self.markdown_path.write_text(text + "\n" + text[start:end] + "\n", encoding="utf-8")

        result = self.run_cli("apply", self.markdown_path)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("duplicate", result.stderr.lower())
        self.assertEqual(self.read_state()["calls"], [])

    def test_import_rejects_reserved_marker_prefix_inside_content(self):
        self.export()
        self.replace_section(
            "NUR-501",
            description="Text before\n<!-- LINEAR-ISSUE: note -->\nText after",
        )
        state = self.read_state()
        state["calls"] = []
        self.write_state(state)

        result = self.run_cli("plan", self.markdown_path)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("reserved", result.stderr.lower())
        self.assertIn("NUR-501", result.stderr)
        self.assertEqual(self.read_state()["calls"], [])


if __name__ == "__main__":
    unittest.main()
