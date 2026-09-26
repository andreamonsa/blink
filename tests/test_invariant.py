"""The non-negotiable product invariant, asserted rather than assumed.

  The durable transcript must contain only information the student missed,
  and Laya must never receive or persist attended lecture text.

These tests spy on what the classifier is actually handed and on what reaches
the session store, so a future refactor that routes the full transcript into
either one fails here.
"""

from __future__ import annotations

import json
import os
import unittest
from unittest import mock

from backend import classifier, config
from backend.pipeline import build_missed_window_record
from backend.session_store import SessionStore

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "synthetic", "manifest.json")

# A full lecture on one timeline: attended, missed, attended.
FULL_LECTURE = [
    # attended sentence 1
    {"start_ms": 500, "end_ms": 900, "text": "Today"},
    {"start_ms": 900, "end_ms": 1300, "text": "we"},
    {"start_ms": 1300, "end_ms": 2100, "text": "review"},
    {"start_ms": 2100, "end_ms": 3000, "text": "pricing"},
    {"start_ms": 3000, "end_ms": 3900, "text": "strategy."},
    # missed sentence
    {"start_ms": 5000, "end_ms": 5600, "text": "IMPORTANT"},
    {"start_ms": 5600, "end_ms": 6300, "text": "CHANGE."},
    {"start_ms": 6300, "end_ms": 6600, "text": "The"},
    {"start_ms": 6600, "end_ms": 7400, "text": "assignment"},
    {"start_ms": 7400, "end_ms": 7700, "text": "is"},
    {"start_ms": 7700, "end_ms": 8100, "text": "due"},
    {"start_ms": 8100, "end_ms": 8900, "text": "Friday."},
    # attended sentence 3
    {"start_ms": 10000, "end_ms": 10400, "text": "Now"},
    {"start_ms": 10400, "end_ms": 10900, "text": "open"},
    {"start_ms": 10900, "end_ms": 11600, "text": "slide"},
    {"start_ms": 11600, "end_ms": 12400, "text": "twelve."},
]
AWAY = (4800, 9200)
ATTENDED_TOKENS = ["Today", "review", "pricing", "strategy", "open", "slide", "twelve"]
MISSED_TEXT = "IMPORTANT CHANGE. The assignment is due Friday."


class ClassifierNeverSeesAttendedTextTest(unittest.TestCase):
    def test_classifier_receives_only_missed_fragments(self):
        seen = []
        real = classifier.classify_missed_fragments

        def spy(texts):
            seen.extend(texts)
            return real(texts)

        with mock.patch.object(classifier, "classify_missed_fragments", side_effect=spy):
            with mock.patch.object(config, "LAYA_ENABLED", False):
                build_missed_window_record(FULL_LECTURE, *AWAY)

        self.assertTrue(seen, "the classifier was never called")
        blob = " ".join(seen)
        for token in ATTENDED_TOKENS:
            self.assertNotIn(token, blob, f"attended word {token!r} reached the classifier")
        self.assertEqual(" ".join(seen), MISSED_TEXT)

    def test_classifier_input_is_derived_from_the_selection_not_the_transcript(self):
        """Every classified fragment must be a substring of the missed raw text."""
        with mock.patch.object(config, "LAYA_ENABLED", False):
            record = build_missed_window_record(FULL_LECTURE, *AWAY)
        for item in record.items:
            self.assertIn(item.text, record.raw_text)

    def test_a_short_glance_sends_the_classifier_nothing(self):
        seen = []
        with mock.patch.object(
            classifier, "classify_missed_fragments",
            side_effect=lambda texts: (seen.extend(texts), ([], True))[1],
        ):
            record = build_missed_window_record(FULL_LECTURE, 5000, 6999)
        self.assertEqual(seen, [])
        self.assertEqual(record.raw_text, "")


class StoreNeverHoldsAttendedTextTest(unittest.TestCase):
    def test_session_transcript_contains_only_missed_words(self):
        store = SessionStore()
        store.start_session("inv")
        with mock.patch.object(config, "LAYA_ENABLED", False):
            store.append("inv", build_missed_window_record(FULL_LECTURE, *AWAY))

        session = store.get("inv")
        self.assertEqual(session.raw_text, MISSED_TEXT)
        for token in ATTENDED_TOKENS:
            self.assertNotIn(token, session.raw_text)
            self.assertNotIn(token, " ".join(s.text for s in session.sentences))
            self.assertNotIn(
                token, " ".join(w.text for win in session.windows for w in win.words)
            )

    def test_two_windows_around_attended_speech_stay_clean(self):
        store = SessionStore()
        store.start_session("inv")
        with mock.patch.object(config, "LAYA_ENABLED", False):
            # Away during sentence 1, back, then away during sentence 3.
            store.append("inv", build_missed_window_record(FULL_LECTURE, 400, 4000))
            store.append("inv", build_missed_window_record(FULL_LECTURE, 9900, 12500))

        raw = store.get("inv").raw_text
        # The middle sentence was attended this time, so it must be absent.
        for token in ["IMPORTANT", "CHANGE.", "assignment", "Friday."]:
            self.assertNotIn(token, raw, f"attended word {token!r} was persisted")
        self.assertIn("pricing", raw)
        self.assertIn("slide", raw)


@unittest.skipUnless(os.path.exists(MANIFEST), "run tools/generate_synthetic_audio.py")
class RealAudioInvariantTest(unittest.TestCase):
    """The same guarantee over real Whisper output, not a hand-made word list."""

    def test_real_transcription_never_persists_attended_sentences(self):
        from backend import stt
        from tools.wav_util import slice_wav

        with open(MANIFEST) as fh:
            manifest = json.load(fh)
        away = manifest["away_window"]
        pad = config.CLIP_PAD_MS

        clip = slice_wav(
            os.path.join(ROOT, manifest["audio"]),
            away["start_ms"] - pad,
            away["end_ms"] + pad,
        )
        try:
            _s, words, _t, _e = stt.transcribe_clip(
                clip, clip_start_ms=max(0, away["start_ms"] - pad)
            )
        finally:
            os.unlink(clip)

        seen = []
        real = classifier.classify_missed_fragments
        with mock.patch.object(
            classifier, "classify_missed_fragments",
            side_effect=lambda texts: (seen.extend(texts), real(texts))[1],
        ):
            record = build_missed_window_record(words, away["start_ms"], away["end_ms"])

        store = SessionStore()
        store.append("real", record)
        everything = " ".join([
            record.raw_text,
            store.get("real").raw_text,
            " ".join(seen),
        ]).lower()

        for token in manifest["expect_absent"]:
            self.assertNotIn(
                token.lower(), everything,
                f"attended word {token!r} reached the classifier or the store",
            )


if __name__ == "__main__":
    unittest.main()
