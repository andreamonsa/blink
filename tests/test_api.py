"""HTTP-level tests: the endpoints the browser and the summarizer actually call."""

from __future__ import annotations

import json
import os
import unittest

from fastapi.testclient import TestClient

from backend import config
from backend.app import app
from backend.session_store import store
from backend.window_buffer import plan_chunks, window_buffer
from tools.wav_util import slice_wav, write_silence

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "synthetic", "manifest.json")


@unittest.skipUnless(os.path.exists(MANIFEST), "run tools/generate_synthetic_audio.py")
class RecoverEndpointTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(MANIFEST) as fh:
            cls.manifest = json.load(fh)
        cls.audio = os.path.join(ROOT, cls.manifest["audio"])
        cls.client = TestClient(app)

    def setUp(self):
        store.reset()

    def post_window(self, away_start, away_end, session_id="t1", pad=None):
        """Send exactly what the browser sends: a padded clip plus the window."""
        pad = config.CLIP_PAD_MS if pad is None else pad
        clip_start = max(0, away_start - pad)
        path = slice_wav(self.audio, clip_start, away_end + pad)
        try:
            with open(path, "rb") as fh:
                response = self.client.post(
                    "/recover",
                    files={"audio": ("clip.wav", fh, "audio/wav")},
                    data={
                        "away_start_ms": away_start,
                        "away_end_ms": away_end,
                        "clip_start_ms": clip_start,
                        "session_id": session_id,
                    },
                )
        finally:
            os.unlink(path)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_health_reports_configuration(self):
        health = self.client.get("/health").json()
        self.assertTrue(health["ok"])
        self.assertEqual(health["away_threshold_ms"], 2000)
        self.assertIn("whisper", health)
        self.assertIn("laya", health)

    def test_recover_returns_only_the_missed_sentence(self):
        away = self.manifest["away_window"]
        record = self.post_window(away["start_ms"], away["end_ms"])

        low = record["raw_text"].lower()
        for token in self.manifest["expect_contains"]:
            self.assertIn(token.lower(), low)
        for token in self.manifest["expect_absent"]:
            self.assertNotIn(token.lower(), low)
        self.assertTrue(record["items"])
        self.assertTrue(record["words"])

    def test_recover_returns_word_timestamps_on_the_session_timeline(self):
        away = self.manifest["away_window"]
        record = self.post_window(away["start_ms"], away["end_ms"])
        for word in record["words"]:
            self.assertGreater(word["end_ms"], away["start_ms"])
            self.assertLess(word["start_ms"], away["end_ms"])
            self.assertLessEqual(word["start_ms"], word["end_ms"])

    def test_short_window_stores_nothing(self):
        away = self.manifest["away_window"]
        record = self.post_window(away["start_ms"], away["start_ms"] + 1999)
        self.assertEqual(record["raw_text"], "")
        self.assertEqual(record["items"], [])
        session = self.client.get("/session/t1/missed").json()
        self.assertEqual(session["windows"], [])

    def test_inverted_window_is_rejected(self):
        away = self.manifest["away_window"]
        path = slice_wav(self.audio, 0, 1000)
        try:
            with open(path, "rb") as fh:
                response = self.client.post(
                    "/recover",
                    files={"audio": ("clip.wav", fh, "audio/wav")},
                    data={"away_start_ms": away["end_ms"],
                          "away_end_ms": away["start_ms"],
                          "clip_start_ms": 0, "session_id": "t1"},
                )
        finally:
            os.unlink(path)
        self.assertEqual(response.status_code, 400)

    def test_silence_does_not_crash_or_store(self):
        path = write_silence(3.0)
        try:
            with open(path, "rb") as fh:
                response = self.client.post(
                    "/recover",
                    files={"audio": ("clip.wav", fh, "audio/wav")},
                    data={"away_start_ms": 0, "away_end_ms": 3000,
                          "clip_start_ms": 0, "session_id": "t1"},
                )
        finally:
            os.unlink(path)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["raw_text"], "")

    def test_transcribe_endpoint_returns_words(self):
        path = slice_wav(self.audio, 0, 4000)
        try:
            with open(path, "rb") as fh:
                response = self.client.post(
                    "/transcribe",
                    files={"audio": ("clip.wav", fh, "audio/wav")},
                    data={"clip_start_ms": 0},
                )
        finally:
            os.unlink(path)
        body = response.json()
        self.assertTrue(body["words"])
        self.assertTrue(body["segments"])
        self.assertIn("pricing", body["text"].lower())
        self.assertTrue(all("start_ms" in w and "end_ms" in w for w in body["words"]))


@unittest.skipUnless(os.path.exists(MANIFEST), "run tools/generate_synthetic_audio.py")
class SessionEndpointTest(RecoverEndpointTest):
    def test_session_accumulates_for_the_summarizer(self):
        away = self.manifest["away_window"]
        s2 = self.manifest["sentences"][2]  # the third, attended sentence

        self.post_window(away["start_ms"], away["end_ms"], "sum1")
        self.post_window(s2["start_ms"] - 200, s2["end_ms"] + 200, "sum1")

        session = self.client.get("/session/sum1/missed").json()
        self.assertEqual(len(session["windows"]), 2)
        self.assertEqual(session["session_id"], "sum1")
        # Ordered by start_ms, flat sentence list for the summarizer.
        starts = [w["start_ms"] for w in session["windows"]]
        self.assertEqual(starts, sorted(starts))
        self.assertTrue(session["sentences"])
        self.assertEqual(
            [s["start_ms"] for s in session["sentences"]],
            sorted(s["start_ms"] for s in session["sentences"]),
        )
        for sentence in session["sentences"]:
            self.assertIn("kind", sentence)
            self.assertIn("priority", sentence)

    def test_second_window_is_deliberately_missed_content_not_a_leak(self):
        """Looking away during sentence 3 makes sentence 3 missed content."""
        s2 = self.manifest["sentences"][2]
        self.post_window(s2["start_ms"] - 200, s2["end_ms"] + 200, "sum2")
        session = self.client.get("/session/sum2/missed").json()
        self.assertIn("slide", session["raw_text"].lower())
        # ...and the first sentence, which WAS attended, never appears.
        self.assertNotIn("pricing", session["raw_text"].lower())

    def test_sessions_are_isolated(self):
        away = self.manifest["away_window"]
        self.post_window(away["start_ms"], away["end_ms"], "iso1")
        self.assertTrue(self.client.get("/session/iso1/missed").json()["windows"])
        self.assertEqual(self.client.get("/session/iso2/missed").json()["windows"], [])

    def test_reset_clears_a_session(self):
        away = self.manifest["away_window"]
        self.post_window(away["start_ms"], away["end_ms"], "res1")
        self.client.post("/session/res1/reset")
        self.assertEqual(self.client.get("/session/res1/missed").json()["windows"], [])


if __name__ == "__main__":
    unittest.main()


LONG_MANIFEST = os.path.join(ROOT, "synthetic", "long_manifest.json")


@unittest.skipUnless(os.path.exists(LONG_MANIFEST), "run tools/generate_synthetic_audio.py")
class ChunkedWindowEndpointTest(unittest.TestCase):
    """A 37 s absence, flushed in chunks while the student is still away.

    Driven by the same `plan_chunks` the browser uses, against real Whisper, at
    the real chunk size -- small chunks are a separate, deliberately tested
    failure mode (see MIN_CHUNK_MS).
    """

    @classmethod
    def setUpClass(cls):
        with open(LONG_MANIFEST) as fh:
            cls.manifest = json.load(fh)
        cls.audio = os.path.join(ROOT, cls.manifest["audio"])
        cls.client = TestClient(app)

    def setUp(self):
        store.reset()
        window_buffer.reset()

    def post_chunks(self, away_start, away_end, session_id, window_id, **plan_kw):
        """Drive the chunked path exactly as the browser will."""
        plan = plan_chunks(away_start, away_end, **plan_kw)
        self.assertGreater(len(plan), 1, "this test must actually chunk")

        for chunk in plan:
            path = slice_wav(self.audio, max(0, chunk["clip_start_ms"]), chunk["clip_end_ms"])
            try:
                with open(path, "rb") as fh:
                    response = self.client.post(
                        f"/window/{window_id}/chunk",
                        files={"audio": ("chunk.wav", fh, "audio/wav")},
                        data={
                            "session_id": session_id,
                            "chunk_index": chunk["chunk_index"],
                            "chunk_start_ms": int(chunk["chunk_start_ms"]),
                            "chunk_end_ms": int(chunk["chunk_end_ms"]),
                            "clip_start_ms": int(max(0, chunk["clip_start_ms"])),
                            "is_first": chunk["is_first"],
                            "is_last": chunk["is_last"],
                        },
                    )
            finally:
                os.unlink(path)
            self.assertEqual(response.status_code, 200, response.text)

        final = self.client.post(
            f"/window/{window_id}/finalize",
            data={"session_id": session_id,
                  "away_start_ms": away_start, "away_end_ms": away_end},
        )
        self.assertEqual(final.status_code, 200, final.text)
        return final.json()

    def test_a_long_absence_is_recovered_in_full(self):
        away = self.manifest["away_window"]
        record = self.post_chunks(away["start_ms"], away["end_ms"], "long", "w1")
        low = record["raw_text"].lower()

        # Every missed sentence must be represented, across both chunks.
        for token in ["assignment", "friday", "monday", "website",
                      "elasticity", "chapter", "midterm"]:
            self.assertIn(token, low, f"{token!r} lost from a 37 s absence")

    def test_no_attended_sentence_leaks_across_chunk_boundaries(self):
        away = self.manifest["away_window"]
        record = self.post_chunks(away["start_ms"], away["end_ms"], "leak", "w1")
        low = record["raw_text"].lower()
        for token in self.manifest["expect_absent"]:
            self.assertNotIn(token, low, f"attended word {token!r} leaked")

    def test_no_word_is_duplicated_or_out_of_order(self):
        away = self.manifest["away_window"]
        record = self.post_chunks(away["start_ms"], away["end_ms"], "dup", "w1")

        keys = [(w["start_ms"], w["end_ms"], w["text"]) for w in record["words"]]
        self.assertEqual(len(keys), len(set(keys)), "a word was counted twice")
        starts = [w["start_ms"] for w in record["words"]]
        self.assertEqual(starts, sorted(starts), "words must stay in timeline order")

        # No four-word run may repeat -- the signature of a chunk seam duplicating text.
        tokens = record["raw_text"].lower().split()
        grams = [" ".join(tokens[i:i + 4]) for i in range(len(tokens) - 3)]
        self.assertEqual(len(grams), len(set(grams)), "duplicate run at a chunk seam")

    def test_chunk_seam_does_not_swallow_a_word(self):
        """The seam falls mid-sentence; that sentence must survive intact."""
        away = self.manifest["away_window"]
        record = self.post_chunks(away["start_ms"], away["end_ms"], "seam", "w1")
        plan = plan_chunks(away["start_ms"], away["end_ms"])
        seam = plan[0]["chunk_end_ms"]

        before = [w for w in record["words"] if w["start_ms"] < seam]
        after = [w for w in record["words"] if w["start_ms"] >= seam]
        self.assertTrue(before and after, "the seam should split the word stream")
        # No silent gap at the seam: the last word before and first word after
        # must be adjacent in time, not separated by a swallowed word.
        gap = after[0]["start_ms"] - before[-1]["end_ms"]
        self.assertLess(gap, 1500, f"{gap} ms hole at the chunk seam suggests a lost word")

    def test_chunks_are_classified_and_stored_for_the_summarizer(self):
        away = self.manifest["away_window"]
        self.post_chunks(away["start_ms"], away["end_ms"], "sum", "w1")
        session = self.client.get("/session/sum/missed").json()
        self.assertEqual(len(session["windows"]), 1)
        self.assertTrue(session["sentences"], "no fragments reached the summarizer feed")
        for token in self.manifest["expect_absent"]:
            self.assertNotIn(token, session["raw_text"].lower())

    def test_a_retried_chunk_is_ignored(self):
        """A network retry resends the same chunk_index; it must not double the words."""
        away = self.manifest["away_window"]
        chunk = plan_chunks(away["start_ms"], away["end_ms"])[0]
        path = slice_wav(self.audio, max(0, chunk["clip_start_ms"]), chunk["clip_end_ms"])
        bodies = []
        try:
            for _ in range(2):
                with open(path, "rb") as fh:
                    bodies.append(self.client.post(
                        "/window/retry/chunk",
                        files={"audio": ("chunk.wav", fh, "audio/wav")},
                        data={"session_id": "r", "chunk_index": 0,
                              "chunk_start_ms": int(chunk["chunk_start_ms"]),
                              "chunk_end_ms": int(chunk["chunk_end_ms"]),
                              "clip_start_ms": int(max(0, chunk["clip_start_ms"])),
                              "is_first": True, "is_last": False},
                    ).json())
        finally:
            os.unlink(path)

        first, retry = bodies
        self.assertGreater(first["words_in_chunk"], 0)
        self.assertTrue(retry.get("duplicate"), "the retry must be recognised")
        self.assertEqual(retry["words_in_chunk"], 0)
        self.assertEqual(retry["words_total"], first["words_total"],
                         "a retry must not add words")
        self.assertEqual(
            len(window_buffer.get_words("r", "retry")), first["words_total"]
        )

    def test_finalize_without_chunks_returns_empty_not_an_error(self):
        response = self.client.post(
            "/window/never-chunked/finalize",
            data={"session_id": "e", "away_start_ms": 0, "away_end_ms": 5000},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["raw_text"], "")

    def test_finalize_rejects_an_inverted_window(self):
        response = self.client.post(
            "/window/bad/finalize",
            data={"session_id": "e", "away_start_ms": 9000, "away_end_ms": 1000},
        )
        self.assertEqual(response.status_code, 400)
