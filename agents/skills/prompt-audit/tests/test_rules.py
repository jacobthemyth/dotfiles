import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import rules

class FakeFile:
    def __init__(self, meta): self.meta = meta

class TestRules(unittest.TestCase):
    def test_builtin_checks(self):
        self.assertIsNotNone(rules.CHECKS["faulty_premise"]("I thought we merged it", {}))
        self.assertIsNone(rules.CHECKS["faulty_premise"]("please merge it", {}))
        self.assertIsNotNone(rules.CHECKS["late_constraint"]("instead of a file, use a doc", {}))
        self.assertIsNotNone(rules.CHECKS["ambiguous_referent"]("fix it like I said", {}))
        self.assertIsNotNone(rules.CHECKS["banned_words"]("the corpus is big", {"banned_words": ["corpus"]}))
        self.assertIsNotNone(rules.CHECKS["max_words"]("a b c d", {"max_words": 3}))
        self.assertIsNone(rules.CHECKS["max_words"]("a b", {"max_words": 3}))

    def test_merge_and_apply(self):
        files = [FakeFile({"banned_words": ["corpus"], "max_words": 5, "enable": ["banned_words"]})]
        params, enabled = rules.merge_params(files)
        self.assertIn("banned_words", enabled)
        self.assertIn("max_words", enabled)
        findings = rules.apply_to_prompt("I thought the corpus of six words", params, enabled)
        kinds = {f["check"] for f in findings}
        self.assertIn("faulty_premise", kinds)   # default-enabled
        self.assertIn("banned_words", kinds)
        self.assertIn("max_words", kinds)

if __name__ == "__main__":
    unittest.main()
