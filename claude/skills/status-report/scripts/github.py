#!/usr/bin/env python3
"""
GitHub Activity Collector for Status Reports

Fetches GitHub activity (PRs created, PRs reviewed, issues created) via the
`gh search` API and outputs structured JSON for report generation.

Why search and not contributionsCollection: the GraphQL contributionsCollection
endpoint silently drops PRIVATE-repo contribution details into an opaque
`restrictedContributionsCount` and returns the typed lists empty. For private org
repos that means zero PRs/reviews/issues even when the user is active. The search
API respects the token's actual repo access, so it returns private-org work.
"""

import json
import subprocess
import sys
from typing import Dict, List, Any
import argparse

# Zero-value timestamp gh emits for "not closed" PRs.
_ZERO_TS = "0001-01-01T00:00:00Z"


def run_gh_command(args: List[str]) -> Any:
    """Execute a gh command (already split into args) and return parsed JSON."""
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(result.stdout)
    except subprocess.CalledProcessError as e:
        print(f"Error running gh command: {e.stderr}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"Error parsing JSON response: {e}", file=sys.stderr)
        sys.exit(1)


def _repo(node: Dict[str, Any]) -> str:
    """Return 'owner/name' for a search node's repository."""
    repo = node.get("repository", {}) or {}
    if repo.get("nameWithOwner"):
        return repo["nameWithOwner"]
    owner = (repo.get("owner", {}) or {}).get("login", "")
    return f"{owner}/{repo.get('name', '')}".strip("/")


def _labels(node: Dict[str, Any]) -> List[str]:
    return [lbl.get("name", "") for lbl in (node.get("labels") or []) if lbl.get("name")]


def _none_if_zero(ts: str) -> Any:
    """Map gh's zero-value timestamp to None."""
    return None if not ts or ts == _ZERO_TS else ts


def build_activity(
    prs_created: List[Dict[str, Any]],
    prs_reviewed: List[Dict[str, Any]],
    issues_created: List[Dict[str, Any]],
    start_date: str,
    end_date: str,
    org: str,
    username: str,
) -> Dict[str, Any]:
    """Shape raw `gh search` JSON lists into the report's activity structure.

    Pure function: inputs are the parsed JSON arrays from `gh search`.
    """
    activities: Dict[str, Any] = {
        "prs_created": [
            {
                "title": pr.get("title", ""),
                "body": pr.get("body", ""),
                "url": pr.get("url", ""),
                "number": pr.get("number", 0),
                "state": pr.get("state", ""),
                "created_at": pr.get("createdAt", ""),
                "closed_at": _none_if_zero(pr.get("closedAt", "")),
                "repository": _repo(pr),
                "labels": _labels(pr),
            }
            for pr in prs_created
        ],
        "prs_reviewed": [
            {
                "title": pr.get("title", ""),
                "url": pr.get("url", ""),
                "number": pr.get("number", 0),
                "repository": _repo(pr),
                "author": (pr.get("author", {}) or {}).get("login", ""),
                "reviewed_at": pr.get("updatedAt", ""),
            }
            for pr in prs_reviewed
        ],
        "issues_created": [
            {
                "title": issue.get("title", ""),
                "body": issue.get("body", ""),
                "url": issue.get("url", ""),
                "number": issue.get("number", 0),
                "state": issue.get("state", ""),
                "created_at": issue.get("createdAt", ""),
                "repository": _repo(issue),
                "labels": _labels(issue),
            }
            for issue in issues_created
        ],
        "summary": {
            "start_date": start_date,
            "end_date": end_date,
            "org": org,
            "username": username,
        },
    }

    activities["summary"]["total_prs_created"] = len(activities["prs_created"])
    activities["summary"]["total_prs_reviewed"] = len(activities["prs_reviewed"])
    activities["summary"]["total_issues_created"] = len(activities["issues_created"])

    return activities


def fetch_github_activity(start_date: str, end_date: str, org: str, username: str) -> Dict[str, Any]:
    """Fetch activity via `gh search` and shape it via build_activity.

    Notes:
    - PRs/issues created are filtered by author + creation date in the window.
    - Reviews are filtered by reviewer + `updated` date in the window (search
      cannot filter by exact review date; "updated in the window" is the
      closest available proxy and over-captures slightly).
    """
    created = f"{start_date}..{end_date}"

    prs_created = run_gh_command([
        "gh", "search", "prs", "--author", username, "--owner", org,
        "--created", created, "-L", "100",
        "--json", "number,title,body,url,state,createdAt,closedAt,repository,labels",
    ])

    prs_reviewed = run_gh_command([
        "gh", "search", "prs", "--reviewed-by", username, "--owner", org,
        "--updated", created, "-L", "100",
        "--json", "number,title,url,repository,author,updatedAt",
    ])

    issues_created = run_gh_command([
        "gh", "search", "issues", "--author", username, "--owner", org,
        "--created", created, "-L", "100",
        "--json", "number,title,body,url,state,createdAt,repository,labels",
    ])

    return build_activity(
        prs_created, prs_reviewed, issues_created, start_date, end_date, org, username
    )


def get_current_username() -> str:
    """Get current GitHub username from gh CLI."""
    try:
        result = subprocess.run(
            ["gh", "api", "user", "--jq", ".login"],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        print(f"Error getting GitHub username: {e.stderr}", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Collect GitHub activity for status reports")
    parser.add_argument("--start-date", required=True, help="Start date in YYYY-MM-DD format")
    parser.add_argument("--end-date", required=True, help="End date in YYYY-MM-DD format")
    parser.add_argument("--org", required=True, help="GitHub organization to filter by")
    parser.add_argument("--username", help="GitHub username (defaults to current user)")
    parser.add_argument("--output", help="Output file path (defaults to stdout)")

    args = parser.parse_args()

    username = args.username or get_current_username()

    activities = fetch_github_activity(args.start_date, args.end_date, args.org, username)

    output_json = json.dumps(activities, indent=2)

    if args.output:
        with open(args.output, "w") as f:
            f.write(output_json)
        print(f"GitHub activity saved to {args.output}", file=sys.stderr)
    else:
        print(output_json)


if __name__ == "__main__":
    main()
