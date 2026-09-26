"""Pydantic mirrors of the data contract in CLAUDE.md Part 1."""

from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field

MissedKind = Literal[
    "question_to_you",
    "instruction_change",
    "decision_reason",
    "ordinary_context",
    "unclassified",
]

#: Ranking used by the compact recovery card. Higher shows first.
PRIORITY: dict[str, int] = {
    "question_to_you": 4,
    "instruction_change": 3,
    "decision_reason": 2,
    "ordinary_context": 1,
    "unclassified": 1,
}


class TranscriptWord(BaseModel):
    start_ms: int
    end_ms: int
    text: str
    probability: Optional[float] = None


class TranscriptUnit(BaseModel):
    start_ms: int
    end_ms: int
    text: str
    words: List[TranscriptWord] = Field(default_factory=list)


class TranscribeResponse(BaseModel):
    text: str
    segments: List[TranscriptUnit] = Field(default_factory=list)
    words: List[TranscriptWord] = Field(default_factory=list)
    processing_time_s: float


class ClassifiedMissedItem(BaseModel):
    start_ms: int
    end_ms: int
    text: str
    kind: MissedKind = "unclassified"
    #: Calibrated max(p) from Laya. Diagnostics only -- never a visibility gate.
    confidence: Optional[float] = None
    #: Normalized-entropy confidence. A different scale; kept for debugging only.
    entropy_confidence: Optional[float] = None
    probabilities: Optional[dict[str, float]] = None
    priority: int = 1
    show_by_default: bool = True


class MissedWindowRecord(BaseModel):
    start_ms: int
    end_ms: int
    #: Every word actually missed. Always populated, whatever the classifier did.
    raw_text: str
    items: List[ClassifiedMissedItem] = Field(default_factory=list)
    words: List[TranscriptWord] = Field(default_factory=list)
    classifier_ok: bool = True
    processing_time_s: Optional[float] = None


class SessionMissedTranscript(BaseModel):
    """Everything the student missed this session -- the summarizer's input."""

    session_id: str
    started_at_ms: float = 0.0
    windows: List[MissedWindowRecord] = Field(default_factory=list)
    #: Flat, ordered by start_ms. Includes ordinary_context; nothing is dropped.
    sentences: List[ClassifiedMissedItem] = Field(default_factory=list)
    raw_text: str = ""
