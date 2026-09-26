"""The mandated order: select -> preserve raw -> fragment -> classify.

Kept separate from the HTTP layer so tests can drive the whole pipeline from a
word list, with no audio and no server.
"""

from __future__ import annotations

from typing import List, Optional, Sequence

from backend import classifier, config
from backend.missed_selector import (
    build_raw_text,
    fragment_missed_text,
    select_missed_words,
)
from backend.schemas import ClassifiedMissedItem, MissedWindowRecord, PRIORITY


def build_missed_window_record(
    words: Sequence[dict],
    away_start_ms: int,
    away_end_ms: int,
    threshold_ms: Optional[int] = None,
    processing_time_s: Optional[float] = None,
) -> MissedWindowRecord:
    """Turn raw Whisper words plus an away window into the durable record.

    Order matters and is not negotiable: timestamps decide what was missed,
    then the raw text is preserved, and only then does the classifier see
    anything. The classifier's input is derived from the selection, so it can
    never receive attended text.
    """
    threshold = config.AWAY_THRESHOLD_MS if threshold_ms is None else threshold_ms

    missed = select_missed_words(words, away_start_ms, away_end_ms, threshold)
    raw_text = build_raw_text(missed)

    if not missed:
        return MissedWindowRecord(
            start_ms=int(away_start_ms),
            end_ms=int(away_end_ms),
            raw_text="",
            items=[],
            words=[],
            classifier_ok=True,
            processing_time_s=processing_time_s,
        )

    fragments = fragment_missed_text(
        missed, max_words_per_fragment=config.MAX_WORDS_PER_FRAGMENT
    )

    tagged, classifier_ok = classifier.classify_missed_fragments(
        [f["text"] for f in fragments]
    )

    items: List[ClassifiedMissedItem] = []
    for fragment, tag in zip(fragments, tagged):
        items.append(
            ClassifiedMissedItem(
                start_ms=fragment["start_ms"],
                end_ms=fragment["end_ms"],
                text=fragment["text"],
                kind=tag["kind"],
                confidence=tag.get("confidence"),
                entropy_confidence=tag.get("entropy_confidence"),
                probabilities=tag.get("probabilities"),
                priority=tag.get("priority", PRIORITY["unclassified"]),
                show_by_default=tag.get("show_by_default", True),
            )
        )

    # Defensive: a classifier that returned too few results must not silently
    # drop a fragment from the card. Fail open.
    for fragment in fragments[len(tagged):]:
        items.append(
            ClassifiedMissedItem(
                start_ms=fragment["start_ms"],
                end_ms=fragment["end_ms"],
                text=fragment["text"],
            )
        )
        classifier_ok = False

    return MissedWindowRecord(
        start_ms=int(away_start_ms),
        end_ms=int(away_end_ms),
        raw_text=raw_text,
        items=items,
        words=[dict(w) for w in missed],
        classifier_ok=classifier_ok,
        processing_time_s=processing_time_s,
    )
