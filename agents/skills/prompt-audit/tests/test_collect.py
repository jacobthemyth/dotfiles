import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import collect

def user(text, session="s1", ts="2026-08-09T00:00:00Z", **kw):
    e = {"type": "user", "sessionId": session, "timestamp": ts, "cwd": "/x/proj",
         "message": {"role": "user", "content": text}}
    e.update(kw)
    return e

def asst(model="claude-opus-4-8", session="s1"):
    return {"type": "assistant", "sessionId": session, "message": {"role": "assistant", "model": model}}

class TestCollect(unittest.TestCase):
    def test_genuine_only_and_model(self):
        events = [user("real prompt"), asst("claude-opus-4-8")]
        out = collect.prompts_from_events(events)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["text"], "real prompt")
        self.assertEqual(out[0]["model"], "claude-opus-4-8")
        self.assertEqual(out[0]["project"], "proj")

    def test_filters(self):
        events = [
            user("real"),
            user("<teammate-message>x</teammate-message>"),
            user("[SYSTEM NOTIFICATION] bg"),
            user("side", isSidechain=True),
            user("meta", isMeta=True),
            {"type": "user", "sessionId": "s1",
             "message": {"role": "user", "content": [{"type": "tool_result", "content": "r"}]}},
            user("<command-name>/clear</command-name>"),
        ]
        out = collect.prompts_from_events(events)
        self.assertEqual([p["text"] for p in out], ["real"])

    def test_strips_system_reminder(self):
        out = collect.prompts_from_events([user("keep <system-reminder>drop</system-reminder>")])
        self.assertEqual(out[0]["text"], "keep")

    def test_command_name_match_is_anchored(self):
        # A genuine prompt that merely quotes the tag is retained; only a
        # message opening with the scaffold tag is dropped (bees-hyxj).
        events = [
            user("How do I emit <command-name>foo</command-name> in output?"),
            user("<command-name>/clear</command-name>\n<command-message>clear</command-message>"),
        ]
        out = collect.prompts_from_events(events)
        self.assertEqual([p["text"] for p in out],
                         ["How do I emit <command-name>foo</command-name> in output?"])

    def test_filters_compact_summary_and_hook_and_bash(self):
        events = [
            user("real"),
            user("summary", isCompactSummary=True),
            user("<post-tool-use-hook>x</post-tool-use-hook>"),
            user("<user-prompt-submit-hook>y"),
            user("<bash-stdout>out</bash-stdout>"),
            user("<bash-input>ls</bash-input>"),
        ]
        out = collect.prompts_from_events(events)
        self.assertEqual([p["text"] for p in out], ["real"])

    def test_model_attribution_isolated_per_session(self):
        # An assistant turn in one session must not label a pending prompt in
        # another session.
        events = [
            user("in s1", session="s1"),
            user("in s2", session="s2"),
            asst(model="claude-opus-4-8", session="s2"),
            asst(model="claude-sonnet-4-6", session="s1"),
        ]
        out = {p["session"]: p["model"] for p in collect.prompts_from_events(events)}
        self.assertEqual(out, {"s1": "claude-sonnet-4-6", "s2": "claude-opus-4-8"})

    def test_since_filter(self):
        events = [user("old", ts="2026-08-01T00:00:00Z"), asst(),
                  user("new", ts="2026-08-09T00:00:00Z"), asst()]
        out = collect.collect_from(events, since="2026-08-05T00:00:00Z")
        self.assertEqual([p["text"] for p in out], ["new"])

if __name__ == "__main__":
    unittest.main()
