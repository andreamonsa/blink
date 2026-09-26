"""Two away windows resolving together must not corrupt or block each other.

A real gaze tracker fires whenever it fires. Once the endpoints moved off the
event loop into FastAPI's threadpool, concurrent Whisper calls became possible,
so the model needs an inference lock -- these tests pin both halves down.
"""

from __future__ import annotations

import inspect
import json
import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor

from backend import app as app_module
from backend import classifier, stt
from tools.wav_util import slice_wav

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "synthetic", "manifest.json")


class EndpointsAreNotOnTheEventLoopTest(unittest.TestCase):
    """Blocking CPU work in an `async def` freezes the entire server."""

    def test_recover_is_a_sync_endpoint(self):
        self.assertFalse(
            inspect.iscoroutinefunction(app_module.recover),
            "recover() must be `def` so FastAPI runs it in a threadpool",
        )

    def test_transcribe_is_a_sync_endpoint(self):
        self.assertFalse(
            inspect.iscoroutinefunction(app_module.transcribe),
            "transcribe() must be `def` so FastAPI runs it in a threadpool",
        )

    def test_summarizer_notification_is_a_background_task(self):
        source = inspect.getsource(app_module.recover)
        self.assertIn("background.add_task", source)
        self.assertNotIn(
            "_notify_summarizer(session_id, record)\n", source,
            "the summarizer POST must not run inline in the request",
        )


class InferenceLocksExistTest(unittest.TestCase):
    def test_whisper_has_a_separate_inference_lock(self):
        self.assertIsNot(stt._infer_lock, stt._lock,
                         "the load lock must not double as the inference lock")
        self.assertIn("with _infer_lock", inspect.getsource(stt.transcribe_clip))

    def test_laya_has_a_separate_inference_lock(self):
        self.assertIsNot(classifier._infer_lock, classifier._lock)
        self.assertIn(
            "with _infer_lock",
            inspect.getsource(classifier.classify_missed_fragments),
        )


@unittest.skipUnless(os.path.exists(MANIFEST), "run tools/generate_synthetic_audio.py")
class ConcurrentTranscriptionTest(unittest.TestCase):
    """Four simultaneous recoveries must all return the same correct text."""

    @classmethod
    def setUpClass(cls):
        with open(MANIFEST) as fh:
            cls.manifest = json.load(fh)
        cls.audio = os.path.join(ROOT, cls.manifest["audio"])
        stt.get_model()  # load once up front so we time inference, not loading

    def test_four_concurrent_clips_do_not_interfere(self):
        away = self.manifest["away_window"]
        clips = [
            slice_wav(self.audio, away["start_ms"] - 250, away["end_ms"] + 250)
            for _ in range(4)
        ]
        try:
            def run(path):
                _s, words, text, _e = stt.transcribe_clip(
                    path, clip_start_ms=away["start_ms"] - 250
                )
                return text, len(words)

            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(run, clips))
        finally:
            for path in clips:
                os.unlink(path)

        texts = {text for text, _n in results}
        self.assertEqual(
            len(texts), 1,
            f"concurrent transcriptions disagreed, which means shared state: {texts}",
        )
        self.assertIn("friday", texts.pop().lower())

    def test_inference_lock_actually_serializes(self):
        """If two threads were ever inside the model at once, this would trip."""
        away = self.manifest["away_window"]
        inside = 0
        overlaps = []
        guard = threading.Lock()
        real = stt._infer_lock

        class CountingLock:
            def __enter__(self):
                real.acquire()
                nonlocal inside
                with guard:
                    inside += 1
                    if inside > 1:
                        overlaps.append(inside)
                return self

            def __exit__(self, *exc):
                nonlocal inside
                with guard:
                    inside -= 1
                real.release()
                return False

        clips = [
            slice_wav(self.audio, away["start_ms"], away["end_ms"]) for _ in range(3)
        ]
        stt._infer_lock = CountingLock()
        try:
            with ThreadPoolExecutor(max_workers=3) as pool:
                list(pool.map(lambda p: stt.transcribe_clip(p, 0), clips))
        finally:
            stt._infer_lock = real
            for path in clips:
                os.unlink(path)

        self.assertEqual(overlaps, [], "two threads were inside the model at once")


if __name__ == "__main__":
    unittest.main()
