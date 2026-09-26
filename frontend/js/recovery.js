/**
 * Turning a confirmed away window into durable missed text.
 *
 * While the student is still away, completed slices are flushed as they
 * accumulate, so an absence longer than the audio ring buffer is still
 * captured in full and the wait on return is bounded by the last partial
 * chunk rather than by the whole absence.
 *
 *   CONFIRMED_AWAY  -> beginWindow(): start flushing chunks
 *   ...             -> POST /window/{id}/chunk every CHUNK_MS
 *   return          -> flush the tail, POST /window/{id}/finalize
 *
 * The backend already applies the exact word filter. We re-apply it here on
 * whatever comes back: the invariant is the one thing in this product that
 * must not depend on a single implementation being right.
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
  let active = null;          // the away window currently being chunked
  let flushTimer = null;
  let flushInFlight = Promise.resolve();
  let pending = Promise.resolve(null);

  const cfg = () => ({ ...DEFAULTS, ...getConfig() });

  async function postChunk(chunkStartMs, chunkEndMs, isFirst, isLast, minClipMs = 0) {
    const { outerPadMs, innerPadMs } = cfg();
    // Interior edges may be padded generously: words there are assigned by
    // start time, so extra context cannot pull anything in. The outer edges
    // keep the small validated pad, where the overlap rule applies.
    let clipStart = chunkStartMs - (isFirst ? outerPadMs : innerPadMs);
    const clipEnd = chunkEndMs + (isLast ? outerPadMs : innerPadMs);
    // A short interior-start chunk still gets enough audio for Whisper. Only
    // the *clip* grows; chunk_start_ms (what words are assigned by) does not,
    // so nothing already assigned to the previous chunk is counted again.
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

  /** Flush any whole chunks whose audio has fully arrived. */
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

  /**
   * On return, send every remaining whole chunk -- but stop one short rather
   * than leave a sliver. This is the browser twin of plan_chunks() in
   * backend/window_buffer.py.
   *
   * It must not rely on the flush timer having run: our page is a background
   * tab while the student watches the lecture, and Chrome can throttle a
   * background setInterval to once a minute. Without this drain a long absence
   * would reach Whisper as one giant clip and chunking would silently not happen.
   */
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

  /** Called when the gaze controller confirms an absence (>= 2 s). */
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
    // Never keep a Node process alive (tests); a no-op in the browser.
    if (typeof flushTimer?.unref === "function") flushTimer.unref();
    onStatus({ phase: "window-open", start_ms: awayStartMs, window_id: active.id });
    return active.id;
  }

  function stopFlushing() {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  /** Called on gaze return. Flushes the tail and produces the record. */
  async function recoverMissedWindow({ start_ms, end_ms }) {
    const t0 = performance.now();
    const { minChunkMs, thresholdMs } = cfg();
    onStatus({ phase: "recovering", start_ms, end_ms });

    if (!active) beginWindow(start_ms);
    stopFlushing();
    // A timer flush may be mid-upload; let it finish so the same chunk is
    // never sent twice from two paths.
    await flushInFlight;
    const windowId = active.id;

    await drainTo(end_ms);

    // The remainder is one final chunk with disjoint bounds [cursor, end]. If
    // it is short because earlier chunks were already flushed mid-absence, only
    // its audio clip is widened -- see postChunk.
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

    // Client-side guard: independently re-filter whatever came back.
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

  /** A glance that turned out to be under threshold: drop the server buffer. */
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
      // The selector rejects a sub-threshold window and the buffer is popped,
      // so this both discards the audio words and frees the server memory.
      await fetch(`${backendUrl}/window/${windowId}/finalize`, { method: "POST", body: form });
    } catch { /* nothing durable was created; losing the cleanup is harmless */ }
  }

  /** Wire into a gaze controller's state changes. */
  function onGazeState(state, awayStartMs) {
    if (state === "CONFIRMED_AWAY" && awayStartMs !== null) beginWindow(awayStartMs);
  }

  /** Track the in-flight recovery so the UI can await it (see waitForWindow). */
  function track(promise) {
    pending = promise.catch(() => null);
    return promise;
  }

  return {
    beginWindow,
    onGazeState,
    abandonWindow,
    recoverMissedWindow: (win) => track(recoverMissedWindow(win)),
    /**
     * The web app creates its catch-up card synchronously on gaze return,
     * ~700 ms before our text exists. It awaits this first so the card finds
     * the lines instead of silently rendering empty.
     */
    waitForWindow: () => pending,
    hasOpenWindow: () => active !== null,
    /** Tear down without a network call (page unload, tests). */
    dispose() {
      stopFlushing();
      active = null;
    },
    /** Stop cleanly, finalizing rather than discarding an open window. */
    async stop(nowMs = sessionNowMs()) {
      if (!active) return null;
      return recoverMissedWindow({ start_ms: active.startMs, end_ms: nowMs });
    },
  };
}
