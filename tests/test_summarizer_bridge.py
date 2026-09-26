"""The bridge to the teammate's Ollama summarizer.

Runs with a fake `summarizer` module, so it needs neither Ollama nor the
teammate's branch. The real module's contract (from origin/summarizer):
    summarize(text: str, max_words: int = 60) -> str
    warm_up() -> None
    raises RuntimeError when Ollama is unreachable or the model is missing.
"""

from __future__ import annotations

import types
import unittest

from fastapi.testclient import TestClient

from backend import summarizer_bridge as bridge
from backend.app import app
from backend.schemas import ClassifiedMissedItem, MissedWindowRecord
from backend.session_store import store


def item(text, start_ms, kind="ordinary_context", priority=1):
    return ClassifiedMissedItem(start_ms=start_ms, end_ms=start_ms + 1000, text=text,
                                kind=kind, priority=priority,
                                show_by_default=kind != "ordinary_context")


def window(start_ms, end_ms, raw, items):
    return MissedWindowRecord(start_ms=start_ms, end_ms=end_ms, raw_text=raw, items=items)


class FakeSummarizer(types.ModuleType):
    """Records exactly what text reached 'Ollama'."""

    def __init__(self, fail=None):
        super().__init__("summarizer")
        self.calls = []
        self.fail = fail
        self.MODEL = "qwen2.5:3b-instruct-q5_K_M"
        self.warmed = False

    def summarize(self, text, max_words=60):
        self.calls.append((text, max_words))
        if self.fail:
            raise self.fail
        return f"SUMMARY<{text[:30]}>"

    def warm_up(self):
        self.warmed = True


DEADLINE = window(
    5_000, 11_000,
    "IMPORTANT CHANGE. The assignment is now due on Friday, not Monday.",
    [item("IMPORTANT CHANGE.", 5_000),
     item("The assignment is now due on Friday, not Monday.", 6_000,
          "instruction_change", 3)],
)
QUESTION = window(
    20_000, 25_000,
    "Can you tell me why the demand curve shifts? Elasticity measures response.",
    [item("Can you tell me why the demand curve shifts?", 20_000, "question_to_you", 4),
     item("Elasticity measures response.", 22_000)],
)


class PrioritiesTest(unittest.TestCase):
    """Laya tags fill the card's 'Priorities:' slot."""

    def test_only_actionable_kinds_become_priorities(self):
        got = bridge.priorities_from_items(DEADLINE.items + QUESTION.items)
        self.assertEqual(got, [
            "Can you tell me why the demand curve shifts?",           # priority 4
            "The assignment is now due on Friday, not Monday.",       # priority 3
        ])

    def test_ordinary_context_is_never_a_priority(self):
        got = bridge.priorities_from_items([item("Elasticity measures response.", 0)])
        self.assertEqual(got, [])

    def test_equal_priority_orders_by_time(self):
        got = bridge.priorities_from_items([
            item("later", 9_000, "instruction_change", 3),
            item("earlier", 1_000, "instruction_change", 3),
        ])
        self.assertEqual(got, ["earlier", "later"])

    def test_unclassified_is_not_promoted(self):
        # When Laya failed, fragments are unclassified; they stay in the exact
        # words but must not masquerade as priorities.
        got = bridge.priorities_from_items([item("anything", 0, "unclassified", 1)])
        self.assertEqual(got, [])


class SummarizeWindowsTest(unittest.TestCase):
    def tearDown(self):
        bridge._reset_for_tests(None, None)

    def test_one_window_gives_a_prose_summary(self):
        fake = FakeSummarizer()
        bridge._reset_for_tests(fake)
        result = bridge.summarize_windows([DEADLINE])
        self.assertIsInstance(result["summary"], str)
        self.assertTrue(result["summarizer_ok"])
        self.assertEqual(result["priorities"],
                         ["The assignment is now due on Friday, not Monday."])

    def test_several_windows_are_summarized_separately_not_concatenated(self):
        """Their model reads one string as one passage and knows nothing of gaps."""
        fake = FakeSummarizer()
        bridge._reset_for_tests(fake)
        result = bridge.summarize_windows([DEADLINE, QUESTION])
        self.assertIsInstance(result["summary"], list, "multiple windows -> bullets")
        self.assertEqual(len(fake.calls), 2)
        self.assertEqual(fake.calls[0][0], DEADLINE.raw_text)
        self.assertEqual(fake.calls[1][0], QUESTION.raw_text)

    def test_ollama_down_still_returns_priorities(self):
        fake = FakeSummarizer(fail=RuntimeError("Cannot reach Ollama at localhost:11434"))
        bridge._reset_for_tests(fake)
        result = bridge.summarize_windows([DEADLINE])
        self.assertIsNone(result["summary"])
        self.assertFalse(result["summarizer_ok"])
        self.assertIn("Ollama", result["error"])
        self.assertEqual(result["priorities"],
                         ["The assignment is now due on Friday, not Monday."],
                         "Laya priorities must survive a dead summarizer")

    def test_module_missing_degrades_without_raising(self):
        bridge._reset_for_tests(None, "summarizer.py not importable")
        result = bridge.summarize_windows([DEADLINE])
        self.assertIsNone(result["summary"])
        self.assertFalse(result["summarizer_ok"])
        self.assertTrue(result["priorities"])

    def test_empty_windows_never_call_the_model(self):
        fake = FakeSummarizer()
        bridge._reset_for_tests(fake)
        result = bridge.summarize_windows([window(0, 3000, "", [])])
        self.assertEqual(fake.calls, [])
        self.assertIsNone(result["summary"])

    def test_window_count_is_capped(self):
        fake = FakeSummarizer()
        bridge._reset_for_tests(fake)
        many = [window(i * 10_000, i * 10_000 + 3000, f"window {i}", [item(f"window {i}", i * 10_000)])
                for i in range(9)]
        bridge.summarize_windows(many)
        self.assertEqual(len(fake.calls), bridge.MAX_WINDOWS_PER_SUMMARY)
        self.assertEqual(fake.calls[-1][0], "window 8", "the most recent windows are kept")

    def test_warm_up_is_called_and_never_raises(self):
        fake = FakeSummarizer()
        bridge._reset_for_tests(fake)
        self.assertIsNotNone(bridge.warm_up())
        self.assertTrue(fake.warmed)

        broken = FakeSummarizer()
        broken.warm_up = lambda: (_ for _ in ()).throw(RuntimeError("no ollama"))
        bridge._reset_for_tests(broken)
        self.assertIsNone(bridge.warm_up())


class OnlyMissedTextReachesTheLLMTest(unittest.TestCase):
    """The invariant, end to end through the HTTP bridge."""

    def setUp(self):
        store.reset()
        self.fake = FakeSummarizer()
        bridge._reset_for_tests(self.fake)
        self.client = TestClient(app)

    def tearDown(self):
        bridge._reset_for_tests(None, None)
        store.reset()

    def test_endpoint_reads_the_store_and_never_accepts_free_text(self):
        store.append("inv", DEADLINE)
        response = self.client.post(
            "/session/inv/summarize",
            json={"from_ms": 5_000, "to_ms": 11_000,
                  # A misbehaving client trying to smuggle attended speech in:
                  "text": "Today we are reviewing pricing strategy."},
        )
        self.assertEqual(response.status_code, 200)
        sent = " ".join(text for text, _ in self.fake.calls)
        self.assertNotIn("pricing", sent, "client-supplied text reached the LLM")
        self.assertIn("Friday", sent)

    def test_range_selects_only_overlapping_windows(self):
        store.append("inv", DEADLINE)
        store.append("inv", QUESTION)
        self.client.post("/session/inv/summarize", json={"from_ms": 19_000, "to_ms": 26_000})
        sent = [text for text, _ in self.fake.calls]
        self.assertEqual(sent, [QUESTION.raw_text])

    def test_session_summary_covers_everything_missed(self):
        store.append("inv", DEADLINE)
        store.append("inv", QUESTION)
        body = self.client.get("/session/inv/summary").json()
        self.assertEqual(body["windows"], 2)
        self.assertEqual(len(body["priorities"]), 2)

    def test_unknown_session_is_empty_not_an_error(self):
        body = self.client.post("/session/none/summarize",
                                json={"from_ms": 0, "to_ms": 99_999}).json()
        self.assertEqual(body["windows"], 0)
        self.assertEqual(self.fake.calls, [])

    def test_health_reports_summarizer_status(self):
        body = self.client.get("/health").json()
        self.assertIn("summarizer", body)
        self.assertIn("chunk_ms", body)


if __name__ == "__main__":
    unittest.main()
