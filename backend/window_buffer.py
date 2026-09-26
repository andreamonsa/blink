"""Accumulates transcribed words across chunks of one long away window.

Transcribing only on return means the whole absence has to fit in the browser's
ring buffer, which caps how long a student may look away. Instead, once an
absence is confirmed the browser flushes completed slices as they accumulate
and we stitch them here.

The tiling rule is what makes this exact rather than approximate:

    chunk 0      keep  end_ms > away_start   and start_ms < c1
    chunk i      keep  start_ms >= c_i       and start_ms < c_(i+1)
    last chunk   keep  start_ms >= c_n       and start_ms < away_end

Interior boundaries assign a word by its **start** alone, so a word straddling
one lands in exactly one chunk -- no duplicates, no dedup guesswork. The outer
edges keep the interval-overlap rule, so a word the gaze cut in half is still
preserved. The union is therefore identical to what a single clip covering the
whole window would have selected, which `tests/test_window_buffer.py` asserts
directly against `select_missed_words`.
"""

from __future__ import annotations

import threading
import time
from typing import Dict, List, Optional, Sequence, Tuple

#: Abandoned windows (tab closed mid-absence) are dropped after this long.
WINDOW_TTL_S = 30 * 60


def plan_chunks(
    away_start_ms: float,
    away_end_ms: float,
    chunk_ms: Optional[int] = None,
    min_chunk_ms: Optional[int] = None,
    outer_pad_ms: Optional[int] = None,
    inner_pad_ms: Optional[int] = None,
) -> List[dict]:
    """Tile an away window into chunks, with the audio clip for each.

    Two rules that matter:

    * A trailing remainder shorter than ``min_chunk_ms`` is merged into the
      previous chunk. Whisper degrades badly on very short clips -- measured on
      the synthetic fixture, a 2 s clip turned "assignment" into "is is".
    * Interior edges get a generous pad for acoustic context, because words
      there are assigned by start time and anything outside the chunk is
      discarded regardless. The outer edges keep the small validated pad, since
      those use the overlap rule where a smeared timestamp could pull attended
      speech in.
    """
    from backend import config

    chunk_ms = config.CHUNK_MS if chunk_ms is None else chunk_ms
    min_chunk_ms = config.MIN_CHUNK_MS if min_chunk_ms is None else min_chunk_ms
    outer_pad_ms = config.CLIP_PAD_MS if outer_pad_ms is None else outer_pad_ms
    inner_pad_ms = config.CHUNK_PAD_MS if inner_pad_ms is None else inner_pad_ms

    if away_end_ms <= away_start_ms:
        return []

    bounds: List[List[float]] = []
    edge = away_start_ms
    while edge < away_end_ms:
        bounds.append([edge, min(edge + chunk_ms, away_end_ms)])
        edge += chunk_ms

    # Absorb a too-short tail rather than sending Whisper a sliver.
    if len(bounds) > 1 and bounds[-1][1] - bounds[-1][0] < min_chunk_ms:
        bounds[-2][1] = bounds[-1][1]
        bounds.pop()

    plan = []
    for index, (a, b) in enumerate(bounds):
        is_first = index == 0
        is_last = index == len(bounds) - 1
        plan.append(
            {
                "chunk_index": index,
                "chunk_start_ms": a,
                "chunk_end_ms": b,
                "is_first": is_first,
                "is_last": is_last,
                "clip_start_ms": a - (outer_pad_ms if is_first else inner_pad_ms),
                "clip_end_ms": b + (outer_pad_ms if is_last else inner_pad_ms),
            }
        )
    return plan


def assign_chunk_words(
    words: Sequence[dict],
    chunk_start_ms: float,
    chunk_end_ms: float,
    is_first: bool,
    is_last: bool,
) -> List[dict]:
    """Select the words belonging to one chunk of an away window.

    ``is_first``/``is_last`` switch the corresponding edge from start-based
    assignment (which tiles without overlap) to the interval-overlap rule
    (which preserves a word the gaze boundary cut in half).
    """
    out = []
    for word in words:
        if is_first:
            if not word["end_ms"] > chunk_start_ms:
                continue
        elif not word["start_ms"] >= chunk_start_ms:
            continue

        # The upper edge is start-based in both cases: for the last chunk
        # chunk_end_ms is away_end, so this is already the overlap rule.
        if not word["start_ms"] < chunk_end_ms:
            continue

        out.append(word)
    return out


class WindowBuffer:
    """In-memory word accumulation, keyed by (session_id, window_id).

    Memory only, and it never holds anything but words the chunk filter already
    selected -- so attended speech cannot accumulate here either.
    """

    def __init__(self) -> None:
        self._windows: Dict[Tuple[str, str], dict] = {}
        self._lock = threading.Lock()

    def add_chunk(
        self,
        session_id: str,
        window_id: str,
        words: Sequence[dict],
        chunk_index: int,
    ) -> int:
        """Append one chunk's selected words. Returns the running word count."""
        key = (session_id, window_id)
        with self._lock:
            entry = self._windows.setdefault(
                key, {"words": [], "chunks": set(), "covered_until": None,
                      "updated": time.monotonic()}
            )
            if chunk_index in entry["chunks"]:
                # A retried flush must not double-insert.
                return len(entry["words"])
            entry["chunks"].add(chunk_index)
            entry["words"].extend(words)
            entry["words"].sort(key=lambda w: (w["start_ms"], w["end_ms"]))
            entry["updated"] = time.monotonic()
            return len(entry["words"])

    def claim_range(
        self, session_id: str, window_id: str, chunk_start_ms: float, chunk_end_ms: float
    ) -> float:
        """Return the start this chunk may actually assign words from.

        Defence in depth: the browser sends disjoint chunk bounds, but a client
        bug that overlapped two chunks would otherwise store every word in the
        overlap twice (assignment is by start time, per chunk). So the server
        never lets a range be counted twice, whatever the client sends.
        """
        key = (session_id, window_id)
        with self._lock:
            entry = self._windows.setdefault(
                key, {"words": [], "chunks": set(), "covered_until": None,
                      "updated": time.monotonic()}
            )
            covered = entry["covered_until"]
            effective = chunk_start_ms if covered is None else max(chunk_start_ms, covered)
            if covered is None or chunk_end_ms > covered:
                entry["covered_until"] = chunk_end_ms
            return effective

    def get_words(self, session_id: str, window_id: str) -> List[dict]:
        with self._lock:
            entry = self._windows.get((session_id, window_id))
            return list(entry["words"]) if entry else []

    def chunk_indices(self, session_id: str, window_id: str) -> set:
        with self._lock:
            entry = self._windows.get((session_id, window_id))
            return set(entry["chunks"]) if entry else set()

    def chunk_count(self, session_id: str, window_id: str) -> int:
        with self._lock:
            entry = self._windows.get((session_id, window_id))
            return len(entry["chunks"]) if entry else 0

    def pop(self, session_id: str, window_id: str) -> List[dict]:
        """Take the accumulated words and forget the window."""
        with self._lock:
            entry = self._windows.pop((session_id, window_id), None)
            return list(entry["words"]) if entry else []

    def sweep(self, ttl_s: float = WINDOW_TTL_S) -> int:
        """Drop windows nobody ever finalized. Returns how many were dropped."""
        now = time.monotonic()
        with self._lock:
            stale = [k for k, v in self._windows.items() if now - v["updated"] > ttl_s]
            for key in stale:
                del self._windows[key]
            return len(stale)

    def reset(self, session_id: Optional[str] = None) -> None:
        with self._lock:
            if session_id is None:
                self._windows.clear()
            else:
                for key in [k for k in self._windows if k[0] == session_id]:
                    del self._windows[key]

    def __len__(self) -> int:
        with self._lock:
            return len(self._windows)


#: Process-wide buffer used by the API.
window_buffer = WindowBuffer()
