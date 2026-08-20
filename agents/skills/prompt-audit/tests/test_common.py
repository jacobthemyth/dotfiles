import os, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import common

class TestCommon(unittest.TestCase):
    def test_xdg_override(self):
        os.environ["XDG_CONFIG_HOME"] = "/tmp/cfg"
        self.assertEqual(common.criteria_dir(), Path("/tmp/cfg/prompt-audit"))
        del os.environ["XDG_CONFIG_HOME"]
        self.assertEqual(common.criteria_dir(), Path.home() / ".config" / "prompt-audit")

    def test_frontmatter_scalar_list_quoted(self):
        meta, body = common.parse_frontmatter('---\nmodel: claude-opus-4-8\nkind: judgment\n---\nHi\n')
        self.assertEqual(meta, {"model": "claude-opus-4-8", "kind": "judgment"})
        self.assertEqual(body.strip(), "Hi")
        meta2, _ = common.parse_frontmatter('---\nmodel: [a, b]\n---\n')
        self.assertEqual(meta2["model"], ["a", "b"])
        meta3, _ = common.parse_frontmatter('---\nmodel: "*"\n---\n')
        self.assertEqual(meta3["model"], "*")

    def test_frontmatter_absent(self):
        self.assertEqual(common.parse_frontmatter("no fm"), ({}, "no fm"))

    def test_frontmatter_list_respects_quoted_comma(self):
        # A quoted list item containing a comma is one item, not two (bees-1ap8).
        meta, _ = common.parse_frontmatter('---\nbanned_words: [a, "b, c"]\n---\n')
        self.assertEqual(meta["banned_words"], ["a", "b, c"])

    def test_json_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "sub" / "x.json"
            common.write_json(p, {"a": 1})
            self.assertEqual(common.read_json(p), {"a": 1})
            self.assertIsNone(common.read_json(Path(d) / "missing.json"))

    def test_read_json_bad_encoding_returns_default(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "bad.json"
            p.write_bytes(b"\xff\xfe not valid utf-8 \xff")
            self.assertIsNone(common.read_json(p))
            self.assertEqual(common.read_json(p, default={}), {})

if __name__ == "__main__":
    unittest.main()
