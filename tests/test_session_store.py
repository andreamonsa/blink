"""Session accumulation for the summarizer hand-off (plan Gate 6)."""

import unittest

from backend.schemas import ClassifiedMissedItem, MissedWindowRecord
from backend.session_store import SessionStore


def item(text, start_ms, end_ms, kind="ordinary_context", priority=1):
    return ClassifiedMissedItem(
        start_ms=start_ms, end_ms=end_ms, text=text, kind=kind,
        priority=priority, show_by_default=kind != "ordinary_context",
    )


def record(start_ms, end_ms, raw_text, items=None, words=None):
    return MissedWindowRecord(
        start_ms=start_ms, end_ms=end_ms, raw_text=raw_text,
        items=items or [], words=words or [],
    )


class AccumulationTest(unittest.TestCase):
    def setUp(self):
        self.store = SessionStore()
        self.store.start_session("s1", started_at_ms=0.0)

    def test_three_windows_accumulate_in_timeline_order(self):
        self.store.append("s1", record(20_000, 25_000, "third window",
                                       [item("third window", 20_000, 25_000)]))
        self.store.append("s1", record(2_000, 5_000, "first window",
                                       [item("first window", 2_000, 5_000)]))
        self.store.append("s1", record(9_000, 13_000, "second window",
                                       [item("second window", 9_000, 13_000)]))

        session = self.store.get("s1")
        self.assertEqual([w.start_ms for w in session.windows], [2_000, 9_000, 20_000])
        self.assertEqual(
            [s.text for s in session.sentences],
            ["first window", "second window", "third window"],
        )
        self.assertEqual(
            session.raw_text, "first window\nsecond window\nthird window"
        )

    def test_flat_sentences_keep_kind_and_priority(self):
        self.store.append("s1", record(
            2_000, 5_000, "The assignment is now due Friday.",
            [item("The assignment is now due Friday.", 2_000, 5_000,
                  kind="instruction_change", priority=3)],
        ))
        self.store.append("s1", record(
            9_000, 12_000, "What answer did you get?",
            [item("What answer did you get?", 9_000, 12_000,
                  kind="question_to_you", priority=4)],
        ))

        sentences = self.store.get("s1").sentences
        self.assertEqual([s.kind for s in sentences],
                         ["instruction_change", "question_to_you"])
        self.assertEqual([s.priority for s in sentences], [3, 4])
        self.assertTrue(all(s.show_by_default for s in sentences))

    def test_ordinary_context_is_kept_not_dropped(self):
        self.store.append("s1", record(
            2_000, 5_000, "Elasticity measures responsiveness.",
            [item("Elasticity measures responsiveness.", 2_000, 5_000)],
        ))
        session = self.store.get("s1")
        self.assertEqual(len(session.sentences), 1)
        self.assertEqual(session.sentences[0].kind, "ordinary_context")
        self.assertFalse(session.sentences[0].show_by_default)
        # Collapsed in the compact card, but still fully recoverable.
        self.assertIn("Elasticity", session.raw_text)

    def test_short_glance_adds_nothing(self):
        # The pipeline yields an empty raw_text for a sub-threshold glance and
        # the API never appends it; an empty session must stay empty.
        session = self.store.get("s1")
        self.assertEqual(session.windows, [])
        self.assertEqual(session.sentences, [])
        self.assertEqual(session.raw_text, "")

    def test_sessions_are_isolated(self):
        self.store.start_session("s2")
        self.store.append("s1", record(0, 3_000, "alpha", [item("alpha", 0, 3_000)]))
        self.store.append("s2", record(0, 3_000, "beta", [item("beta", 0, 3_000)]))
        self.assertEqual(self.store.get("s1").raw_text, "alpha")
        self.assertEqual(self.store.get("s2").raw_text, "beta")

    def test_reset_clears_only_that_session(self):
        self.store.start_session("s2")
        self.store.append("s1", record(0, 3_000, "alpha", [item("alpha", 0, 3_000)]))
        self.store.append("s2", record(0, 3_000, "beta", [item("beta", 0, 3_000)]))
        self.store.reset("s1")
        self.assertEqual(self.store.get("s1").windows, [])
        self.assertEqual(self.store.get("s2").raw_text, "beta")


class OverlapMergeTest(unittest.TestCase):
    """A loose gaze debounce can emit overlapping windows; never duplicate."""

    def setUp(self):
        self.store = SessionStore()
        self.store.start_session("s1")

    def test_overlapping_windows_merge_without_duplicating_sentences(self):
        words_a = [
            {"start_ms": 2_000, "end_ms": 2_400, "text": "The"},
            {"start_ms": 2_400, "end_ms": 3_000, "text": "assignment"},
            {"start_ms": 3_000, "end_ms": 3_600, "text": "moved."},
        ]
        words_b = [
            {"start_ms": 3_000, "end_ms": 3_600, "text": "moved."},
            {"start_ms": 3_600, "end_ms": 4_200, "text": "Read"},
            {"start_ms": 4_200, "end_ms": 4_800, "text": "chapter."},
        ]
        self.store.append("s1", record(
            2_000, 3_600, "The assignment moved.",
            [item("The assignment moved.", 2_000, 3_600, "instruction_change", 3)],
            words_a))
        self.store.append("s1", record(
            3_000, 4_800, "moved. Read chapter.",
            [item("moved. Read chapter.", 3_000, 4_800, "instruction_change", 3)],
            words_b))

        session = self.store.get("s1")
        self.assertEqual(len(session.windows), 1, "overlapping windows must merge")
        merged = session.windows[0]
        self.assertEqual((merged.start_ms, merged.end_ms), (2_000, 4_800))
        # "moved." appeared in both clips but survives exactly once.
        self.assertEqual(merged.raw_text, "The assignment moved. Read chapter.")
        self.assertEqual(merged.raw_text.count("moved."), 1)

    def test_identical_window_appended_twice_does_not_duplicate(self):
        words = [{"start_ms": 2_000, "end_ms": 2_600, "text": "Friday."}]
        for _ in range(2):
            self.store.append("s1", record(
                2_000, 4_100, "Friday.", [item("Friday.", 2_000, 2_600)], words))
        session = self.store.get("s1")
        self.assertEqual(len(session.windows), 1)
        self.assertEqual(session.windows[0].raw_text, "Friday.")
        self.assertEqual(len(session.sentences), 1)

    def test_adjacent_non_overlapping_windows_stay_separate(self):
        self.store.append("s1", record(2_000, 4_000, "first", [item("first", 2_000, 4_000)]))
        self.store.append("s1", record(9_000, 11_000, "second", [item("second", 9_000, 11_000)]))
        self.assertEqual(len(self.store.get("s1").windows), 2)

    def test_merge_keeps_classifier_failure_visible(self):
        a = record(2_000, 4_000, "alpha", [item("alpha", 2_000, 4_000)])
        b = record(3_000, 5_000, "beta", [item("beta", 3_000, 5_000)])
        b.classifier_ok = False
        self.store.append("s1", a)
        self.store.append("s1", b)
        self.assertFalse(self.store.get("s1").windows[0].classifier_ok)


if __name__ == "__main__":
    unittest.main()
