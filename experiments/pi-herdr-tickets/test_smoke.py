from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from smoke import validate


class SmokeValidationTests(unittest.TestCase):
    def setUp(self):
        self.start = {"mode": "tui", "historyEntries": 0, "sessionId": "a",
                      "sessionFile": "/saved.jsonl", "tools": ["read", "bash", "edit", "write"]}
        self.settled = {"sessionId": "a", "userMessages": 1, "idle": True,
                        "pending": False, "stopReason": "stop", "answer": "OK"}
        self.context = {"roles": ["user"]}
        self.resources = {"expandedPrompt": "This is the expanded smoke prompt."}

    def check(self):
        return validate(self.start, self.settled, self.context, self.resources, "OK", "/saved.jsonl")

    def test_valid_smoke(self):
        self.assertTrue(all(self.check().values()))

    def test_done_does_not_override_provider_error(self):
        self.settled["stopReason"] = "error"
        with self.assertRaisesRegex(RuntimeError, "normal_stop"):
            self.check()

    def test_context_inheritance_fails(self):
        self.start["historyEntries"] = 1
        with self.assertRaisesRegex(RuntimeError, "empty_history"):
            self.check()

    def test_session_replacement_fails(self):
        self.settled["sessionId"] = "b"
        with self.assertRaisesRegex(RuntimeError, "same_session"):
            self.check()

    def test_unexpanded_command_fails(self):
        self.resources["expandedPrompt"] = "/ticket-smoke Reply OK"
        with self.assertRaisesRegex(RuntimeError, "template_expanded"):
            self.check()

    def test_queued_work_fails(self):
        self.settled["pending"] = True
        with self.assertRaisesRegex(RuntimeError, "settled"):
            self.check()

    def test_rpc_is_not_normal_tui(self):
        self.start["mode"] = "rpc"
        with self.assertRaisesRegex(RuntimeError, "normal_tui"):
            self.check()

    def test_herdr_session_must_match(self):
        self.start["sessionFile"] = "/other.jsonl"
        with self.assertRaisesRegex(RuntimeError, "session_matches_herdr"):
            self.check()

    def test_wrong_answer_fails(self):
        self.settled["answer"] = "I need a decision from you"
        with self.assertRaisesRegex(RuntimeError, "answer"):
            self.check()

    def test_prior_messages_fail(self):
        self.context["roles"] = ["user", "assistant", "user"]
        with self.assertRaisesRegex(RuntimeError, "single_user_context"):
            self.check()


if __name__ == "__main__":
    unittest.main()
