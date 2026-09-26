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
import { createRecovery } from "./recovery.js";
import { MissedStore } from "./store.js";
import { newSessionId, sessionToEpochMs, startSession } from "./session.js";

/** How long a card waits for our side to even notice a return it heard about. */
const UNSEEN_RETURN_MS = 4000;

export function createSilentSpecsSource({
  backendUrl = "",
  gazeUrl = DEFAULT_GAZE_URL,
  leadMs = 0,
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

      // Must stay inside the click that called start(): getDisplayMedia needs
      // transient user activation.
      await capture.startTabAudio();

      gaze = createGazeController({
        thresholdMs: serverConfig.away_threshold_ms ?? 2000,
        onMissedWindow: (win) => recovery.recoverMissedWindow(win),
        onStateChange: (state, awayStartMs) => recovery.onGazeState(state, awayStartMs),
        onDiscarded: (win) => recovery.abandonWindow(win),
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
    },

    async stop() {
      if (!running) return;
      running = false;
      // Finalize rather than discard: stopping while away must not lose it.
      const record = await recovery.stop();
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

    get sessionId() {
      return store.sessionId;
    },
  };
}
