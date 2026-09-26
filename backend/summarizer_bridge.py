"""Bridge to the teammate's summarizer (summarizer.py on the `summarizer` branch).

Their module is an in-process Python library -- `summarize(text, max_words)`
backed by a local Ollama model -- so this FastAPI app is the natural home for
the HTTP bridge their web app's sources.js asks for.

Two rules this module exists to enforce:

* **Only missed text reaches the LLM.** The bridge never accepts free text from
  the browser. It summarizes windows already in the session store, which only
  ever receives the exact word-overlap selector's output. So attended lecture
  speech cannot reach Ollama even if a client misbehaves.
* **Summarization is enhancement, never a dependency.** Ollama down, model not
  pulled, module missing: the caller still gets the Laya priorities and the
  exact words. Nothing here raises into a request.
"""

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

#: Kinds worth surfacing as "Priorities:" in the catch-up card, most urgent first.
PRIORITY_KINDS = ("question_to_you", "instruction_change", "decision_reason")

#: Their prompt is tuned for 30-90 s of speech and a 4096-token context.
DEFAULT_MAX_WORDS = int(os.getenv("SUMMARY_MAX_WORDS", "60"))
#: A manual catch-up can span many windows; each is an Ollama call of 3-4.5 s.
MAX_WINDOWS_PER_SUMMARY = int(os.getenv("SUMMARY_MAX_WINDOWS", "5"))

_module = None
_load_error: Optional[str] = None
_load_lock = threading.Lock()
# One local LLM; concurrent calls would just queue inside Ollama anyway.
_call_lock = threading.Lock()


def _load():
    """Import summarizer.py once. Returns the module, or None if unavailable."""
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
                log.warning("%s -- catch-up cards will show priorities and exact words only",
                            _load_error)
    return _module


def warm_up() -> Optional[float]:
    """Load the Ollama model ahead of the first catch-up. Never raises."""
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
    """Laya-tagged fragments that deserve a 'Priorities:' line, most urgent first.

    This is the one place the classifier earns its keep in the teammate's UI:
    their card has a `priorities: string[]` slot the mock filled from
    hand-written metadata. We fill it with what was actually said.
    """
    wanted = [i for i in items if i.kind in PRIORITY_KINDS]
    wanted.sort(key=lambda i: (-i.priority, i.start_ms))
    seen, out = set(), []
    for item in wanted:
        if item.text not in seen:
            seen.add(item.text)
            out.append(item.text)
    return out


def _summarize_text(text: str, max_words: int) -> tuple[Optional[str], Optional[str]]:
    """Call summarizer.summarize. Returns (summary, error)."""
    module = _load()
    if module is None:
        return None, _load_error
    try:
        with _call_lock:
            summary = module.summarize(text, max_words=max_words)
        return (summary or None), None
    except Exception as exc:
        # Their module raises RuntimeError when Ollama is unreachable or the
        # model is not pulled. That must degrade, not fail the card.
        log.warning("summarizer call failed: %s", exc)
        return None, str(exc)


def summarize_windows(
    windows: Sequence[MissedWindowRecord],
    max_words: int = DEFAULT_MAX_WORDS,
) -> dict:
    """Summarize stored missed windows into the shape the web app renders.

    One window -> `summary` is a string. Several -> one string per window, which
    the card renders as a bullet list. Their model reads a single string as one
    continuous passage and has no notion of gaps, so non-adjacent absences are
    summarized separately rather than concatenated into a false narrative.
    """
    windows = [w for w in windows if w.raw_text]
    if len(windows) > MAX_WINDOWS_PER_SUMMARY:
        windows = windows[-MAX_WINDOWS_PER_SUMMARY:]

    items = [item for w in windows for item in w.items]
    priorities = priorities_from_items(items)

    if not windows:
        return {"summary": None, "priorities": [], "summarizer_ok": True,
                "error": None, "windows": 0}

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
    """Swap in a fake summarizer module (or a load error) for tests."""
    global _module, _load_error
    _module, _load_error = module, error
