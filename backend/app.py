"""Silent Specs STT backend.

Endpoints:
  GET  /health                      model + classifier status
  POST /warmup                      force both models to load and run once
  POST /transcribe                  raw STT with word timestamps (debugging)
  POST /recover                     the product path: audio + away window -> record
  GET  /session/{id}/missed         accumulated missed transcript (summarizer)
  POST /session/{id}/reset          clear a session
"""

from __future__ import annotations

import logging
import os
import tempfile
import time
from typing import Optional

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from fastapi.staticfiles import StaticFiles

from backend import classifier, config, stt, summarizer_bridge
from backend.pipeline import build_missed_window_record
from backend.schemas import (
    MissedWindowRecord,
    SessionMissedTranscript,
    TranscribeResponse,
)
from backend.session_store import store
from backend.window_buffer import assign_chunk_words, window_buffer

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)
log = logging.getLogger("silentspecs")

app = FastAPI(title="Silent Specs STT", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _save_upload(audio: UploadFile) -> str:
    suffix = os.path.splitext(audio.filename or "")[1] or ".wav"
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as fh:
        fh.write(audio.file.read())
    return path


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "whisper": {
            "model": config.WHISPER_MODEL,
            "device": config.WHISPER_DEVICE,
            "compute_type": config.WHISPER_COMPUTE_TYPE,
            "loaded": stt._model is not None,
        },
        "laya": classifier.status(),
        "summarizer": summarizer_bridge.status(),
        "away_threshold_ms": config.AWAY_THRESHOLD_MS,
        "clip_pad_ms": config.CLIP_PAD_MS,
        # The browser plans its chunks from these, so there is one source of truth.
        "chunk_ms": config.CHUNK_MS,
        "min_chunk_ms": config.MIN_CHUNK_MS,
        "chunk_pad_ms": config.CHUNK_PAD_MS,
    }


@app.post("/warmup")
def warmup() -> dict:
    whisper_s = stt.warmup()
    laya_s = classifier.warmup()
    summarizer_s = summarizer_bridge.warm_up()
    log.info("warmup: whisper=%.2fs laya=%s summarizer=%s", whisper_s or -1, laya_s, summarizer_s)
    return {"whisper_warmup_s": whisper_s, "laya_warmup_s": laya_s,
            "summarizer_warmup_s": summarizer_s, **health()}


# NOTE: `def`, not `async def`. These do blocking CPU work; on the event loop
# they would freeze the whole server for the duration of a transcription.
@app.post("/transcribe", response_model=TranscribeResponse)
def transcribe(
    audio: UploadFile = File(...),
    clip_start_ms: int = Form(0),
    vad_filter: bool = Form(True),
) -> TranscribeResponse:
    path = _save_upload(audio)
    try:
        segments, words, text, elapsed = stt.transcribe_clip(
            path, clip_start_ms=clip_start_ms, vad_filter=vad_filter
        )
    except Exception as exc:
        log.exception("transcription failed")
        raise HTTPException(status_code=500, detail=f"transcription failed: {exc}")
    finally:
        os.unlink(path)

    return TranscribeResponse(
        text=text, segments=segments, words=words, processing_time_s=elapsed
    )


@app.post("/recover", response_model=MissedWindowRecord)
def recover(
    audio: UploadFile = File(...),
    away_start_ms: int = Form(...),
    away_end_ms: int = Form(...),
    clip_start_ms: int = Form(0),
    session_id: str = Form("default"),
    vad_filter: bool = Form(True),
    background: BackgroundTasks = None,
) -> MissedWindowRecord:
    """Audio for one away window in, durable missed-text record out."""
    if away_end_ms < away_start_ms:
        raise HTTPException(status_code=400, detail="away_end_ms precedes away_start_ms")

    t0 = time.time()
    path = _save_upload(audio)
    try:
        _segments, words, _text, _elapsed = stt.transcribe_clip(
            path, clip_start_ms=clip_start_ms, vad_filter=vad_filter
        )
    except Exception as exc:
        log.exception("recovery transcription failed")
        raise HTTPException(status_code=500, detail=f"transcription failed: {exc}")
    finally:
        os.unlink(path)

    record = build_missed_window_record(
        words,
        away_start_ms=away_start_ms,
        away_end_ms=away_end_ms,
        processing_time_s=time.time() - t0,
    )

    if record.raw_text:
        record = store.append(session_id, record)
        if background is not None:
            # Off the request path: a slow summarizer must not delay the card.
            background.add_task(_notify_summarizer, session_id, record)

    log.info(
        "recovered window [%d, %d] -> %d words, %d items in %.2fs (classifier_ok=%s)",
        record.start_ms,
        record.end_ms,
        len(record.words),
        len(record.items),
        record.processing_time_s or 0.0,
        record.classifier_ok,
    )
    return record


@app.post("/window/{window_id}/chunk")
def window_chunk(
    window_id: str,
    audio: UploadFile = File(...),
    session_id: str = Form("default"),
    chunk_index: int = Form(0),
    chunk_start_ms: int = Form(...),
    chunk_end_ms: int = Form(...),
    clip_start_ms: int = Form(0),
    is_first: bool = Form(False),
    is_last: bool = Form(False),
    vad_filter: bool = Form(True),
) -> dict:
    """One slice of an in-progress away window.

    The browser flushes these while the student is still away, so an absence
    longer than the audio ring buffer is still captured in full and the wait on
    return is bounded by the last partial chunk rather than the whole absence.
    """
    path = _save_upload(audio)
    try:
        _segments, words, _text, _elapsed = stt.transcribe_clip(
            path, clip_start_ms=clip_start_ms, vad_filter=vad_filter
        )
    except Exception as exc:
        log.exception("chunk transcription failed")
        raise HTTPException(status_code=500, detail=f"transcription failed: {exc}")
    finally:
        os.unlink(path)

    # A retry of an already-stored chunk is a no-op; check before claiming so
    # it cannot advance the covered range either.
    if chunk_index in window_buffer.chunk_indices(session_id, window_id):
        total = len(window_buffer.get_words(session_id, window_id))
        return {"window_id": window_id, "chunk_index": chunk_index,
                "words_in_chunk": 0, "words_total": total, "duplicate": True}

    # Never count a range twice, whatever bounds the client sent.
    effective_start = window_buffer.claim_range(
        session_id, window_id, chunk_start_ms, chunk_end_ms
    )
    clipped = effective_start > chunk_start_ms

    # Tile without overlap: interior edges assign by start time, outer edges
    # keep the interval-overlap rule so a word cut by the gaze survives. A
    # clipped chunk has lost its true first edge, so it is interior there.
    selected = assign_chunk_words(
        words, effective_start, chunk_end_ms,
        is_first=is_first and not clipped, is_last=is_last,
    )
    total = window_buffer.add_chunk(session_id, window_id, selected, chunk_index)
    if clipped:
        log.warning(
            "window %s chunk %d overlapped earlier chunks; clipped start %d -> %d",
            window_id, chunk_index, chunk_start_ms, effective_start,
        )

    log.info(
        "window %s chunk %d [%d, %d] -> %d of %d words kept (%d total)",
        window_id, chunk_index, chunk_start_ms, chunk_end_ms,
        len(selected), len(words), total,
    )
    return {"window_id": window_id, "chunk_index": chunk_index,
            "words_in_chunk": len(selected), "words_total": total}


@app.post("/window/{window_id}/finalize", response_model=MissedWindowRecord)
def window_finalize(
    window_id: str,
    session_id: str = Form("default"),
    away_start_ms: int = Form(...),
    away_end_ms: int = Form(...),
    background: BackgroundTasks = None,
) -> MissedWindowRecord:
    """Close a chunked away window and produce its durable record."""
    if away_end_ms < away_start_ms:
        window_buffer.pop(session_id, window_id)
        raise HTTPException(status_code=400, detail="away_end_ms precedes away_start_ms")

    t0 = time.time()
    words = window_buffer.pop(session_id, window_id)

    # The chunk filter already selected these, but running the selector again
    # costs nothing and keeps the invariant enforced in exactly one place.
    record = build_missed_window_record(
        words,
        away_start_ms=away_start_ms,
        away_end_ms=away_end_ms,
        processing_time_s=time.time() - t0,
    )

    if record.raw_text:
        record = store.append(session_id, record)
        if background is not None:
            background.add_task(_notify_summarizer, session_id, record)

    log.info(
        "finalized window %s [%d, %d] -> %d words, %d items",
        window_id, record.start_ms, record.end_ms, len(record.words), len(record.items),
    )
    return record


@app.get("/session/{session_id}/missed", response_model=SessionMissedTranscript)
def session_missed(session_id: str) -> SessionMissedTranscript:
    """Everything the student missed this session. The summarizer's input."""
    return store.get(session_id)


class SummarizeRequest(BaseModel):
    #: Session-timeline range (monotonic ms). Windows overlapping it are summarized.
    from_ms: float
    to_ms: float
    max_words: int = summarizer_bridge.DEFAULT_MAX_WORDS


@app.post("/session/{session_id}/summarize")
def session_summarize(session_id: str, request: SummarizeRequest) -> dict:
    """Summarize the stored missed windows overlapping a range.

    Deliberately takes a *range*, never free text: the text sent to the LLM is
    read from the session store, which only ever holds selector output. A
    client therefore cannot route attended speech to the summarizer.
    """
    windows = [
        w for w in store.get(session_id).windows
        if w.end_ms > request.from_ms and w.start_ms < request.to_ms
    ]
    result = summarizer_bridge.summarize_windows(windows, max_words=request.max_words)
    log.info(
        "summarized %d window(s) for %s (summarizer_ok=%s)",
        result["windows"], session_id, result["summarizer_ok"],
    )
    return result


@app.get("/session/{session_id}/summary")
def session_summary(session_id: str, max_words: int = summarizer_bridge.DEFAULT_MAX_WORDS) -> dict:
    """A recap of everything missed this session."""
    return summarizer_bridge.summarize_windows(
        store.get(session_id).windows, max_words=max_words
    )


@app.post("/session/{session_id}/reset")
def session_reset(session_id: str, started_at_ms: float = 0.0) -> dict:
    store.reset(session_id)
    window_buffer.reset(session_id)
    store.start_session(session_id, started_at_ms)
    return {"ok": True, "session_id": session_id}


def _notify_summarizer(session_id: str, record: MissedWindowRecord) -> None:
    """Runs as a background task, after the response has been sent.

    A broken or slow summarizer must never delay or break recovery.
    """
    if not config.SUMMARIZER_URL:
        return
    try:
        import httpx

        httpx.post(
            config.SUMMARIZER_URL,
            json={"session_id": session_id, "record": record.model_dump()},
            timeout=2.0,
        )
    except Exception as exc:
        log.warning("summarizer notification failed (ignored): %s", exc)


# One origin for everything, so the web app needs no CORS and its ES-module
# import of /js/silentspecs-source.js just works. Specific mounts first: a
# mount at "/" would otherwise swallow them.
_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_frontend = os.path.join(_root, "frontend")
_web = os.path.join(_root, "web")

if os.path.isdir(_frontend):
    # Shared ES modules: the capture, gaze and recovery pipeline.
    app.mount("/js", StaticFiles(directory=os.path.join(_frontend, "js")), name="js")
    # Our diagnostics page: capture health, raw cards, the summarizer payload.
    app.mount("/debug", StaticFiles(directory=_frontend, html=True), name="debug")
if os.path.isdir(_web):
    # The teammate's app is the product UI. Open /?source=python for the real pipeline.
    app.mount("/", StaticFiles(directory=_web, html=True), name="web")
