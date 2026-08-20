import sys, unittest
from unittest import mock
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import judge

class TestJudge(unittest.TestCase):
    def test_select_items_reps_then_offenders_capped(self):
        prompts = [{"text": f"p{i}", "model": "m"} for i in range(5)]
        clusters = [{"representative": 0, "size": 3}, {"representative": 1, "size": 1}]
        rule_findings = {2: [{"check": "x"}], 3: [{"check": "y"}, {"check": "z"}]}
        got = judge.select_items(prompts, clusters, rule_findings, cap=3)
        self.assertEqual(got[:2], [0, 1])          # representatives first (by size)
        self.assertEqual(got[2], 3)                 # worst offender next
        self.assertEqual(len(got), 3)               # capped

    def test_parse_result_from_wrapped_json(self):
        out = '{"result": "Here: [{\\"index\\":0,\\"violations\\":[\\"vague\\"],\\"rewrite\\":\\"be specific\\"}]"}'
        parsed = judge.parse_result(out)
        self.assertEqual(parsed[0]["index"], 0)

    def test_run_claude_missing_binary(self):
        with mock.patch("subprocess.run", side_effect=FileNotFoundError()):
            self.assertIsNone(judge.run_claude("hi"))

    def test_run_claude_timeout_returns_none(self):
        with mock.patch("subprocess.run",
                         side_effect=judge.subprocess.TimeoutExpired(cmd="claude", timeout=120)):
            self.assertIsNone(judge.run_claude("hi"))

    def test_judge_end_to_end_mocked(self):
        prompts = [{"text": "fix it", "model": "m"}]
        with mock.patch.object(judge, "run_claude",
                               return_value='{"result":"[{\\"index\\":0,\\"violations\\":[\\"vague\\"],\\"rewrite\\":\\"name the file\\"}]"}'):
            res = judge.judge([0], prompts, {})
            self.assertEqual(res[0]["rewrite"], "name the file")

    def test_judge_empty_indices(self):
        self.assertEqual(judge.judge([], [], {}), [])

if __name__ == "__main__":
    unittest.main()
