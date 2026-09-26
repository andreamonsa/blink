/**
 * The real `Blink.sources.transcript` for the teammate's web app.
 *
 * Their app.js only ever talks to `transcript.start(onLine)` / `stop()`. This
 * module is what sits behind that seam: tab audio, the gaze tracker, chunked
 * recovery, and Laya tags -- emitting ONLY missed lines.
 *
 * That is the deliberate difference from their mock, which streamed the whole
 * lecture. CLAUDE.md's invariant forbids attended speech from ever becoming
 * durable, so the transcript pane fills in retroactively, one missed window at
 * a time, when the student looks back.
 *
 * Their gaze client and ours are two separate sockets to gaze.py, so a
 * `panel` message can reach their createCatchup before our recovery exists.
 * `waitForWindow(from, to)` is keyed on gaze.py's `t` -- identical on both
 * sockets -- so the card waits for exactly its own window and gets back the
 * ids of the lines that belong to it.
 */

import { AudioCapture } from "./audio-capture.js";
import { createGazeController } from "./gaze-interface.js";
import { connectGaze, DEFAULT_GAZE_URL } from "./gaze-websocket.js";
import { createLiveTranscriber } from "./live.js";
import { selectMissedWords, buildRawText } from "./missed-selector.js";
import { createRecovery } from "./recovery.js";
import { MissedStore } from "./store.js";
import { newSessionId, sessionNowMs, sessionToEpochMs, startSession } from "./session.js";

/** How long a card waits for our side to even notice a return it heard about. */
const UNSEEN_RETURN_MS = 4000;

export function createSilentSpecsSource({
  backendUrl = "",
  gazeUrl = DEFAULT_GAZE_URL,
  leadMs = 0,
  // "tab" for an online lecture in another Chrome tab, "mic" for a lecture in
  // the room (or a virtual device such as BlackHole).
  audioSource = "tab",
  // Which microphone to open (a deviceId, or null for the default). A function
  // so a choice made after the page loaded is still honoured at Start.
  getMicDeviceId = () => null,
  // Show everything said in the lecture as it is said. Display-only: the words
  // stay in page memory, and only the words of a missed window go on to Laya
  // and the summarizer. false = the strict mode where attended speech is never
  // transcribed at all and lines appear only when the student looks back.
  live = true,
  onStatus = () => {},
  AudioCaptureImpl = AudioCapture,
  connectGazeImpl = connectGaze,
} = {}) {
  const capture = new AudioCaptureImpl({ bufferSeconds: 60 });
  const store = new MissedStore(newSessionId());
  const itemsByLineId = new Map();
  // gaze.py return timestamp (epoch ms) -> deferred resolving to Set<lineId> | null
  const waiters = new Map();

  let serverConfig = {};
  let onLine = null;
  let lineSeq = 0;
  let gaze = null;
  let gazeClient = null;
  let running = false;

  const recovery = createRecovery({
    capture,
    store,
    backendUrl,
    getConfig: () => ({
      chunkMs: serverConfig.chunk_ms,
      minChunkMs: serverConfig.min_chunk_ms,
      outerPadMs: serverConfig.clip_pad_ms,
      innerPadMs: serverConfig.chunk_pad_ms,
      thresholdMs: serverConfig.away_threshold_ms,
    }),
    onStatus,
  });

  // Away windows already resolved, in session ms. Together with the window
  // still open they decide which spoken lines count as missed.
  const missedWindows = [];
  function isMissed(startMs, endMs) {
    if (missedWindows.some((w) => endMs > w.start_ms && startMs < w.end_ms)) return true;
    // An absence that has been confirmed (>= 2 s) but not yet ended.
    if (gaze?.getState() === "CONFIRMED_AWAY") {
      const since = gaze.getAwayStartMs();
      if (since !== null && endMs > since) return true;
    }
    return false;
  }

  const liveCtl = live
    ? createLiveTranscriber({
        capture, backendUrl,
        onLine: (line) => onLine?.(line),
        onStatus,
        isMissed,
      })
    : null;

  /** Live mode: the words are already here, so record the window from them. */
  async function recoverLive({ start_ms, end_ms }) {
    onStatus({ phase: "recovering", start_ms, end_ms });
    // Transcribe up to the moment the student looked back, then close the
    // sentence in progress so the catch-up card can include it.
    await liveCtl.flushTo(end_ms);
    liveCtl.finalizePending();

    const missed = liveCtl.wordsBetween(start_ms, end_ms);
    if (!missed.length) { onStatus({ phase: "empty", start_ms, end_ms }); return null; }

    // Mark it on screen now, whatever the server does next.
    missedWindows.push({ start_ms, end_ms });
    liveCtl.markMissed(start_ms, end_ms);

    let record;
    try {
      const response = await fetch(`${backendUrl}/session/${store.sessionId}/window`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          away_start_ms: Math.round(start_ms),
          away_end_ms: Math.round(end_ms),
          words: missed,
        }),
      });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      record = await response.json();
    } catch (err) {
      onStatus({ phase: "error", message: `recovery failed: ${err.message}` });
      return null;
    }

    // Client-side guard, as on the chunked path.
    const guarded = selectMissedWords(record.words ?? [], start_ms, end_ms, 0);
    if (buildRawText(guarded) !== record.raw_text) {
      record.raw_text = buildRawText(guarded);
      record.words = guarded;
    }
    return record.raw_text ? store.addWindow(record) : null;
  }

  function waiterFor(t) {
    let w = waiters.get(t);
    if (!w) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      w = { promise, resolve, bound: false, timer: null };
      waiters.set(t, w);
      // If our socket never delivers this return (it dropped, or we started
      // later), release the card rather than leaving it spinning forever.
      w.timer = setTimeout(() => settle(t, null), UNSEEN_RETURN_MS);
      if (typeof w.timer?.unref === "function") w.timer.unref();
    }
    return w;
  }

  function settle(t, value) {
    const w = waiters.get(t);
    if (!w) return;
    clearTimeout(w.timer);
    waiters.delete(t);
    w.resolve(value);
  }

  /** Bind one gaze.py return to its recovery outcome. */
  function bindReturn(t, result) {
    const w = waiterFor(t);
    if (w.bound) return;
    w.bound = true;
    clearTimeout(w.timer);   // our side has it now; no fallback needed
    if (!result) {
      settle(t, null);        // sub-2 s glance: nothing was missed
      return;
    }
    Promise.resolve(result)
      .then((record) => settle(t, record ? emitRecord(record) : null))
      .catch(() => settle(t, null));
  }

  /**
   * Hand a recovered window to the web app, one line per Laya fragment.
   * Returns the ids so the matching card selects exactly these lines.
   */
  function emitRecord(record) {
    if (liveCtl) {
      // The lines are already in the transcript; the card just needs to know
      // which ones belong to this window, and summarising uses its range.
      const ids = liveCtl.lineIdsBetween(record.start_ms, record.end_ms);
      for (const id of ids) {
        itemsByLineId.set(id, { start_ms: record.start_ms, end_ms: record.end_ms });
      }
      return ids;
    }
    const ids = new Set();
    const items = (record.items?.length ? record.items : [{
      start_ms: record.start_ms, end_ms: record.end_ms, text: record.raw_text,
      kind: "unclassified", priority: 1,
    }]).slice().sort((a, b) => a.start_ms - b.start_ms);

    for (const item of items) {
      const id = `ss-${++lineSeq}`;
      ids.add(id);
      itemsByLineId.set(id, item);
      // The web app keys everything on wall-clock epoch ms.
      onLine?.({ id, t: sessionToEpochMs(item.start_ms), text: item.text, final: true });
    }
    return ids;
  }

  async function loadConfig() {
    try {
      serverConfig = await (await fetch(`${backendUrl}/health`)).json();
    } catch {
      onStatus({ phase: "error", message: "backend unreachable; is uvicorn running?" });
    }
  }

  return {
    store,
    capture,

    async start(callback) {
      if (running) return;
      running = true;
      onLine = callback;

      startSession();
      store.reset(newSessionId(), 0);
      await loadConfig();
      fetch(`${backendUrl}/session/${store.sessionId}/reset`, { method: "POST" }).catch(() => {});

      // Must stay inside the click that called start(): both capture APIs
      // need transient user activation.
      if (audioSource === "mic") await capture.startMicrophone({ deviceId: getMicDeviceId() });
      else await capture.startTabAudio();

      gaze = createGazeController({
        thresholdMs: serverConfig.away_threshold_ms ?? 2000,
        onMissedWindow: (win) => (liveCtl ? recoverLive(win) : recovery.recoverMissedWindow(win)),
        // The chunked-while-away path is only for the strict mode; the live
        // transcript already covers the whole lecture continuously.
        onStateChange: (state, awayStartMs) => { if (!liveCtl) recovery.onGazeState(state, awayStartMs); },
        onDiscarded: (win) => { if (!liveCtl) recovery.abandonWindow(win); },
      });
      gazeClient = connectGazeImpl({
        gaze,
        url: gazeUrl,
        leadMs,
        onStatus: (s) => {
          if (s.phase === "returned") bindReturn(s.at, s.result);
          onStatus(s);
        },
      });
      liveCtl?.start();
    },

    async stop() {
      if (!running) return;
      running = false;
      // Finalize rather than discard: stopping while away must not lose it.
      let record = null;
      if (liveCtl) {
        const awayStart = gaze?.getState() === "CONFIRMED_AWAY" ? gaze.getAwayStartMs() : null;
        if (awayStart !== null) record = await recoverLive({ start_ms: awayStart, end_ms: sessionNowMs() });
        liveCtl.stop();
      } else {
        record = await recovery.stop();
      }
      if (record) emitRecord(record);
      gazeClient?.close();
      gaze?.cancel();
      await capture.stop();
      for (const t of [...waiters.keys()]) settle(t, null);
    },

    /** Awaited by the patched createCatchup in web/app.js. */
    waitForWindow(from, to) {
      return waiterFor(to).promise;
    },

    /** Laya-tagged items behind a set of emitted line ids. */
    itemsFor(lineIds) {
      return lineIds.map((id) => itemsByLineId.get(id)).filter(Boolean);
    },

    /** Session-ms range covered by a set of emitted line ids. */
    rangeFor(lineIds) {
      const items = this.itemsFor(lineIds);
      if (!items.length) return null;
      return {
        from_ms: Math.min(...items.map((i) => i.start_ms)),
        to_ms: Math.max(...items.map((i) => i.end_ms)),
      };
    },

    /** For the on-page status badge: is audio actually arriving? */
    health() {
      return {
        ...capture.getHealth(),
        device: capture.deviceLabel,
        live: liveCtl ? liveCtl.stats : null,
        chunkMs: 4000,
      };
    },

    get sessionId() {
      return store.sessionId;
    },
  };
}
