"""Bridge to summarizer.py (Ollama). Only missed text reaches the LLM; failures degrade, never raise."""

from __future__ import annotations

import importlib
import logging
import os
import sys
import threading
import time
from typing import List, Optional, Sequence

from backend.schemas import ClassifiedMissedItem, MissedWindowRecord

log = logging.getLogger(__name__)

PRIORITY_KINDS = ("question_to_you", "instruction_change", "decision_reason")
DEFAULT_MAX_WORDS = int(os.getenv("SUMMARY_MAX_WORDS", "60"))
MAX_WINDOWS_PER_SUMMARY = int(os.getenv("SUMMARY_MAX_WINDOWS", "5"))

MIN_PRIORITY_WORDS = 5
MIN_PRIORITY_CONFIDENCE = 0.6
_FILLER = {"okay", "ok", "so", "yeah", "right", "um", "uh", "alright", "well", "briefly", "sorry", "i'm"}

_module = None
_load_error: Optional[str] = None
_load_lock = threading.Lock()
_call_lock = threading.Lock()


def _load():
    global _module, _load_error
    if _module is not None or _load_error is not None:
        return _module
    with _load_lock:
        if _module is None and _load_error is None:
            extra = os.getenv("SUMMARIZER_DIR")
            if extra and extra not in sys.path:
                sys.path.insert(0, extra)
            try:
                _module = importlib.import_module("summarizer")
                log.info("summarizer module loaded from %s", getattr(_module, "__file__", "?"))
            except Exception as exc:
                _load_error = f"summarizer.py not importable: {exc}"
                log.warning("%s -- catch-up cards will show priorities and exact words only", _load_error)
    return _module


def warm_up() -> Optional[float]:
    module = _load()
    if module is None or not hasattr(module, "warm_up"):
        return None
    t0 = time.time()
    try:
        with _call_lock:
            module.warm_up()
    except Exception as exc:
        log.warning("summarizer warm-up failed (is Ollama running?): %s", exc)
        return None
    return time.time() - t0


def priorities_from_items(items: Sequence[ClassifiedMissedItem]) -> List[str]:
    """Fallback when the LLM is unavailable: Laya tags, filtered hard."""
    wanted = [i for i in items if i.kind in PRIORITY_KINDS
              and len(i.text.split()) >= MIN_PRIORITY_WORDS
              and (i.confidence is None or i.confidence >= MIN_PRIORITY_CONFIDENCE)
              and not set(i.text.lower().replace(",", "").replace(".", "").split()) <= _FILLER]
    wanted.sort(key=lambda i: (-i.priority, i.start_ms))
    seen, out = set(), []
    for item in wanted:
        if item.text not in seen:
            seen.add(item.text)
            out.append(item.text)
    return out[:5]


def _llm_priorities(windows: Sequence[MissedWindowRecord]) -> Optional[List[str]]:
    """Questions / formulas / dates via summarizer.extract_priorities. None if unavailable."""
    module = _load()
    if module is None or not hasattr(module, "extract_priorities"):
        return None
    out: List[str] = []
    try:
        for w in windows:
            with _call_lock:
                for p in module.extract_priorities(w.raw_text):
                    if p not in out:
                        out.append(p)
    except Exception as exc:
        log.warning("priority extraction failed, falling back to Laya tags: %s", exc)
        return None
    return out[:5]


def _summarize_text(text: str, max_words: int) -> tuple[Optional[str], Optional[str]]:
    module = _load()
    if module is None:
        return None, _load_error
    try:
        with _call_lock:
            summary = module.summarize(text, max_words=max_words)
        return (summary or None), None
    except Exception as exc:
        log.warning("summarizer call failed: %s", exc)
        return None, str(exc)


def summarize_windows(
    windows: Sequence[MissedWindowRecord],
    max_words: int = DEFAULT_MAX_WORDS,
) -> dict:
    windows = [w for w in windows if w.raw_text]
    if len(windows) > MAX_WINDOWS_PER_SUMMARY:
        windows = windows[-MAX_WINDOWS_PER_SUMMARY:]

    if not windows:
        return {"summary": None, "priorities": [], "summarizer_ok": True, "error": None, "windows": 0}

    items = [item for w in windows for item in w.items]
    priorities = _llm_priorities(windows)
    if priorities is None:
        priorities = priorities_from_items(items)

    summaries, errors = [], []
    for window in windows:
        summary, error = _summarize_text(window.raw_text, max_words)
        if summary:
            summaries.append(summary)
        if error:
            errors.append(error)

    if not summaries:
        summary_out = None
    elif len(windows) == 1:
        summary_out = summaries[0]
    else:
        summary_out = summaries

    return {
        "summary": summary_out,
        "priorities": priorities,
        "summarizer_ok": not errors,
        "error": errors[0] if errors else None,
        "windows": len(windows),
    }


def status() -> dict:
    module = _load()
    return {
        "available": module is not None,
        "module": getattr(module, "__file__", None) if module else None,
        "model": getattr(module, "MODEL", None) if module else None,
        "error": _load_error,
    }


def _reset_for_tests(module=None, error: Optional[str] = None) -> None:
    global _module, _load_error
    _module, _load_error = module, error
