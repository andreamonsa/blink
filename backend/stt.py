"""faster-whisper wrapper. The model is loaded once and reused."""

from __future__ import annotations

import logging
import threading
import time
from typing import List, Optional, Tuple

from backend import config

log = logging.getLogger(__name__)

_model = None
_lock = threading.Lock()
# Guards inference, not loading. FastAPI runs sync endpoints in a threadpool, so
# two away windows resolving together would otherwise call into one
# CTranslate2 model concurrently.
_infer_lock = threading.Lock()


def get_model():
    """Load WhisperModel once, on first use, and keep it."""
    global _model
    if _model is None:
        with _lock:
            if _model is None:
                from faster_whisper import WhisperModel

                t0 = time.time()
                log.info(
                    "loading whisper %s (%s/%s)",
                    config.WHISPER_MODEL,
                    config.WHISPER_DEVICE,
                    config.WHISPER_COMPUTE_TYPE,
                )
                _model = WhisperModel(
                    config.WHISPER_MODEL,
                    device=config.WHISPER_DEVICE,
                    compute_type=config.WHISPER_COMPUTE_TYPE,
                )
                log.info("whisper loaded in %.1fs", time.time() - t0)
    return _model


def transcribe_clip(
    audio_path: str,
    clip_start_ms: int = 0,
    vad_filter: bool = True,
) -> Tuple[List[dict], List[dict], str, float]:
    """Transcribe one clip and place its words on the session timeline.

    Whisper reports times relative to the clip, so every timestamp is shifted
    by ``clip_start_ms``. Returns (segments, words, text, processing_time_s).
    """
    model = get_model()
    t0 = time.time()

    with _infer_lock:
        segments_gen, _info = model.transcribe(
            audio_path,
            language=config.WHISPER_LANGUAGE,
            beam_size=config.WHISPER_BEAM_SIZE,
            temperature=0.0,
            condition_on_previous_text=False,
            word_timestamps=True,
            vad_filter=vad_filter,
        )
        # The generator is lazy: forcing the list inside the lock is what
        # actually runs the model.
        segments = list(segments_gen)

    out_segments: List[dict] = []
    out_words: List[dict] = []

    for segment in segments:
        seg_words = []
        for word in segment.words or []:
            text = word.word.strip()
            if not text:
                continue
            entry = {
                "start_ms": clip_start_ms + round(word.start * 1000),
                "end_ms": clip_start_ms + round(word.end * 1000),
                "text": text,
                "probability": getattr(word, "probability", None),
            }
            seg_words.append(entry)
            out_words.append(entry)

        seg_text = segment.text.strip()
        if not seg_text and not seg_words:
            continue

        out_segments.append(
            {
                "start_ms": clip_start_ms + round(segment.start * 1000),
                "end_ms": clip_start_ms + round(segment.end * 1000),
                "text": seg_text,
                "words": seg_words,
            }
        )

    full_text = " ".join(s["text"] for s in out_segments if s["text"]).strip()
    elapsed = time.time() - t0

    if config.DEBUG_TRANSCRIPT:
        log.debug("transcribed %d words in %.2fs: %s", len(out_words), elapsed, full_text)
    else:
        log.info("transcribed %d words in %.2fs", len(out_words), elapsed)

    return out_segments, out_words, full_text, elapsed


def warmup() -> Optional[float]:
    """Force the model to load and run once, so the first real clip is fast."""
    import os
    import tempfile
    import wave

    model = get_model()
    t0 = time.time()
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        with wave.open(path, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b"\x00\x00" * 16000)  # 1 s of silence
        with _infer_lock:
            list(model.transcribe(path, language=config.WHISPER_LANGUAGE, beam_size=1)[0])
    finally:
        os.unlink(path)
    return time.time() - t0
