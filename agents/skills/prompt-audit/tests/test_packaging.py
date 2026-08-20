import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import common, rubric

ROOT = Path(__file__).resolve().parent.parent

class TestPackaging(unittest.TestCase):
    def test_skill_frontmatter(self):
        meta, _ = common.parse_frontmatter((ROOT / "SKILL.md").read_text(encoding="utf-8"))
        self.assertIn("name", meta)
        self.assertIn("description", meta)

    def test_bundled_guide_parses_and_selects(self):
        rf = rubric._load_file(ROOT / "references" / "claude-opus-4-8.md")
        self.assertEqual(rf.kind, "judgment")
        self.assertTrue(rubric.applies_to(rf, "claude-opus-4-8"))

    def test_example_criteria_parses(self):
        rf = rubric._load_file(ROOT / "references" / "examples" / "my-criteria.example.md")
        self.assertIn(rf.kind, ("deterministic", "judgment"))

if __name__ == "__main__":
    unittest.main()
