"""Session-wide accumulation of missed text, for the summarizer teammate.

Memory only. It receives nothing but the output of the exact word-overlap
selector, so the invariant holds transitively: attended lecture text can never
enter this store, and therefore can never reach the summarizer.
"""

from __future__ import annotations

import threading
from typing import Dict, List, Optional

from backend.missed_selector import build_raw_text, dedupe_words
from backend.schemas import (
    ClassifiedMissedItem,
    MissedWindowRecord,
    SessionMissedTranscript,
)


class SessionStore:
    """Accumulates MissedWindowRecords per session, ordered by start_ms."""

    def __init__(self) -> None:
        self._sessions: Dict[str, List[MissedWindowRecord]] = {}
        self._origins: Dict[str, float] = {}
        self._lock = threading.Lock()

    def start_session(self, session_id: str, started_at_ms: float = 0.0) -> None:
        with self._lock:
            self._sessions.setdefault(session_id, [])
            self._origins[session_id] = started_at_ms

    def append(self, session_id: str, record: MissedWindowRecord) -> MissedWindowRecord:
        """Add a window, merging it with any window it overlaps.

        A loose gaze debounce can emit overlapping away windows; merging on
        append keeps the summarizer from seeing the same sentence twice,
        without ever dropping a word.
        """
        with self._lock:
            windows = self._sessions.setdefault(session_id, [])

            overlapping = [
                w for w in windows
                if record.start_ms <= w.end_ms and w.start_ms <= record.end_ms
            ]
            if overlapping:
                for w in overlapping:
                    windows.remove(w)
                record = _merge(overlapping + [record])

            windows.append(record)
            windows.sort(key=lambda w: w.start_ms)
            return record

    def get(self, session_id: str) -> SessionMissedTranscript:
        with self._lock:
            windows = list(self._sessions.get(session_id, []))
            origin = self._origins.get(session_id, 0.0)

        sentences: List[ClassifiedMissedItem] = []
        for window in windows:
            sentences.extend(window.items)
        sentences.sort(key=lambda i: (i.start_ms, i.end_ms))

        return SessionMissedTranscript(
            session_id=session_id,
            started_at_ms=origin,
            windows=windows,
            sentences=sentences,
            raw_text="\n".join(w.raw_text for w in windows if w.raw_text),
        )

    def reset(self, session_id: Optional[str] = None) -> None:
        with self._lock:
            if session_id is None:
                self._sessions.clear()
                self._origins.clear()
            else:
                self._sessions.pop(session_id, None)
                self._origins.pop(session_id, None)

    def session_ids(self) -> List[str]:
        with self._lock:
            return list(self._sessions)


def _merge(windows: List[MissedWindowRecord]) -> MissedWindowRecord:
    """Fuse overlapping windows into one, de-duplicating repeated words."""
    windows = sorted(windows, key=lambda w: w.start_ms)

    words = dedupe_words([w.model_dump() for win in windows for w in win.words])

    seen = set()
    items: List[ClassifiedMissedItem] = []
    for window in windows:
        for item in window.items:
            key = (item.start_ms, item.end_ms, item.text)
            if key in seen:
                continue
            seen.add(key)
            items.append(item)
    items.sort(key=lambda i: (i.start_ms, i.end_ms))

    # Rebuild raw_text from the de-duplicated words when we have them, so a
    # merge can never duplicate a sentence; otherwise keep every window's text.
    raw_text = (
        build_raw_text(words)
        if words
        else " ".join(w.raw_text for w in windows if w.raw_text)
    )

    return MissedWindowRecord(
        start_ms=min(w.start_ms for w in windows),
        end_ms=max(w.end_ms for w in windows),
        raw_text=raw_text,
        items=items,
        words=[w for w in words],
        classifier_ok=all(w.classifier_ok for w in windows),
        processing_time_s=max(
            (w.processing_time_s for w in windows if w.processing_time_s is not None),
            default=None,
        ),
    )


#: Process-wide store used by the API.
store = SessionStore()
