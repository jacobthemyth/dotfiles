#!/usr/bin/env python3
"""Tests for github.py's build_activity transform (gh search JSON -> report shape)."""

import importlib.util
import unittest
from pathlib import Path

# Import github.py by file path (filename isn't a clean module name to import directly).
_spec = importlib.util.spec_from_file_location(
    "github_collector", Path(__file__).with_name("github.py")
)
github_collector = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(github_collector)
build_activity = github_collector.build_activity


# Realistic `gh search prs --json ...` node (open PR authored by the user)
PR_CREATED = {
    "number": 4943,
    "title": "feat(observability): outbound HTTP span tags",
    "body": "## What & why\nadds span tags",
    "url": "https://github.com/acme/api-service/pull/4943",
    "state": "open",
    "createdAt": "2026-06-23T19:43:56Z",
    "closedAt": "0001-01-01T00:00:00Z",  # zero sentinel = not closed
    "repository": {"name": "api-service", "nameWithOwner": "acme/api-service"},
    "labels": [{"name": "backend"}, {"name": "observability"}],
}

# `gh search prs --reviewed-by USER --json number,title,url,repository,author,updatedAt`
PR_REVIEWED = {
    "number": 411,
    "title": "chore(deploy): remove orphaned ArgoCD apps",
    "url": "https://github.com/acme/deploy-manifests/pull/411",
    "repository": {"name": "deploy-manifests", "nameWithOwner": "acme/deploy-manifests"},
    "author": {"login": "octocat"},
    "updatedAt": "2026-06-24T10:00:00Z",
}

# `gh search issues --author USER --json ...`
ISSUE_CREATED = {
    "number": 50,
    "title": "Track down flaky deploy",
    "body": "details",
    "url": "https://github.com/acme/infra/issues/50",
    "state": "open",
    "createdAt": "2026-06-22T08:00:00Z",
    "repository": {"name": "infra", "nameWithOwner": "acme/infra"},
    "labels": [],
}


class BuildActivityTest(unittest.TestCase):
    def _build(self, prs_created=None, prs_reviewed=None, issues_created=None):
        return build_activity(
            prs_created=prs_created or [],
            prs_reviewed=prs_reviewed or [],
            issues_created=issues_created or [],
            start_date="2026-06-22",
            end_date="2026-06-28",
            org="acme",
            username="devuser",
        )

    def test_pr_created_is_mapped_with_owner_repo_and_labels(self):
        result = self._build(prs_created=[PR_CREATED])
        self.assertEqual(len(result["prs_created"]), 1)
        pr = result["prs_created"][0]
        self.assertEqual(pr["number"], 4943)
        self.assertEqual(pr["title"], PR_CREATED["title"])
        self.assertEqual(pr["url"], PR_CREATED["url"])
        self.assertEqual(pr["state"], "open")
        self.assertEqual(pr["created_at"], "2026-06-23T19:43:56Z")
        self.assertEqual(pr["repository"], "acme/api-service")
        self.assertEqual(pr["labels"], ["backend", "observability"])

    def test_open_pr_zero_closed_sentinel_becomes_none(self):
        result = self._build(prs_created=[PR_CREATED])
        self.assertIsNone(result["prs_created"][0]["closed_at"])

    def test_reviewed_pr_keeps_author_and_review_proxy_date(self):
        result = self._build(prs_reviewed=[PR_REVIEWED])
        self.assertEqual(len(result["prs_reviewed"]), 1)
        rev = result["prs_reviewed"][0]
        self.assertEqual(rev["number"], 411)
        self.assertEqual(rev["repository"], "acme/deploy-manifests")
        self.assertEqual(rev["author"], "octocat")
        self.assertEqual(rev["reviewed_at"], "2026-06-24T10:00:00Z")

    def test_issue_created_is_mapped(self):
        result = self._build(issues_created=[ISSUE_CREATED])
        self.assertEqual(len(result["issues_created"]), 1)
        issue = result["issues_created"][0]
        self.assertEqual(issue["number"], 50)
        self.assertEqual(issue["repository"], "acme/infra")
        self.assertEqual(issue["state"], "open")

    def test_summary_counts_and_metadata(self):
        result = self._build(
            prs_created=[PR_CREATED], prs_reviewed=[PR_REVIEWED], issues_created=[ISSUE_CREATED]
        )
        summary = result["summary"]
        self.assertEqual(summary["total_prs_created"], 1)
        self.assertEqual(summary["total_prs_reviewed"], 1)
        self.assertEqual(summary["total_issues_created"], 1)
        self.assertEqual(summary["org"], "acme")
        self.assertEqual(summary["username"], "devuser")
        self.assertEqual(summary["start_date"], "2026-06-22")
        self.assertEqual(summary["end_date"], "2026-06-28")


if __name__ == "__main__":
    unittest.main()
