"""Environment-driven settings. Every knob the demo might need to turn."""

from __future__ import annotations

import os


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# --- speech to text -------------------------------------------------------
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base.en")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
WHISPER_LANGUAGE = os.getenv("WHISPER_LANGUAGE", "en")
WHISPER_BEAM_SIZE = _int("WHISPER_BEAM_SIZE", 1)

# --- missed-window selection ---------------------------------------------
AWAY_THRESHOLD_MS = _int("AWAY_THRESHOLD_MS", 2000)

# Acoustic context given to Whisper on each side of the away window, so a word
# the gaze cut in half is still transcribed. Padded words fall outside the away
# interval and are removed by the exact word-overlap filter.
#
# Measured on synthetic/synthetic_lecture.wav (see tests/test_pad_safety.py):
# 0-500 ms all recover the missed sentence exactly. At 750 ms the clip reached
# 400 ms into the NEXT sentence and Whisper stretched its first word backwards
# over the silence, dragging an attended word inside the window and dropping all
# punctuation. So the pad must stay small enough not to swallow neighbouring
# speech. 250 ms also recovers boundary words that 0 ms loses.
CLIP_PAD_MS = _int("CLIP_PAD_MS", 250)

# Split a punctuation-free run of missed words after this many words so the
# classifier never receives one giant fragment.
MAX_WORDS_PER_FRAGMENT = _int("MAX_WORDS_PER_FRAGMENT", 40)

# --- chunked transcription while away ------------------------------------
# While the student is still away, completed slices are flushed so an absence
# longer than the browser's ring buffer is still captured in full.
CHUNK_MS = _int("CHUNK_MS", 20_000)
# Never hand Whisper a very short clip: accuracy collapses. Measured on the
# synthetic fixture, 2 s chunks turned "assignment" into "is is". A trailing
# remainder shorter than this is merged into the previous chunk instead.
MIN_CHUNK_MS = _int("MIN_CHUNK_MS", 8_000)

# Padding on an *interior* chunk boundary can be generous, because words there
# are assigned by start time and anything outside [a, b) is discarded whatever
# Whisper does with it. The two outer edges keep the small, validated
# CLIP_PAD_MS, since those use the interval-overlap rule where a smeared
# timestamp really could drag attended speech in.
CHUNK_PAD_MS = _int("CHUNK_PAD_MS", 2_000)

# --- classifier -----------------------------------------------------------
LAYA_ENABLED = _bool("LAYA_ENABLED", True)
LAYA_MODEL = os.getenv("LAYA_MODEL", "convaiinnovations/laya")
LAYA_SUBFOLDER = os.getenv("LAYA_SUBFOLDER", "typed-decisions")
# laya.load() does not read LAYA_DEVICE itself; we pass it explicitly.
# None -> auto (cuda > mps > xpu > cpu).
LAYA_DEVICE = os.getenv("LAYA_DEVICE") or None

# --- summarizer hand-off --------------------------------------------------
# Optional fire-and-forget POST of each new missed-window record.
SUMMARIZER_URL = os.getenv("SUMMARIZER_URL") or None

# --- privacy --------------------------------------------------------------
# Off by default: transcript text must not reach the logs during the demo.
DEBUG_TRANSCRIPT = _bool("DEBUG_TRANSCRIPT", False)
