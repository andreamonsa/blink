/**
 * Turning a confirmed away window into durable missed text (chunked).
 */

import { buildRawText, selectMissedWords } from "./missed-selector.js";
import { sessionNowMs } from "./session.js";

const DEFAULTS = {
  chunkMs: 20_000,
  minChunkMs: 8_000,
  outerPadMs: 250,
  innerPadMs: 2_000,
  thresholdMs: 2_000,
};

let windowSeq = 0;

export function createRecovery({
  capture,
  store,
  backendUrl = "",
  getConfig = () => DEFAULTS,
  onStatus = () => {},
}) {
  let active = null;
  let flushTimer = null;
  let flushInFlight = Promise.resolve();
  let pending = Promise.resolve(null);

  const cfg = () => ({ ...DEFAULTS, ...getConfig() });

  async function postChunk(chunkStartMs, chunkEndMs, isFirst, isLast, minClipMs = 0) {
    const { outerPadMs, innerPadMs } = cfg();
    let clipStart = chunkStartMs - (isFirst ? outerPadMs : innerPadMs);
    const clipEnd = chunkEndMs + (isLast ? outerPadMs : innerPadMs);
    if (!isFirst && clipEnd - clipStart < minClipMs) clipStart = clipEnd - minClipMs;

    const slice = capture.sliceToWav(clipStart, clipEnd);
    if (!slice) {
      onStatus({ phase: "chunk-missing", chunkStartMs, chunkEndMs });
      return false;
    }
    if (slice.truncated) {
      console.warn("[silentspecs] chunk older than the audio buffer; start lost");
    }

    const form = new FormData();
    form.append("audio", slice.blob, "chunk.wav");
    form.append("session_id", store.sessionId);
    form.append("chunk_index", String(active.nextIndex));
    form.append("chunk_start_ms", String(Math.round(chunkStartMs)));
    form.append("chunk_end_ms", String(Math.round(chunkEndMs)));
    form.append("clip_start_ms", String(slice.clipStartMs));
    form.append("is_first", String(isFirst));
    form.append("is_last", String(isLast));

    try {
      const response = await fetch(`${backendUrl}/window/${active.id}/chunk`, {
        method: "POST", body: form,
      });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      active.nextIndex += 1;
      onStatus({ phase: "chunk", chunkStartMs, chunkEndMs, isLast });
      return true;
    } catch (err) {
      onStatus({ phase: "error", message: `chunk upload failed: ${err.message}` });
      return false;
    }
  }

  function flushReadyChunks() {
    if (!active || active.flushing) return flushInFlight;
    const win = active;
    win.flushing = true;
    flushInFlight = (async () => {
      try {
        const { chunkMs } = cfg();
        const newest = capture.newestAvailableMs;
        while (active === win && newest != null && win.cursor + chunkMs <= newest) {
          const start = win.cursor;
          const end = start + chunkMs;
          await postChunk(start, end, win.nextIndex === 0, false);
          win.cursor = end;
        }
      } finally {
        win.flushing = false;
      }
    })();
    return flushInFlight;
  }

  async function drainTo(endMs) {
    const { chunkMs, minChunkMs } = cfg();
    while (
      active.cursor + chunkMs <= endMs &&
      endMs - (active.cursor + chunkMs) >= minChunkMs
    ) {
      const start = active.cursor;
      const end = start + chunkMs;
      await postChunk(start, end, active.nextIndex === 0, false);
      active.cursor = end;
    }
  }

  function beginWindow(awayStartMs) {
    if (active) return active.id;
    active = {
      id: `w${++windowSeq}-${Date.now().toString(36)}`,
      startMs: awayStartMs,
      cursor: awayStartMs,
      nextIndex: 0,
      flushing: false,
    };
    clearInterval(flushTimer);
    flushTimer = setInterval(flushReadyChunks, 1000);
    if (typeof flushTimer?.unref === "function") flushTimer.unref();
    onStatus({ phase: "window-open", start_ms: awayStartMs, window_id: active.id });
    return active.id;
  }

  function stopFlushing() {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  async function recoverMissedWindow({ start_ms, end_ms }) {
    const t0 = performance.now();
    const { minChunkMs, thresholdMs } = cfg();
    onStatus({ phase: "recovering", start_ms, end_ms });

    if (!active) beginWindow(start_ms);
    stopFlushing();
    await flushInFlight;
    const windowId = active.id;

    await drainTo(end_ms);

    if (end_ms > active.cursor) {
      await postChunk(active.cursor, end_ms, active.nextIndex === 0, true, minChunkMs);
    }

    let record;
    try {
      const form = new FormData();
      form.append("session_id", store.sessionId);
      form.append("away_start_ms", String(Math.round(start_ms)));
      form.append("away_end_ms", String(Math.round(end_ms)));
      const response = await fetch(`${backendUrl}/window/${windowId}/finalize`, {
        method: "POST", body: form,
      });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      record = await response.json();
    } catch (err) {
      active = null;
      onStatus({ phase: "error", message: `recovery failed: ${err.message}` });
      return null;
    }
    active = null;

    const guarded = selectMissedWords(record.words ?? [], start_ms, end_ms, thresholdMs);
    const guardedText = buildRawText(guarded);
    if (guardedText !== record.raw_text) {
      console.warn("[silentspecs] client guard disagreed with the backend; using the guard");
      record.raw_text = guardedText;
      record.words = guarded;
      record.items = (record.items ?? []).filter(
        (item) => item.end_ms > start_ms && item.start_ms < end_ms
      );
    }

    if (!record.raw_text) {
      onStatus({ phase: "empty", start_ms, end_ms });
      return null;
    }

    const stored = store.addWindow(record);
    onStatus({
      phase: "done", record: stored,
      latencyMs: Math.round(performance.now() - t0),
    });
    return stored;
  }

  async function abandonWindow({ start_ms, end_ms }) {
    if (!active) return;
    stopFlushing();
    await flushInFlight;
    const windowId = active.id;
    active = null;
    try {
      const form = new FormData();
      form.append("session_id", store.sessionId);
      form.append("away_start_ms", String(Math.round(start_ms)));
      form.append("away_end_ms", String(Math.round(end_ms)));
      await fetch(`${backendUrl}/window/${windowId}/finalize`, { method: "POST", body: form });
    } catch { /* harmless */ }
  }

  function onGazeState(state, awayStartMs) {
    if (state === "CONFIRMED_AWAY" && awayStartMs !== null) beginWindow(awayStartMs);
  }

  function track(promise) {
    pending = promise.catch(() => null);
    return promise;
  }

  return {
    beginWindow,
    onGazeState,
    abandonWindow,
    recoverMissedWindow: (win) => track(recoverMissedWindow(win)),
    waitForWindow: () => pending,
    hasOpenWindow: () => active !== null,
    dispose() {
      stopFlushing();
      active = null;
    },
    async stop(nowMs = sessionNowMs()) {
      if (!active) return null;
      return recoverMissedWindow({ start_ms: active.startMs, end_ms: nowMs });
    },
  };
}
