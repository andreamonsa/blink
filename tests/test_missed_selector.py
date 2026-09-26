"""Deterministic tests for the missed-word selector (CLAUDE.md Part 9A).

These run with no models, no network and no audio. If any of them fail,
nothing downstream is trustworthy, so they gate the rest of the build.
"""

import unittest

from backend.missed_selector import (
    DEFAULT_THRESHOLD_MS,
    InvalidAwayInterval,
    build_raw_text,
    dedupe_words,
    fragment_missed_text,
    is_valid_away_window,
    select_missed_words,
)


def word(text, start_ms, end_ms):
    return {"text": text, "start_ms": start_ms, "end_ms": end_ms}


def words_from(spec):
    """Build a word list from (text, start_ms, end_ms) triples."""
    return [word(*triple) for triple in spec]


# One sentence spanning a gaze boundary on each side, as in the CLAUDE.md example:
#   "As I said before, [LOOK AWAY] the deadline changed to Friday [LOOK BACK], and next week..."
LECTURE = words_from(
    [
        ("As", 0, 300),
        ("I", 300, 500),
        ("said", 500, 900),
        ("before,", 900, 1400),
        # away window starts at 2000
        ("the", 2000, 2300),
        ("deadline", 2300, 2900),
        ("changed", 2900, 3400),
        ("to", 3400, 3600),
        ("Friday.", 3600, 4200),
        # away window ends at 4500
        ("And", 5000, 5300),
        ("next", 5300, 5700),
        ("week", 5700, 6100),
        ("we", 6100, 6300),
        ("continue.", 6300, 7000),
    ]
)

ATTENDED_BEFORE = {"As", "I", "said", "before,"}
ATTENDED_AFTER = {"And", "next", "week", "we", "continue."}


class TwoSecondRuleTest(unittest.TestCase):
    """An away interval only counts at >= 2000 ms, and is never shortened."""

    def test_1999ms_away_stores_nothing(self):
        selected = select_missed_words(LECTURE, 2000, 3999)
        self.assertEqual(selected, [])
        self.assertEqual(build_raw_text(selected), "")

    def test_exactly_2000ms_away_is_valid(self):
        selected = select_missed_words(LECTURE, 2000, 4000)
        self.assertNotEqual(selected, [])
        self.assertTrue(is_valid_away_window(2000, 4000))

    def test_first_two_seconds_are_included_not_skipped(self):
        # The interval must not be re-based to away_start + 2000: "the deadline"
        # is spoken inside the first two seconds and must survive.
        raw = build_raw_text(select_missed_words(LECTURE, 2000, 4500))
        self.assertTrue(raw.startswith("the deadline"), raw)

    def test_threshold_is_configurable(self):
        self.assertEqual(select_missed_words(LECTURE, 2000, 3000, threshold_ms=500) != [], True)
        self.assertEqual(DEFAULT_THRESHOLD_MS, 2000)


class AttendedContentExclusionTest(unittest.TestCase):
    """The durable transcript may never contain attended lecture text."""

    def test_attended_text_before_away_is_excluded(self):
        raw = build_raw_text(select_missed_words(LECTURE, 2000, 4500))
        for token in ATTENDED_BEFORE:
            self.assertNotIn(token, raw.split(), f"leaked attended word {token!r}: {raw!r}")

    def test_attended_text_after_return_is_excluded(self):
        raw = build_raw_text(select_missed_words(LECTURE, 2000, 4500))
        for token in ATTENDED_AFTER:
            self.assertNotIn(token, raw.split(), f"leaked attended word {token!r}: {raw!r}")

    def test_sentence_crossing_boundary_is_trimmed_at_word_level(self):
        # The central correctness requirement: words, not whole segments.
        raw = build_raw_text(select_missed_words(LECTURE, 2000, 4500))
        self.assertEqual(raw, "the deadline changed to Friday.")


class BoundaryWordTest(unittest.TestCase):
    """A word the gaze crossed mid-utterance belongs to the missed text."""

    def test_word_overlapping_start_boundary_is_preserved(self):
        # Away starts at 2500, inside "deadline" (2300-2900).
        raw = build_raw_text(select_missed_words(LECTURE, 2500, 4500))
        self.assertTrue(raw.startswith("deadline"), raw)
        self.assertNotIn("the", raw.split())

    def test_word_overlapping_end_boundary_is_preserved(self):
        # Away ends at 3800, inside "Friday." (3600-4200).
        raw = build_raw_text(select_missed_words(LECTURE, 1500, 3800))
        self.assertTrue(raw.endswith("Friday."), raw)

    def test_word_touching_boundary_exactly_is_excluded(self):
        # Strict inequalities: a word ending exactly at away_start was fully attended.
        selected = select_missed_words(LECTURE, 1400, 3400)
        self.assertNotIn("before,", build_raw_text(selected).split())
        # ...and a word starting exactly at away_end was not yet missed.
        self.assertNotIn("to", build_raw_text(selected).split())
        # while a word merely overlapping the end is kept.
        self.assertIn("changed", build_raw_text(selected).split())


class MultipleWindowsTest(unittest.TestCase):
    def test_multiple_away_windows_remain_separate(self):
        first = select_missed_words(LECTURE, 0, 2300)
        second = select_missed_words(LECTURE, 5000, 7000)

        first_text = build_raw_text(first)
        second_text = build_raw_text(second)

        self.assertEqual(first_text, "As I said before, the")
        self.assertEqual(second_text, "And next week we continue.")
        self.assertNotEqual(first, second)
        # No word appears in both windows.
        self.assertFalse({w["text"] for w in first} & {w["text"] for w in second})

    def test_short_glance_between_two_valid_windows_adds_nothing(self):
        glance = select_missed_words(LECTURE, 4200, 5100)  # 900 ms
        self.assertEqual(glance, [])


class SilenceAndEdgeCaseTest(unittest.TestCase):
    def test_silence_returns_empty(self):
        self.assertEqual(select_missed_words([], 0, 10_000), [])
        self.assertEqual(build_raw_text([]), "")

    def test_no_words_inside_a_valid_window_returns_empty(self):
        # Valid 3 s window that happens to land in a gap between utterances.
        self.assertEqual(select_missed_words(LECTURE, 7500, 10_500), [])

    def test_inverted_interval_raises(self):
        with self.assertRaises(InvalidAwayInterval):
            select_missed_words(LECTURE, 5000, 4000)

    def test_zero_length_interval_is_not_valid(self):
        self.assertEqual(select_missed_words(LECTURE, 3000, 3000), [])
        self.assertFalse(is_valid_away_window(3000, 3000))


class TranscriptionPadDoesNotLeakTest(unittest.TestCase):
    """We transcribe a padded clip for acoustic context; the pad must not persist.

    Simulates the real pipeline: Whisper sees [away_start - PAD, away_end + PAD]
    and therefore returns attended words too. Selection against the *unpadded*
    interval must produce exactly the same result as an unpadded clip would.
    """

    def test_padded_clip_selection_matches_unpadded_selection(self):
        away_start, away_end = 2000, 4500

        # Words Whisper returns when given a 750 ms pad on each side.
        padded_transcription = [w for w in LECTURE if w["end_ms"] > 1250 and w["start_ms"] < 5250]
        # Words it would return with no pad at all.
        unpadded_transcription = [
            w for w in LECTURE if w["end_ms"] > away_start and w["start_ms"] < away_end
        ]

        self.assertGreater(len(padded_transcription), len(unpadded_transcription))

        from_padded = build_raw_text(
            select_missed_words(padded_transcription, away_start, away_end)
        )
        from_unpadded = build_raw_text(
            select_missed_words(unpadded_transcription, away_start, away_end)
        )

        self.assertEqual(from_padded, from_unpadded)
        self.assertEqual(from_padded, "the deadline changed to Friday.")
        for token in ATTENDED_BEFORE | ATTENDED_AFTER:
            self.assertNotIn(token, from_padded.split())


class DedupeTest(unittest.TestCase):
    def test_overlapping_clips_do_not_duplicate_words(self):
        overlap = LECTURE[4:9] + LECTURE[6:11]
        deduped = dedupe_words(overlap)
        self.assertEqual(
            build_raw_text(deduped), "the deadline changed to Friday. And next"
        )

    def test_dedupe_sorts_by_timeline(self):
        shuffled = [LECTURE[8], LECTURE[4], LECTURE[6]]
        self.assertEqual(build_raw_text(dedupe_words(shuffled)), "the changed Friday.")


class FragmentTest(unittest.TestCase):
    def test_splits_on_sentence_punctuation(self):
        missed = words_from(
            [
                ("IMPORTANT", 0, 600),
                ("CHANGE.", 600, 1200),
                ("The", 1200, 1400),
                ("assignment", 1400, 2000),
                ("is", 2000, 2200),
                ("due", 2200, 2500),
                ("Friday.", 2500, 3100),
            ]
        )
        fragments = fragment_missed_text(missed)
        self.assertEqual(
            [f["text"] for f in fragments],
            ["IMPORTANT CHANGE.", "The assignment is due Friday."],
        )
        self.assertEqual(fragments[0]["start_ms"], 0)
        self.assertEqual(fragments[0]["end_ms"], 1200)
        self.assertEqual(fragments[1]["start_ms"], 1200)
        self.assertEqual(fragments[1]["end_ms"], 3100)

    def test_keeps_trailing_partial_sentence(self):
        fragments = fragment_missed_text(select_missed_words(LECTURE, 1500, 3500))
        self.assertEqual([f["text"] for f in fragments], ["the deadline changed to"])

    def test_keeps_leading_partial_sentence(self):
        missed = words_from([("before,", 900, 1400), ("the", 2000, 2300), ("deadline.", 2300, 2900)])
        self.assertEqual(
            [f["text"] for f in fragment_missed_text(missed)], ["before, the deadline."]
        )

    def test_drops_punctuation_only_fragments(self):
        self.assertEqual(fragment_missed_text(words_from([(".", 0, 100)])), [])
        self.assertEqual(fragment_missed_text([]), [])

    def test_question_mark_and_exclamation_split(self):
        missed = words_from(
            [("Ready?", 0, 500), ("Go!", 500, 900), ("Now", 900, 1200), ("begin.", 1200, 1700)]
        )
        self.assertEqual(
            [f["text"] for f in fragment_missed_text(missed)], ["Ready?", "Go!", "Now begin."]
        )

    def test_long_run_without_punctuation_is_chunked(self):
        missed = words_from([(f"w{i}", i * 100, i * 100 + 90) for i in range(10)])
        fragments = fragment_missed_text(missed, max_words_per_fragment=4)
        self.assertEqual(
            [f["text"] for f in fragments], ["w0 w1 w2 w3", "w4 w5 w6 w7", "w8 w9"]
        )


if __name__ == "__main__":
    unittest.main()
