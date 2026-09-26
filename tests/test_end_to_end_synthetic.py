"""End-to-end over real audio: WAV -> Whisper -> selection -> Laya -> record.

Covers plan Gate 2 (synthetic acceptance), Gate 3 (the transcription pad must
never leak attended text) and the Part 7 end-to-end classifier requirement.

Requires the cached whisper model and synthetic/synthetic_lecture.wav:
    .venv/bin/python tools/generate_synthetic_audio.py
"""

from __future__ import annotations

import json
import os
import unittest

from backend import config, stt
from backend.missed_selector import build_raw_text, select_missed_words
from backend.pipeline import build_missed_window_record
from tools.wav_util import slice_wav, write_silence

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "synthetic", "manifest.json")


def transcribe_window(audio, away_start, away_end, pad):
    """Exactly what the browser does: padded clip in, absolute words out."""
    clip_start = max(0, away_start - pad)
    path = slice_wav(audio, clip_start, away_end + pad)
    try:
        _segs, words, _text, _elapsed = stt.transcribe_clip(path, clip_start_ms=clip_start)
    finally:
        os.unlink(path)
    return words


@unittest.skipUnless(os.path.exists(MANIFEST), "run tools/generate_synthetic_audio.py")
class SyntheticLectureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(MANIFEST) as fh:
            cls.manifest = json.load(fh)
        cls.audio = os.path.join(ROOT, cls.manifest["audio"])
        cls.away = cls.manifest["away_window"]
        cls.words = transcribe_window(
            cls.audio, cls.away["start_ms"], cls.away["end_ms"], config.CLIP_PAD_MS
        )

    def missed_text(self):
        return build_raw_text(
            select_missed_words(self.words, self.away["start_ms"], self.away["end_ms"])
        )

    def test_missed_text_contains_the_deadline_change(self):
        low = self.missed_text().lower()
        for token in self.manifest["expect_contains"]:
            self.assertIn(token.lower(), low)

    def test_missed_text_excludes_both_attended_sentences(self):
        low = self.missed_text().lower()
        attended = [
            s for s in self.manifest["sentences"] if s["role"] == "attended"
        ]
        for sentence in attended:
            for token in sentence["text"].lower().replace(".", "").split():
                if len(token) < 5 or token in {"first", "please"}:
                    continue  # short/shared function words appear in both
                self.assertNotIn(
                    token, low, f"attended word {token!r} leaked into {low!r}"
                )

    def test_no_duplicated_text(self):
        words = self.missed_text().lower().split()
        grams = [" ".join(words[i:i + 4]) for i in range(len(words) - 3)]
        self.assertEqual(len(grams), len(set(grams)), f"duplicate run in {words}")

    def test_full_pipeline_produces_a_usable_record(self):
        record = build_missed_window_record(
            self.words, self.away["start_ms"], self.away["end_ms"]
        )
        self.assertTrue(record.raw_text)
        self.assertIn("friday", record.raw_text.lower())
        self.assertTrue(record.items, "no fragments produced")
        # Every fragment's text must be a substring of the preserved raw text.
        for item in record.items:
            self.assertIn(item.text, record.raw_text)

    @unittest.skipUnless(config.LAYA_ENABLED, "LAYA_ENABLED=0")
    def test_deadline_fragment_is_tagged_instruction_change(self):
        record = build_missed_window_record(
            self.words, self.away["start_ms"], self.away["end_ms"]
        )
        deadline = [i for i in record.items if "friday" in i.text.lower()]
        self.assertTrue(deadline, f"no Friday fragment in {[i.text for i in record.items]}")
        self.assertEqual(
            deadline[0].kind, "instruction_change",
            f"got {deadline[0].kind} for {deadline[0].text!r}",
        )
        self.assertTrue(deadline[0].show_by_default)

    def test_short_glance_over_the_same_audio_stores_nothing(self):
        record = build_missed_window_record(
            self.words, self.away["start_ms"], self.away["start_ms"] + 1999
        )
        self.assertEqual(record.raw_text, "")
        self.assertEqual(record.items, [])

    def test_silence_produces_no_missed_text(self):
        path = write_silence(3.0)
        try:
            _s, words, _t, _e = stt.transcribe_clip(path, clip_start_ms=0)
        finally:
            os.unlink(path)
        record = build_missed_window_record(words, 0, 3000)
        self.assertEqual(record.raw_text, "")


@unittest.skipUnless(os.path.exists(MANIFEST), "run tools/generate_synthetic_audio.py")
class TranscriptionPadSafetyTest(unittest.TestCase):
    """The pad buys Whisper acoustic context; it must never buy the user attended text.

    Whisper's word timestamps are approximate and it will stretch a word
    backwards across silence, so too large a pad can drag the NEXT sentence's
    first word inside the away window. Measured: 0-500 ms are safe on this
    fixture, 750 ms leaks. This test locks the configured value in.
    """

    SAFE_PADS = (0, 150, 250, 350, 500)

    @classmethod
    def setUpClass(cls):
        with open(MANIFEST) as fh:
            cls.manifest = json.load(fh)
        cls.audio = os.path.join(ROOT, cls.manifest["audio"])
        cls.away = cls.manifest["away_window"]

    def selection_for(self, pad):
        words = transcribe_window(
            self.audio, self.away["start_ms"], self.away["end_ms"], pad
        )
        return build_raw_text(
            select_missed_words(words, self.away["start_ms"], self.away["end_ms"])
        )

    def test_configured_pad_is_in_the_measured_safe_range(self):
        self.assertIn(
            config.CLIP_PAD_MS, self.SAFE_PADS,
            f"CLIP_PAD_MS={config.CLIP_PAD_MS} has not been validated; "
            f"measured-safe values are {self.SAFE_PADS}",
        )

    def test_configured_pad_does_not_leak_attended_text(self):
        low = self.selection_for(config.CLIP_PAD_MS).lower()
        for token in self.manifest["expect_absent"]:
            self.assertNotIn(token.lower(), low)
        self.assertFalse(
            low.rstrip(".,").endswith(" now"),
            f"attended sentence 3 leaked its first word: {low!r}",
        )

    def test_padded_and_unpadded_agree_on_the_missed_sentence(self):
        padded = self.selection_for(config.CLIP_PAD_MS).lower()
        unpadded = self.selection_for(0).lower()
        for token in self.manifest["expect_contains"]:
            self.assertIn(token.lower(), padded)
            self.assertIn(token.lower(), unpadded)


if __name__ == "__main__":
    unittest.main()
