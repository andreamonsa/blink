/**
 * Live transcript: everything said in the lecture, as it is said.
 *
 * The lecture audio is transcribed continuously in short slices. Each slice's
 * audio is padded on both sides for context, but a word belongs to exactly one
 * slice, chosen by its start time, so slices tile with no duplicate and no gap
 * (the same rule as backend/window_buffer.py).
 *
 * Words are grouped into sentences and handed to the web app as lines
 * `{ id, t, text, final }`; a sentence still being spoken is sent as an interim
 * line and updated under the same id.
 *
 * Privacy: this transcript is display-only. It lives in this page's memory and
 * is never stored server-side. When the student looks away, only the words
 * overlapping that window are sent on for classification and summarising, and
 * the server applies the exact word filter again before anything is kept.
 */

import { sessionToEpochMs } from "./session.js";

const DEFAULTS = {
  chunkMs: 4_000,     // audio slice per request; the latency/accuracy trade-off
  padMs: 1_500,       // context either side of a slice (Whisper mangles slivers)
  gapMs: 1_200,       // a silence this long ends a sentence even without a "."
  maxWords: 40,       // never let one line grow without bound
  tickMs: 1_000,
};

const SENTENCE_END = /[.?!]["')\]]*$/;

export function createLiveTranscriber({
  capture,
  backendUrl = "",
  getConfig = () => ({}),
  onLine = () => {},
  onStatus = () => {},
}) {
  const cfg = () => ({ ...DEFAULTS, ...getConfig() });

  let cursor = null;          // session ms up to which words have been transcribed
  let timer = null;
  let queue = Promise.resolve();
  let lineSeq = 0;
  let pending = [];           // words of the sentence still being spoken
  let pendingId = null;

  const stats = { slices: 0, lastWords: 0, lastAt: null, errors: 0 };
  const words = [];           // every word so far, in time order (memory only)
  const lines = new Map();    // id -> { start_ms, end_ms }

  // ------------------------------------------------------------- line building

  function emit(final) {
    if (!pending.length) return;
    if (pendingId === null) pendingId = `live-${++lineSeq}`;
    const first = pending[0];
    const last = pending[pending.length - 1];
    lines.set(pendingId, { start_ms: first.start_ms, end_ms: last.end_ms });
    onLine({
      id: pendingId,
      t: sessionToEpochMs(first.start_ms),
      text: pending.map((w) => w.text).join(" "),
      final,
    });
    if (final) { pending = []; pendingId = null; }
  }

  function absorb(newWords) {
    const { gapMs, maxWords } = cfg();
    for (const word of newWords) {
      const prev = pending[pending.length - 1];
      // A long silence ends the sentence even if Whisper emitted no full stop.
      if (prev && word.start_ms - prev.end_ms > gapMs) emit(true);
      pending.push(word);
      words.push(word);
      if (SENTENCE_END.test(word.text) || pending.length >= maxWords) emit(true);
    }
    emit(false);   // whatever is left is a sentence in progress
  }

  // --------------------------------------------------------------- transcribing

  async function postSlice(startMs, endMs) {
    const { padMs } = cfg();
    const slice = capture.sliceToWav(startMs - padMs, endMs + padMs);
    if (!slice) return;

    const form = new FormData();
    form.append("audio", slice.blob, "live.wav");
    form.append("clip_start_ms", String(slice.clipStartMs));
    form.append("chunk_start_ms", String(Math.round(startMs)));
    form.append("chunk_end_ms", String(Math.round(endMs)));

    try {
      const response = await fetch(`${backendUrl}/live/chunk`, { method: "POST", body: form });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      const body = await response.json();
      const got = (body.words ?? []).sort((a, b) => a.start_ms - b.start_ms);
      stats.slices += 1; stats.lastWords = got.length; stats.lastAt = Date.now();
      absorb(got);
    } catch (err) {
      // A lost slice is a hole in the live view, not a reason to stop.
      stats.errors += 1;
      onStatus({ phase: "error", message: `live transcript: ${err.message}` });
    }
  }

  /** Serialise every transcription so slices are absorbed strictly in order. */
  function enqueue(task) {
    queue = queue.then(task, task);
    return queue;
  }

  function ensureCursor() {
    if (cursor === null) cursor = capture.oldestAvailableMs;
    return cursor !== null;
  }

  /** Transcribe every whole slice whose trailing context has arrived. */
  let ticking = false;
  function tick() {
    if (ticking) return queue;
    ticking = true;
    return enqueue(async () => {
      if (!ensureCursor()) return;
      const { chunkMs, padMs } = cfg();
      const newest = capture.newestAvailableMs;
      if (newest === null) return;
      // A page in a background tab may only get a tick a minute, so drain
      // every whole slice that is ready rather than one per tick.
      while (cursor + chunkMs + padMs <= newest) {
        const start = cursor;
        cursor = start + chunkMs;
        await postSlice(start, cursor);
      }
    }).finally(() => { ticking = false; });
  }

  /** Make sure every word starting before `endMs` has been transcribed. */
  function flushTo(endMs) {
    return enqueue(async () => {
      if (!ensureCursor()) return;
      const { chunkMs } = cfg();
      while (cursor < endMs) {
        const start = cursor;
        cursor = Math.min(start + chunkMs, endMs);
        await postSlice(start, cursor);
      }
    });
  }

  return {
    start() {
      clearInterval(timer);
      timer = setInterval(tick, cfg().tickMs);
      if (typeof timer?.unref === "function") timer.unref();

      // The student watches the lecture in another tab, so this page is a
      // background tab, where Chrome may run timers only once a minute and the
      // live text would arrive in bursts. Audio blocks keep arriving at full
      // rate, so let them drive the transcription too.
      let lastKick = 0;
      capture.onBlock = () => {
        const now = performance.now();
        if (now - lastKick < cfg().tickMs) return;
        lastKick = now;
        tick();
      };
    },

    /** Stop transcribing and forget the lecture. Nothing survives the session. */
    stop() {
      clearInterval(timer);
      timer = null;
      capture.onBlock = null;
      words.length = 0;
      lines.clear();
      pending = [];
      pendingId = null;
      cursor = null;
    },

    tick,
    flushTo,

    /** Close the sentence in progress, so a catch-up card can include it. */
    finalizePending() {
      emit(true);
    },

    /** Words overlapping [startMs, endMs], by the exact interval-overlap rule. */
    wordsBetween(startMs, endMs) {
      return words.filter((w) => w.end_ms > startMs && w.start_ms < endMs);
    },

    /** Ids of the live lines overlapping [startMs, endMs]. */
    lineIdsBetween(startMs, endMs) {
      const ids = new Set();
      for (const [id, range] of lines) {
        if (range.end_ms > startMs && range.start_ms < endMs) ids.add(id);
      }
      return ids;
    },

    get stats() {
      return { ...stats, words: words.length };
    },
    get wordCount() {
      return words.length;
    },
    get cursorMs() {
      return cursor;
    },
  };
}
