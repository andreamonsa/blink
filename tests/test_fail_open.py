"""The classifier must never be able to hide or lose missed text (Gate 5).

Laya is a ranking accelerator. STT plus exact time filtering is the
product-critical path, so every classifier failure mode must still return the
complete raw missed text with kind="unclassified" and show_by_default=True.
"""

from __future__ import annotations

import unittest
from unittest import mock

from backend import classifier, config
from backend.pipeline import build_missed_window_record

WORDS = [
    {"start_ms": 2000, "end_ms": 2300, "text": "IMPORTANT"},
    {"start_ms": 2300, "end_ms": 2900, "text": "CHANGE."},
    {"start_ms": 2900, "end_ms": 3200, "text": "The"},
    {"start_ms": 3200, "end_ms": 3800, "text": "assignment"},
    {"start_ms": 3800, "end_ms": 4000, "text": "is"},
    {"start_ms": 4000, "end_ms": 4300, "text": "due"},
    {"start_ms": 4300, "end_ms": 4900, "text": "Friday."},
]
EXPECTED_RAW = "IMPORTANT CHANGE. The assignment is due Friday."


def assert_recovery_intact(case, record):
    case.assertEqual(record.raw_text, EXPECTED_RAW)
    case.assertTrue(record.items, "fragments disappeared")
    case.assertEqual(
        " ".join(i.text for i in record.items), EXPECTED_RAW,
        "fragments do not reconstruct the raw missed text",
    )
    for item in record.items:
        case.assertTrue(item.show_by_default, f"{item.text!r} would be hidden")


class LayaDisabledTest(unittest.TestCase):
    def test_disabled_classifier_still_returns_everything(self):
        with mock.patch.object(config, "LAYA_ENABLED", False):
            items, ok = classifier.classify_missed_fragments(["The deadline moved."])
        self.assertFalse(ok)
        self.assertEqual(items[0]["kind"], "unclassified")
        self.assertTrue(items[0]["show_by_default"])
        self.assertEqual(items[0]["priority"], 1)

    def test_pipeline_with_disabled_classifier(self):
        with mock.patch.object(config, "LAYA_ENABLED", False):
            record = build_missed_window_record(WORDS, 2000, 5000)
        assert_recovery_intact(self, record)
        self.assertFalse(record.classifier_ok)
        self.assertTrue(all(i.kind == "unclassified" for i in record.items))


class LayaRaisesTest(unittest.TestCase):
    def test_predict_batch_raising_does_not_lose_text(self):
        broken = mock.Mock()
        broken.predict_batch.side_effect = RuntimeError("MPS out of memory")
        with mock.patch.object(classifier, "get_agent", return_value=broken):
            record = build_missed_window_record(WORDS, 2000, 5000)
        assert_recovery_intact(self, record)
        self.assertFalse(record.classifier_ok)

    def test_model_failing_to_load_does_not_lose_text(self):
        with mock.patch.object(classifier, "get_agent", return_value=None):
            record = build_missed_window_record(WORDS, 2000, 5000)
        assert_recovery_intact(self, record)
        self.assertFalse(record.classifier_ok)

    def test_malformed_answer_shape_fails_open(self):
        broken = mock.Mock()
        broken.predict_batch.return_value = [{"unexpected": "shape"}, {"answers": {}}]
        with mock.patch.object(classifier, "get_agent", return_value=broken):
            items, ok = classifier.classify_missed_fragments(["one.", "two."])
        self.assertEqual([i["kind"] for i in items], ["unclassified", "unclassified"])
        self.assertTrue(all(i["show_by_default"] for i in items))

    def test_unknown_choice_key_becomes_unclassified_and_is_shown(self):
        agent = mock.Mock()
        agent.predict_batch.return_value = [
            {"answers": {"missed_kind": {"choice": "Z", "answer_confidence": 0.9}}}
        ]
        with mock.patch.object(classifier, "get_agent", return_value=agent):
            items, _ok = classifier.classify_missed_fragments(["mystery."])
        self.assertEqual(items[0]["kind"], "unclassified")
        self.assertTrue(items[0]["show_by_default"])

    def test_classifier_returning_too_few_items_does_not_drop_fragments(self):
        agent = mock.Mock()
        # Two fragments in, one answer back.
        agent.predict_batch.return_value = [
            {"answers": {"missed_kind": {"choice": "B", "answer_confidence": 0.8}}}
        ]
        with mock.patch.object(classifier, "get_agent", return_value=agent):
            record = build_missed_window_record(WORDS, 2000, 5000)
        assert_recovery_intact(self, record)
        self.assertFalse(record.classifier_ok)


class OrdinaryContextIsNeverDeletedTest(unittest.TestCase):
    def test_ordinary_context_collapses_but_survives_in_raw_text(self):
        agent = mock.Mock()
        agent.predict_batch.return_value = [
            {"answers": {"missed_kind": {"choice": "D", "answer_confidence": 0.9}}},
            {"answers": {"missed_kind": {"choice": "D", "answer_confidence": 0.9}}},
        ]
        with mock.patch.object(classifier, "get_agent", return_value=agent):
            record = build_missed_window_record(WORDS, 2000, 5000)

        self.assertTrue(all(i.kind == "ordinary_context" for i in record.items))
        # Collapsed from the compact card...
        self.assertTrue(all(not i.show_by_default for i in record.items))
        # ...but every word is still recoverable.
        self.assertEqual(record.raw_text, EXPECTED_RAW)

    def test_confidence_never_gates_visibility(self):
        agent = mock.Mock()
        agent.predict_batch.return_value = [
            {"answers": {"missed_kind": {"choice": "B", "answer_confidence": 0.01,
                                         "confidence": 0.0}}},
            {"answers": {"missed_kind": {"choice": "A", "answer_confidence": 0.02,
                                         "confidence": 0.0}}},
        ]
        with mock.patch.object(classifier, "get_agent", return_value=agent):
            record = build_missed_window_record(WORDS, 2000, 5000)
        self.assertTrue(all(i.show_by_default for i in record.items))
        self.assertEqual(record.raw_text, EXPECTED_RAW)


class CardOrderingTest(unittest.TestCase):
    def test_sort_is_priority_desc_then_start_asc(self):
        items = [
            {"priority": 1, "start_ms": 100, "text": "d"},
            {"priority": 4, "start_ms": 900, "text": "a"},
            {"priority": 3, "start_ms": 500, "text": "b"},
            {"priority": 3, "start_ms": 200, "text": "c"},
        ]
        self.assertEqual(
            [i["text"] for i in classifier.sort_for_card(items)], ["a", "c", "b", "d"]
        )


if __name__ == "__main__":
    unittest.main()
