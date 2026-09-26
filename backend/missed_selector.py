"""Exact selection of the words a student missed while looking away.

This module is the correctness core of Silent Specs and has no third-party
dependencies on purpose: it must stay testable and trustworthy even when
Whisper or Laya are unavailable.

The product invariant it enforces:

    For a valid away interval [away_start_ms, away_end_ms], a Whisper word is
    kept only when  word.end_ms > away_start_ms  AND  word.start_ms < away_end_ms.

That is an interval-overlap test. It preserves a word the gaze crossed in the
middle of, and excludes whole sentences spoken before or after the interval.
"""

from __future__ import annotations

import re
from typing import Iterable, List, Optional, Sequence, TypedDict

#: An away interval shorter than this is not a missed event at all.
#: It is a *trigger* threshold only -- the first two seconds are still part of
#: what the user missed, so the interval is never shortened to away_start+2000.
DEFAULT_THRESHOLD_MS = 2000

#: Sentence-final punctuation we are willing to split missed text on.
_SENTENCE_END = (".", "?", "!")

_HAS_ALNUM = re.compile(r"[^\W_]", re.UNICODE)


class TranscriptWord(TypedDict, total=False):
    """One word on the shared session timeline (absolute milliseconds)."""

    start_ms: int
    end_ms: int
    text: str
    probability: float


class Fragment(TypedDict):
    """A readable sentence/fragment rebuilt from missed words only."""

    start_ms: int
    end_ms: int
    text: str


class InvalidAwayInterval(ValueError):
    """Raised when an away interval ends before it starts."""


def select_missed_words(
    words: Sequence[TranscriptWord],
    away_start_ms: float,
    away_end_ms: float,
    threshold_ms: float = DEFAULT_THRESHOLD_MS,
) -> List[TranscriptWord]:
    """Return only the words overlapping a *valid* away interval.

    Returns an empty list when the interval is shorter than ``threshold_ms``;
    nothing at all should be persisted for such a glance.
    """
    if away_end_ms < away_start_ms:
        raise InvalidAwayInterval(
            f"away_end_ms ({away_end_ms}) precedes away_start_ms ({away_start_ms})"
        )

    if away_end_ms - away_start_ms < threshold_ms:
        return []

    return [
        word
        for word in words
        if word["end_ms"] > away_start_ms and word["start_ms"] < away_end_ms
    ]


def is_valid_away_window(
    away_start_ms: float,
    away_end_ms: float,
    threshold_ms: float = DEFAULT_THRESHOLD_MS,
) -> bool:
    """True when the interval is long enough to count as missed content."""
    return away_end_ms >= away_start_ms and away_end_ms - away_start_ms >= threshold_ms


def build_raw_text(words: Iterable[TranscriptWord]) -> str:
    """Rebuild the exact missed text. This is what must never be lost."""
    return " ".join(w["text"].strip() for w in words if w["text"].strip())


def dedupe_words(words: Iterable[TranscriptWord]) -> List[TranscriptWord]:
    """Drop words repeated by overlapping clips, keeping timeline order.

    Two words are the same when they share a start time, an end time and their
    text -- which is what happens when two transcription clips overlap.
    """
    seen = set()
    out: List[TranscriptWord] = []
    for word in sorted(words, key=lambda w: (w["start_ms"], w["end_ms"])):
        key = (word["start_ms"], word["end_ms"], word["text"].strip())
        if key in seen:
            continue
        seen.add(key)
        out.append(word)
    return out


def _is_meaningful(text: str) -> bool:
    """A fragment worth classifying contains at least one letter or digit."""
    return bool(_HAS_ALNUM.search(text))


def fragment_missed_text(
    words: Sequence[TranscriptWord],
    max_words_per_fragment: Optional[int] = None,
) -> List[Fragment]:
    """Group missed words into a few readable fragments for the classifier.

    Splits conservatively, only after sentence-final punctuation. Leading and
    trailing partial sentences are kept whenever they carry a real word, since
    a gaze boundary usually falls mid-sentence. No word from outside the away
    window is ever pulled in to make a fragment grammatical.
    """
    fragments: List[Fragment] = []
    current: List[TranscriptWord] = []

    def flush() -> None:
        if not current:
            return
        text = build_raw_text(current)
        if _is_meaningful(text):
            fragments.append(
                {
                    "start_ms": current[0]["start_ms"],
                    "end_ms": current[-1]["end_ms"],
                    "text": text,
                }
            )
        current.clear()

    for word in words:
        stripped = word["text"].strip()
        if not stripped:
            continue
        current.append(word)
        ends_sentence = stripped.endswith(_SENTENCE_END)
        too_long = (
            max_words_per_fragment is not None
            and len(current) >= max_words_per_fragment
        )
        if ends_sentence or too_long:
            flush()

    flush()
    return fragments
