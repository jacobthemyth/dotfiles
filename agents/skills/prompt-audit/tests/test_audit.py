import json, os, sys, tempfile, unittest
from unittest import mock
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import audit, cluster, judge

def _transcript(dirpath):
    proj = Path(dirpath) / "proj"
    proj.mkdir(parents=True)
    events = [
        {"type": "user", "sessionId": "s", "timestamp": "2026-08-09T10:00:00Z",
         "cwd": "/x/proj", "message": {"role": "user", "content": "I thought it was merged"}},
        {"type": "assistant", "sessionId": "s", "message": {"role": "assistant", "model": "claude-opus-4-8"}},
    ]
    (proj / "s.jsonl").write_text("\n".join(json.dumps(e) for e in events), encoding="utf-8")

class TestAudit(unittest.TestCase):
    def test_run_writes_report_and_watermark(self):
        with tempfile.TemporaryDirectory() as proj_d, tempfile.TemporaryDirectory() as state_d:
            _transcript(proj_d)
            os.environ["XDG_STATE_HOME"] = state_d
            try:
                with mock.patch("common.projects_root", return_value=Path(proj_d)), \
                     mock.patch.object(cluster, "ollama_available", return_value=False), \
                     mock.patch.object(judge, "run_claude", return_value=None):
                    rc = audit.run(["--since", "2026-08-01T00:00:00Z"])
                self.assertEqual(rc, 0)
                reports = list((Path(state_d) / "prompt-audit" / "reports").glob("*.md"))
                self.assertEqual(len(reports), 1)
                wm = json.loads((Path(state_d) / "prompt-audit" / "watermark.json").read_text())
                self.assertEqual(wm["last"], "2026-08-09T10:00:00Z")
            finally:
                del os.environ["XDG_STATE_HOME"]

    def test_since_nd_cutoff_is_z_suffixed(self):
        # A relative --since Nd cutoff must be Z-suffixed to order correctly
        # against transcript timestamps, not carry a +00:00 offset (bees-woqp).
        cutoff = audit._since_from_arg("7d", None)
        self.assertTrue(cutoff.endswith("Z"))
        self.assertNotIn("+00:00", cutoff)

    def test_since_nd_and_no_embed_run(self):
        with tempfile.TemporaryDirectory() as proj_d, tempfile.TemporaryDirectory() as state_d:
            _transcript(proj_d)
            os.environ["XDG_STATE_HOME"] = state_d
            try:
                with mock.patch("common.projects_root", return_value=Path(proj_d)), \
                     mock.patch.object(judge, "run_claude", return_value=None), \
                     mock.patch.object(cluster, "ollama_available", return_value=False) as emb:
                    rc = audit.run(["--since", "3650d", "--no-embed"])
                self.assertEqual(rc, 0)
                # --no-embed short-circuits before probing for embeddings.
                emb.assert_not_called()
                reports = list((Path(state_d) / "prompt-audit" / "reports").glob("*.md"))
                self.assertEqual(len(reports), 1)
            finally:
                del os.environ["XDG_STATE_HOME"]

    def test_dry_run_writes_nothing(self):
        with tempfile.TemporaryDirectory() as proj_d, tempfile.TemporaryDirectory() as state_d:
            _transcript(proj_d)
            os.environ["XDG_STATE_HOME"] = state_d
            try:
                with mock.patch("common.projects_root", return_value=Path(proj_d)), \
                     mock.patch.object(cluster, "ollama_available", return_value=False):
                    rc = audit.run(["--since", "2026-08-01T00:00:00Z", "--dry-run"])
                self.assertEqual(rc, 0)
                self.assertFalse((Path(state_d) / "prompt-audit" / "reports").exists())
            finally:
                del os.environ["XDG_STATE_HOME"]

if __name__ == "__main__":
    unittest.main()
