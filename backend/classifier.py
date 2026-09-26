"""Laya tagging of already-missed text.

Placement rule from CLAUDE.md: this runs *after* the exact word-overlap filter
and only ever sees text the student actually missed. It ranks and tags; it can
never decide that something was missed, and it can never cause missed text to
be lost. Every failure path returns the text with kind="unclassified" and
show_by_default=True -- fail open, never closed.

API notes verified against the laya v0.3.20 tag:
  * laya.load() takes subfolder= and device=; it does NOT read LAYA_DEVICE.
  * agent.predict is an alias of system_one; predict_batch requires a list.
  * A choice answer's "confidence" is normalized Shannon entropy, NOT calibrated.
    "answer_confidence" (= max(p)) is the calibrated one, so that is what we
    report. Neither is ever used to hide text.
  * Each criteria description is hard-truncated at 48 tokens and the
    instructions share a 256-token head budget with them, so both stay short.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import List, Optional, Sequence

from backend import config
from backend.schemas import PRIORITY

log = logging.getLogger(__name__)

LAYA_QUESTIONS = {
    "missed_kind": {
        "type": "choice",
        "instructions": (
            "Classify this excerpt from a university lecture. Choose the one "
            "category describing what the student must recover after missing it."
        ),
        # Wording chosen by sweeping variants against the 12-case benchmark in
        # tests/test_laya_classifier_real.py: this phrasing scores 11/12 where
        # the brief's original wording scored 6/12. Describing the *speaker's
        # act* ("the speaker asks...") beats naming the category. Frozen.
        "criteria": {
            "A": (
                "The speaker asks the student a question, or requests an "
                "answer, opinion or explanation from them."
            ),
            "B": (
                "An instruction or task, or a change to a deadline, date, "
                "reading, or submission method."
            ),
            "C": (
                "A conclusion, choice or result stated together with the "
                "reason or evidence for it."
            ),
            "D": (
                "Explanation of a concept, a definition, a description, or a "
                "transition to the next topic."
            ),
        },
    }
}

LABEL_MAP = {
    "A": "question_to_you",
    "B": "instruction_change",
    "C": "decision_reason",
    "D": "ordinary_context",
}

_agent = None
_lock = threading.Lock()
# Guards inference. One MPS model, potentially several concurrent recoveries.
_infer_lock = threading.Lock()
_load_error: Optional[str] = None


def get_agent():
    """Load the Laya checkpoint once. Returns None if it is off or unavailable."""
    global _agent, _load_error

    if not config.LAYA_ENABLED:
        return None
    if _agent is not None:
        return _agent
    if _load_error is not None:
        return None

    with _lock:
        if _agent is None and _load_error is None:
            try:
                import laya

                t0 = time.time()
                log.info(
                    "loading laya %s (subfolder=%s, device=%s)",
                    config.LAYA_MODEL,
                    config.LAYA_SUBFOLDER,
                    config.LAYA_DEVICE or "auto",
                )
                _agent = laya.load(
                    config.LAYA_MODEL,
                    subfolder=config.LAYA_SUBFOLDER or None,
                    device=config.LAYA_DEVICE,
                )
                log.info(
                    "laya loaded in %.1fs on %s",
                    time.time() - t0,
                    getattr(_agent, "device", "?"),
                )
            except Exception as exc:  # pragma: no cover - environment dependent
                _load_error = str(exc)
                log.warning("laya unavailable, falling back to unclassified: %s", exc)
                _agent = None

    return _agent


def _unclassified(texts: Sequence[str]) -> List[dict]:
    return [
        {
            "text": text,
            "kind": "unclassified",
            "confidence": None,
            "entropy_confidence": None,
            "probabilities": None,
            "priority": PRIORITY["unclassified"],
            "show_by_default": True,
        }
        for text in texts
    ]


def classify_missed_fragments(texts: Sequence[str]) -> tuple[List[dict], bool]:
    """Tag missed fragments. Returns (items, classifier_ok).

    ``classifier_ok`` is False whenever we fell back, so callers can surface
    that Laya did not run without changing what the student sees.
    """
    if not texts:
        return [], True

    agent = get_agent()
    if agent is None:
        return _unclassified(texts), False

    try:
        # Plain strings: a dict state would be JSON-dumped verbatim into the
        # prompt, adding braces and key names as noise.
        with _infer_lock:
            results = agent.predict_batch(list(texts), LAYA_QUESTIONS)
    except Exception as exc:
        log.warning("laya predict_batch failed, falling back to unclassified: %s", exc)
        return _unclassified(texts), False

    out: List[dict] = []
    for text, result in zip(texts, results):
        try:
            answer = result["answers"]["missed_kind"]
            kind = LABEL_MAP.get(answer.get("choice"), "unclassified")
            out.append(
                {
                    "text": text,
                    "kind": kind,
                    "confidence": answer.get("answer_confidence"),
                    "entropy_confidence": answer.get("confidence"),
                    "probabilities": answer.get("probabilities"),
                    "priority": PRIORITY[kind],
                    # ordinary_context may be collapsed in the compact card, but
                    # it is never deleted -- raw_text still holds it.
                    "show_by_default": kind != "ordinary_context",
                }
            )
        except Exception as exc:
            log.warning("could not read laya answer, failing open: %s", exc)
            out.extend(_unclassified([text]))

    return out, True


def sort_for_card(items: List[dict]) -> List[dict]:
    """Compact-card order: priority DESC, then start_ms ASC."""
    return sorted(items, key=lambda i: (-i.get("priority", 1), i.get("start_ms", 0)))


def warmup() -> Optional[float]:
    """Run one forward pass so the first real request is not a cold start."""
    agent = get_agent()
    if agent is None:
        return None
    t0 = time.time()
    try:
        with _infer_lock:
            agent.predict("warmup", LAYA_QUESTIONS)
    except Exception as exc:  # pragma: no cover
        log.warning("laya warmup failed: %s", exc)
        return None
    return time.time() - t0


def status() -> dict:
    return {
        "enabled": config.LAYA_ENABLED,
        "loaded": _agent is not None,
        "error": _load_error,
        "model": config.LAYA_MODEL,
        "subfolder": config.LAYA_SUBFOLDER,
        "device": str(getattr(_agent, "device", None)) if _agent is not None else None,
    }
