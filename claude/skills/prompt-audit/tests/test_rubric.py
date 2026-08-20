import sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import rubric

def write(d, name, text):
    p = Path(d) / name
    p.write_text(text, encoding="utf-8")
    return p

class TestRubric(unittest.TestCase):
    def test_select_by_model_and_kind(self):
        with tempfile.TemporaryDirectory() as d:
            write(d, "opus.md", '---\nmodel: claude-opus-4-8\nkind: judgment\n---\nGuide\n')
            write(d, "any.md", '---\nmodel: "*"\nkind: deterministic\nmax_words: 400\n---\n')
            write(d, "multi.md", '---\nmodel: [a, claude-opus-4-8]\nkind: judgment\n---\n')
            files = rubric.load_dir(Path(d))
            res = rubric.resolve_for_model("claude-opus-4-8", files)
            self.assertEqual(len(res["judgment"]), 2)      # opus.md + multi.md
            self.assertEqual(len(res["deterministic"]), 1)  # any.md (wildcard)
            res_other = rubric.resolve_for_model("claude-sonnet-4-6", files)
            self.assertEqual(len(res_other["judgment"]), 0)
            self.assertEqual(len(res_other["deterministic"]), 1)

    def test_none_model_gets_only_wildcard(self):
        with tempfile.TemporaryDirectory() as d:
            write(d, "opus.md", '---\nmodel: claude-opus-4-8\nkind: judgment\n---\n')
            write(d, "any.md", '---\nkind: judgment\n---\n')  # no model key => wildcard
            files = rubric.load_dir(Path(d))
            res = rubric.resolve_for_model(None, files)
            self.assertEqual(len(res["judgment"]), 1)

    def test_missing_dir(self):
        self.assertEqual(rubric.load_dir(Path("/no/such/dir")), [])

    def test_unreadable_file_is_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            # Invalid UTF-8 bytes must not crash load_dir; the file is skipped.
            bad = Path(d) / "bad.md"
            bad.write_bytes(b"---\nkind: judgment\n---\n\xff\xfe invalid utf-8 \xff")
            write(d, "good.md", '---\nkind: judgment\n---\nGuide\n')
            files = rubric.load_dir(Path(d))
            self.assertEqual(len(files), 1)
            self.assertEqual(files[0].path.name, "good.md")

if __name__ == "__main__":
    unittest.main()
