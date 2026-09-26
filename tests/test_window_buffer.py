"""Chunked transcription must give exactly the single-shot result.

If chunking ever drops or duplicates a word, the student silently loses part of
what they missed -- so the central test compares the union of the chunks against
`select_missed_words` over the whole window, word for word.
"""

from __future__ import annotations

import unittest

from backend.missed_selector import build_raw_text, select_missed_words
from backend.window_buffer import WindowBuffer, assign_chunk_words


def words_every(step_ms: int, count: int, start_ms: int = 0):
    """A steady stream of words, each `step_ms` long, back to back."""
    return [
        {
            "start_ms": start_ms + i * step_ms,
            "end_ms": start_ms + (i + 1) * step_ms,
            "text": f"w{i}",
        }
        for i in range(count)
    ]


def tile(words, away_start, away_end, chunk_ms):
    """Run the real chunking and return the union, as the backend would."""
    bounds = []
    edge = away_start
    while edge < away_end:
        bounds.append((edge, min(edge + chunk_ms, away_end)))
        edge += chunk_ms

    out = []
    for index, (a, b) in enumerate(bounds):
        out.extend(
            assign_chunk_words(
                words, a, b,
                is_first=(index == 0),
                is_last=(index == len(bounds) - 1),
            )
        )
    return out, len(bounds)


class TilingEqualsSingleShotTest(unittest.TestCase):
    """The whole point: chunking changes latency, never content."""

    def assert_same_as_single_shot(self, words, away_start, away_end, chunk_ms):
        chunked, n_chunks = tile(words, away_start, away_end, chunk_ms)
        single = select_missed_words(words, away_start, away_end)

        self.assertGreater(n_chunks, 1, "test should actually exercise chunking")
        self.assertEqual(
            build_raw_text(chunked), build_raw_text(single),
            f"chunked into {n_chunks} differs from single shot",
        )
        self.assertEqual(len(chunked), len(single))

    def test_steady_speech_over_three_minutes(self):
        # 180 s of speech at 400 ms per word, away for the middle 150 s.
        words = words_every(400, 450)
        self.assert_same_as_single_shot(words, 15_000, 165_000, chunk_ms=20_000)

    def test_chunk_boundary_falling_mid_word(self):
        # Words of 700 ms against 2000 ms chunks: boundaries land mid-word.
        words = words_every(700, 60)
        self.assert_same_as_single_shot(words, 1_000, 41_000, chunk_ms=2_000)

    def test_away_window_not_a_multiple_of_the_chunk(self):
        words = words_every(300, 200)
        self.assert_same_as_single_shot(words, 2_500, 47_300, chunk_ms=20_000)

    def test_words_straddling_both_outer_edges(self):
        words = [
            {"start_ms": 900, "end_ms": 2100, "text": "straddles-start"},
            {"start_ms": 2100, "end_ms": 2600, "text": "inside-a"},
            {"start_ms": 5900, "end_ms": 6400, "text": "inside-b"},
            {"start_ms": 9800, "end_ms": 11000, "text": "straddles-end"},
            {"start_ms": 11000, "end_ms": 11500, "text": "after"},
        ]
        self.assert_same_as_single_shot(words, 2_000, 10_000, chunk_ms=3_000)

        chunked, _ = tile(words, 2_000, 10_000, 3_000)
        texts = [w["text"] for w in chunked]
        self.assertIn("straddles-start", texts, "a word cut by the gaze must survive")
        self.assertIn("straddles-end", texts)
        self.assertNotIn("after", texts)


class NoDuplicatesTest(unittest.TestCase):
    def test_no_word_is_assigned_to_two_chunks(self):
        words = words_every(700, 60)
        chunked, n = tile(words, 1_000, 41_000, chunk_ms=2_000)
        keys = [(w["start_ms"], w["end_ms"], w["text"]) for w in chunked]
        self.assertEqual(len(keys), len(set(keys)), "a word landed in two chunks")

    def test_a_word_starting_exactly_on_a_boundary_lands_once(self):
        words = [{"start_ms": 4000, "end_ms": 4500, "text": "on-boundary"}]
        chunked, _ = tile(words, 2_000, 8_000, chunk_ms=2_000)
        self.assertEqual([w["text"] for w in chunked], ["on-boundary"])

    def test_every_word_inside_the_window_is_assigned_somewhere(self):
        words = words_every(333, 150)
        chunked, _ = tile(words, 0, 49_950, chunk_ms=7_000)
        single = select_missed_words(words, 0, 49_950)
        self.assertEqual(
            {w["text"] for w in chunked}, {w["text"] for w in single},
            "chunking dropped a word",
        )


class SingleChunkTest(unittest.TestCase):
    """A short absence is just the one-chunk case of the same code path."""

    def test_one_chunk_equals_the_overlap_rule(self):
        words = words_every(400, 30)
        selected = assign_chunk_words(words, 2_000, 6_000, is_first=True, is_last=True)
        self.assertEqual(
            build_raw_text(selected),
            build_raw_text(select_missed_words(words, 2_000, 6_000)),
        )


class BufferTest(unittest.TestCase):
    def setUp(self):
        self.buf = WindowBuffer()

    def test_chunks_accumulate_in_timeline_order(self):
        self.buf.add_chunk("s", "w1", words_every(100, 3, start_ms=2000), 1)
        self.buf.add_chunk("s", "w1", words_every(100, 3, start_ms=0), 0)
        got = self.buf.get_words("s", "w1")
        self.assertEqual([w["start_ms"] for w in got], [0, 100, 200, 2000, 2100, 2200])

    def test_a_retried_chunk_does_not_double_insert(self):
        chunk = words_every(100, 3)
        self.buf.add_chunk("s", "w1", chunk, 0)
        self.buf.add_chunk("s", "w1", chunk, 0)
        self.assertEqual(len(self.buf.get_words("s", "w1")), 3)
        self.assertEqual(self.buf.chunk_count("s", "w1"), 1)

    def test_windows_and_sessions_are_isolated(self):
        self.buf.add_chunk("s1", "w1", words_every(100, 2), 0)
        self.buf.add_chunk("s1", "w2", words_every(100, 3), 0)
        self.buf.add_chunk("s2", "w1", words_every(100, 4), 0)
        self.assertEqual(len(self.buf.get_words("s1", "w1")), 2)
        self.assertEqual(len(self.buf.get_words("s1", "w2")), 3)
        self.assertEqual(len(self.buf.get_words("s2", "w1")), 4)

    def test_pop_returns_and_forgets(self):
        self.buf.add_chunk("s", "w1", words_every(100, 3), 0)
        self.assertEqual(len(self.buf.pop("s", "w1")), 3)
        self.assertEqual(self.buf.get_words("s", "w1"), [])
        self.assertEqual(len(self.buf), 0)

    def test_sweep_drops_abandoned_windows(self):
        self.buf.add_chunk("s", "w1", words_every(100, 3), 0)
        self.assertEqual(self.buf.sweep(ttl_s=10_000), 0)
        self.assertEqual(self.buf.sweep(ttl_s=-1), 1, "a stale window must be dropped")
        self.assertEqual(len(self.buf), 0)

    def test_reset_by_session(self):
        self.buf.add_chunk("s1", "w1", words_every(100, 2), 0)
        self.buf.add_chunk("s2", "w1", words_every(100, 2), 0)
        self.buf.reset("s1")
        self.assertEqual(self.buf.get_words("s1", "w1"), [])
        self.assertEqual(len(self.buf.get_words("s2", "w1")), 2)


if __name__ == "__main__":
    unittest.main()


class ServerRefusesToCountARangeTwiceTest(unittest.TestCase):
    """Defence in depth against a client that sends overlapping chunk bounds."""

    def setUp(self):
        self.buf = WindowBuffer()

    def test_disjoint_chunks_are_not_clipped(self):
        self.assertEqual(self.buf.claim_range("s", "w", 0, 20_000), 0)
        self.assertEqual(self.buf.claim_range("s", "w", 20_000, 40_000), 20_000)

    def test_an_overlapping_chunk_is_clipped_to_the_covered_edge(self):
        self.buf.claim_range("s", "w", 0, 20_000)
        self.buf.claim_range("s", "w", 20_000, 40_000)
        # The old client bug: tail moved back to 35 s to avoid a sliver.
        self.assertEqual(self.buf.claim_range("s", "w", 35_000, 43_000), 40_000)

    def test_overlap_would_have_duplicated_words_without_the_guard(self):
        words = words_every(500, 90)          # 45 s of speech
        stored = []
        for start, end, first, last in [
            (0, 20_000, True, False),
            (20_000, 40_000, False, False),
            (35_000, 43_000, False, True),    # overlaps the previous chunk
        ]:
            eff = self.buf.claim_range("s", "w", start, end)
            stored.extend(assign_chunk_words(
                words, eff, end, is_first=first and eff == start, is_last=last))

        keys = [(w["start_ms"], w["text"]) for w in stored]
        self.assertEqual(len(keys), len(set(keys)), "a word was stored twice")
        self.assertEqual(
            build_raw_text(stored),
            build_raw_text(select_missed_words(words, 0, 43_000)),
            "clipping must not drop anything either",
        )

    def test_windows_track_coverage_independently(self):
        self.buf.claim_range("s", "w1", 0, 20_000)
        self.assertEqual(self.buf.claim_range("s", "w2", 5_000, 25_000), 5_000)
