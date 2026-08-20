import os, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import report

class TestReport(unittest.TestCase):
    def test_summarize_and_render(self):
        prompts = [{"text": "fix it", "model": "m"}, {"text": "commit the changes", "model": "m"}]
        rule_findings = {0: [{"check": "ambiguous_referent", "evidence": "it"}], 1: []}
        clusters = [{"members": [0], "representative": 0, "size": 1},
                    {"members": [1], "representative": 1, "size": 1}]
        s = report.summarize(prompts, rule_findings, clusters, "token-signature")
        self.assertEqual(s["prompts"], 2)
        self.assertEqual(s["flagged"], 1)
        self.assertEqual(s["check_counts"]["ambiguous_referent"], 1)
        md = report.render(s, clusters, prompts, [{"index": 0, "violations": ["vague"], "rewrite": "name it"}], None)
        self.assertIn("# Prompt Audit", md)
        self.assertIn("First run", md)
        self.assertIn("name it", md)

    def test_render_skips_non_dict_judge_result(self):
        prompts = [{"text": "fix it", "model": "m"}]
        s = {"prompts": 1, "flagged": 0, "cluster_method": "x", "check_counts": {}}
        # A malformed judge_results entry (not a dict) must not crash render().
        md = report.render(s, [], prompts, ["note", [1, 2], {"index": 0, "violations": ["vague"]}], None)
        self.assertIn("# Prompt Audit", md)
        self.assertIn("vague", md)

    def test_render_rejects_negative_index(self):
        prompts = [{"text": "fix it", "model": "m"}]
        s = {"prompts": 1, "flagged": 0, "cluster_method": "x", "check_counts": {}}
        md = report.render(s, [], prompts, [{"index": -1, "violations": ["vague"]}], None)
        self.assertNotIn("vague", md)

    def test_trend_and_state_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            os.environ["XDG_STATE_HOME"] = d
            try:
                report.save_run({"flagged": 3})
                prev = report.load_previous()
                self.assertEqual(prev["flagged"], 3)
                md = report.render({"prompts": 1, "flagged": 5, "cluster_method": "x", "check_counts": {}},
                                   [], [], [], prev)
                self.assertIn("+2", md)
                p = report.write_report("hello")
                self.assertTrue(p.exists())
            finally:
                del os.environ["XDG_STATE_HOME"]

if __name__ == "__main__":
    unittest.main()
