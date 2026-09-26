#!/usr/bin/env bash
set -e
mkdir -p frontend/js
cd frontend/js

cat > silentspecs-source.js <<'__END__'
/**
 * The real `Blink.sources.transcript` for the teammate's web app.
 *
 * Their app.js only ever talks to `transcript.start(onLine)` / `stop()`. This
 * module is what sits behind that seam: tab audio, the gaze tracker, chunked
 * recovery, and Laya tags -- emitting ONLY missed lines.
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
  audioSource = "tab",
  onStatus = () => {},
  AudioCaptureImpl = AudioCapture,
  connectGazeImpl = connectGaze,
} = {}) {
  const capture = new AudioCaptureImpl({ bufferSeconds: 60 });
  const store = new MissedStore(newSessionId());
  const itemsByLineId = new Map();
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

  function bindReturn(t, result) {
    const w = waiterFor(t);
    if (w.bound) return;
    w.bound = true;
    clearTimeout(w.timer);
    if (!result) {
      settle(t, null);
      return;
    }
    Promise.resolve(result)
      .then((record) => settle(t, record ? emitRecord(record) : null))
      .catch(() => settle(t, null));
  }

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

      if (audioSource === "mic") await capture.startMicrophone();
      else await capture.startTabAudio();

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
      const record = await recovery.stop();
      if (record) emitRecord(record);
      gazeClient?.close();
      gaze?.cancel();
      await capture.stop();
      for (const t of [...waiters.keys()]) settle(t, null);
    },

    waitForWindow(from, to) {
      return waiterFor(to).promise;
    },

    itemsFor(lineIds) {
      return lineIds.map((id) => itemsByLineId.get(id)).filter(Boolean);
    },

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
__END__

cat > app.js <<'__END__'
/**
 * Debug harness wiring the pieces together (the /debug page).
 */

import { AudioCapture } from "./audio-capture.js";
import { createGazeController } from "./gaze-interface.js";
import { attachKeyboardGaze, playGazeTimeline, FLICKER_TIMELINE } from "./gaze-stub.js";
import { sortForCard } from "./missed-selector.js";
import { createRecovery } from "./recovery.js";
import { newSessionId, startSession, sessionNowMs } from "./session.js";
import { MissedStore } from "./store.js";

const KIND_LABEL = {
  question_to_you: "Question to you",
  instruction_change: "Instruction / change",
  decision_reason: "Decision + reason",
  ordinary_context: "Ordinary context",
  unclassified: "Unclassified",
};

const $ = (id) => document.getElementById(id);
const capture = new AudioCapture({ bufferSeconds: 30 });
const store = new MissedStore(newSessionId());
let gaze = null;
let serverConfig = {};
let stopTimeline = null;
const latencies = [];

function log(message) {
  const line = document.createElement("div");
  line.textContent = `[${(sessionNowMs() / 1000).toFixed(1)}s] ${message}`;
  $("log").prepend(line);
}

function setGazeState(state) {
  $("gazeState").textContent = state;
  $("gazeState").className = `state ${state}`;
}

async function refreshHealth() {
  try {
    const health = await (await fetch("/health")).json();
    $("health").textContent =
      `whisper ${health.whisper.model} (${health.whisper.device}/${health.whisper.compute_type})` +
      ` | laya ${health.laya.enabled ? (health.laya.loaded ? "loaded on " + health.laya.device : "not loaded") : "disabled"}` +
      ` | threshold ${health.away_threshold_ms} ms | pad ${health.clip_pad_ms} ms`;
    serverConfig = health;
    return health;
  } catch {
    $("health").textContent = "backend unreachable";
    return null;
  }
}

function renderSession() {
  const session = store.getSessionMissed();
  $("windowCount").textContent = session.windows.length;
  $("sentenceCount").textContent = session.sentences.length;

  const cards = $("cards");
  cards.innerHTML = "";

  for (const window of [...session.windows].reverse()) {
    const card = document.createElement("article");
    card.className = "card";

    const span = `${(window.start_ms / 1000).toFixed(1)}s - ${(window.end_ms / 1000).toFixed(1)}s`;
    const head = document.createElement("header");
    head.innerHTML = `<strong>Missed ${span}</strong>
      <span class="muted">${((window.end_ms - window.start_ms) / 1000).toFixed(1)}s away${
        window.classifier_ok === false ? " &middot; classifier unavailable" : ""
      }</span>`;
    card.append(head);

    const shown = sortForCard(window.items ?? []);
    for (const item of shown) {
      const row = document.createElement("div");
      row.className = `item kind-${item.kind}` + (item.show_by_default ? "" : " collapsed");
      const conf = item.confidence != null ? ` ${(item.confidence * 100).toFixed(0)}%` : "";
      row.innerHTML = `<span class="tag">${KIND_LABEL[item.kind] ?? item.kind}${conf}</span>
        <span class="text"></span>`;
      row.querySelector(".text").textContent = item.text;
      card.append(row);
    }

    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Show everything I missed";
    const pre = document.createElement("pre");
    pre.textContent = window.raw_text;
    details.append(summary, pre);
    card.append(details);

    cards.append(card);
  }

  $("summarizerPayload").textContent = JSON.stringify(
    { session_id: session.session_id, sentences: session.sentences },
    null,
    2
  );
}

const recovery = createRecovery({
  capture,
  store,
  getConfig: () => ({
    chunkMs: serverConfig.chunk_ms,
    minChunkMs: serverConfig.min_chunk_ms,
    outerPadMs: serverConfig.clip_pad_ms,
    innerPadMs: serverConfig.chunk_pad_ms,
    thresholdMs: serverConfig.away_threshold_ms,
  }),
  onStatus(status) {
    if (status.phase === "recovering") {
      log(`recovering ${(status.start_ms / 1000).toFixed(1)}s - ${(status.end_ms / 1000).toFixed(1)}s`);
    } else if (status.phase === "done") {
      latencies.push(status.latencyMs);
      const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
      $("latency").textContent = `last ${status.latencyMs} ms, avg ${avg} ms over ${latencies.length}`;
      log(`recovered ${status.record.items.length} item(s) in ${status.latencyMs} ms`);
      renderSession();
    } else if (status.phase === "empty") {
      log("no speech in that window; nothing stored");
    } else if (status.phase === "error") {
      log(`ERROR: ${status.message}`);
    }
  },
});

function buildGaze() {
  gaze = createGazeController({
    thresholdMs: 2000,
    onMissedWindow: (win) => recovery.recoverMissedWindow(win),
    onStateChange: (state, awayStartMs) => {
      setGazeState(state);
      recovery.onGazeState(state, awayStartMs);
    },
    onDiscarded: ({ duration_ms, ...win }) => {
      log(`glance of ${Math.round(duration_ms)} ms discarded (under 2 s)`);
      recovery.abandonWindow(win);
    },
  });
  window.silentSpecsGaze = gaze;
  attachKeyboardGaze(gaze);
}

let healthTimer = null;

function renderCaptureHealth() {
  const h = capture.getHealth();
  const el = $("capture");
  if (!h.running) { el.textContent = "not capturing"; el.className = ""; return; }
  if (!h.receiving) { el.textContent = "waiting for first audio block..."; el.className = "warn"; return; }

  const coverage = (h.coverage * 100).toFixed(1);
  const bar = "\u2588".repeat(Math.round(Math.min(1, h.lastLevel * 6) * 18)).padEnd(18, "\u00b7");

  let verdict = "ok", note = "";
  if (h.silentFraction > 0.995) {
    verdict = "bad";
    note = " \u2014 SILENT: no audio on the track. Re-share and tick \"Also share tab audio\".";
  } else if (!h.audible) {
    verdict = "warn";
    note = " \u2014 almost silent; is the lecture actually playing?";
  } else if (h.coverage < 0.98) {
    verdict = "warn";
    note = ` \u2014 dropping audio, timestamps drifting by ${h.driftMs} ms`;
  }

  el.className = verdict;
  el.textContent =
    `${bar}  coverage ${coverage}% \u00b7 drift ${h.driftMs} ms \u00b7 ` +
    `buffered ${(h.bufferedMs / 1000).toFixed(0)}s \u00b7 ${h.sampleRate} Hz \u00b7 ` +
    `${h.contextState}${note}`;
}

async function start(kind) {
  startSession();
  store.reset(newSessionId(), 0);
  latencies.length = 0;
  try {
    await fetch(`/session/${store.sessionId}/reset`, { method: "POST" });
  } catch { /* backend may not be up yet */ }

  try {
    const info =
      kind === "tab" ? await capture.startTabAudio()
      : kind === "mic" ? await capture.startMicrophone()
      : await capture.startFile($("file").files[0]);
    $("source").textContent = `${info.label} @ ${info.sampleRate} Hz`;
    log(`capturing ${info.label}`);
  } catch (err) {
    log(`ERROR: ${err.message}`);
    return;
  }

  buildGaze();
  setGazeState("LOOKING");
  clearInterval(healthTimer);
  healthTimer = setInterval(renderCaptureHealth, 250);
  $("stopBtn").disabled = false;
  ["tabBtn", "micBtn", "fileBtn"].forEach((id) => ($(id).disabled = true));
  renderSession();
}

async function stop() {
  clearInterval(healthTimer);
  healthTimer = null;
  const final = capture.getHealth();
  if (final.receiving) {
    log(`capture summary: coverage ${(final.coverage * 100).toFixed(1)}%, ` +
        `drift ${final.driftMs} ms, peak level ${final.peakLevel.toFixed(3)}, ` +
        `silent ${(final.silentFraction * 100).toFixed(1)}% of blocks`);
  }
  stopTimeline?.();
  if (recovery.hasOpenWindow()) {
    log("finalizing the absence that was still open");
    await recovery.stop();
  }
  gaze?.cancel();
  await capture.stop();
  $("source").textContent = "stopped";
  $("capture").textContent = "not capturing";
  $("capture").className = "";
  $("stopBtn").disabled = true;
  ["tabBtn", "micBtn", "fileBtn"].forEach((id) => ($(id).disabled = false));
  log("session stopped; ephemeral audio buffer cleared");
}

$("tabBtn").onclick = () => start("tab");
$("micBtn").onclick = () => start("mic");
$("fileBtn").onclick = () => {
  if (!$("file").files[0]) return log("choose a file first");
  start("file");
};
$("stopBtn").onclick = stop;
$("flickerBtn").onclick = () => {
  if (!gaze) return log("start a session first");
  log("running flicker timeline: 10 glances of 0.5-1.5 s, expect zero cards");
  stopTimeline = playGazeTimeline(gaze, FLICKER_TIMELINE);
};
$("warmupBtn").onclick = async () => {
  $("warmupBtn").disabled = true;
  log("warming models...");
  try {
    const result = await (await fetch("/warmup", { method: "POST" })).json();
    log(`warm: whisper ${result.whisper_warmup_s?.toFixed(2)}s, laya ${result.laya_warmup_s?.toFixed(2) ?? "n/a"}s`);
  } catch (err) {
    log(`ERROR: ${err.message}`);
  }
  $("warmupBtn").disabled = false;
  refreshHealth();
};
$("copyBtn").onclick = async () => {
  await navigator.clipboard.writeText($("summarizerPayload").textContent);
  log("summarizer payload copied");
};

refreshHealth();
renderSession();
log("ready. Warm the models, start a source, then hold SPACE to look away.");
__END__

cat > audio-capture.js <<'__END__'
/**
 * Lecture audio capture into a short ephemeral ring buffer.
 */

import { sessionNowMs } from "./session.js";

const DEFAULT_BUFFER_SECONDS = 60;

export class AudioCapture {
  constructor({ bufferSeconds = DEFAULT_BUFFER_SECONDS } = {}) {
    this.bufferSeconds = bufferSeconds;
    this.context = null;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.ring = null;
    this.ringSize = 0;
    this.writeIndex = 0;
    this.totalSamples = 0;
    this.epochMs = null;
    this.sampleRate = 0;
    this.sourceLabel = "none";
    this.onLevel = null;

    this.startedAtMs = null;
    this.peakLevel = 0;
    this.lastLevel = 0;
    this.silentBlocks = 0;
    this.totalBlocks = 0;
  }

  get isRunning() {
    return this.context !== null && this.context.state !== "closed";
  }

  async startTabAudio() {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(
        'No audio track. Pick a "Chrome Tab" and tick "Also share tab audio".'
      );
    }
    return this._attachStream(stream, "tab audio");
  }

  async startMicrophone() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    return this._attachStream(stream, "microphone");
  }

  async startFile(file) {
    const context = new AudioContext();
    await this._setupGraph(context, "file: " + file.name);
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.node);
    source.connect(context.destination);
    source.start();
    this.source = source;
    return { sampleRate: this.sampleRate, label: this.sourceLabel };
  }

  async _attachStream(stream, label) {
    this.stream = stream;
    const context = new AudioContext();
    await this._setupGraph(context, label);
    const source = context.createMediaStreamSource(stream);
    source.connect(this.node);
    this.source = source;

    stream.getTracks().forEach((track) => {
      track.addEventListener("ended", () => this.stop());
    });

    return { sampleRate: this.sampleRate, label };
  }

  async _setupGraph(context, label) {
    await context.audioWorklet.addModule(
      new URL("./pcm-recorder.worklet.js", import.meta.url)
    );
    this.context = context;
    this.sampleRate = context.sampleRate;
    this.sourceLabel = label;
    this.ringSize = Math.ceil(this.sampleRate * this.bufferSeconds);
    this.ring = new Float32Array(this.ringSize);
    this.writeIndex = 0;
    this.totalSamples = 0;
    this.epochMs = null;
    this.startedAtMs = sessionNowMs();
    this.peakLevel = 0;
    this.lastLevel = 0;
    this.silentBlocks = 0;
    this.totalBlocks = 0;

    const node = new AudioWorkletNode(context, "pcm-recorder", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
    });
    node.port.onmessage = (event) => this._write(event.data);
    this.node = node;
  }

  _write(block) {
    if (this.epochMs === null) {
      this.epochMs = sessionNowMs() - (block.length / this.sampleRate) * 1000;
    }

    for (let i = 0; i < block.length; i++) {
      this.ring[this.writeIndex] = block[i];
      this.writeIndex = (this.writeIndex + 1) % this.ringSize;
    }
    this.totalSamples += block.length;

    let peak = 0;
    for (let i = 0; i < block.length; i++) {
      const v = Math.abs(block[i]);
      if (v > peak) peak = v;
    }
    this.totalBlocks += 1;
    if (peak === 0) this.silentBlocks += 1;
    this.lastLevel = peak;
    if (peak > this.peakLevel) this.peakLevel = peak;
    if (this.onLevel) this.onLevel(peak);
  }

  getHealth() {
    if (this.epochMs === null || this.startedAtMs === null) {
      return { running: this.isRunning, receiving: false };
    }
    const elapsedMs = sessionNowMs() - this.startedAtMs;
    const capturedMs = (this.totalSamples / this.sampleRate) * 1000;
    const driftMs = capturedMs - elapsedMs;

    return {
      running: this.isRunning,
      receiving: this.totalBlocks > 0,
      contextState: this.context ? this.context.state : "closed",
      sampleRate: this.sampleRate,
      elapsedMs: Math.round(elapsedMs),
      capturedMs: Math.round(capturedMs),
      coverage: elapsedMs > 0 ? capturedMs / elapsedMs : 1,
      driftMs: Math.round(driftMs),
      bufferedMs: Math.round(
        Math.min(this.totalSamples, this.ringSize) / this.sampleRate * 1000
      ),
      peakLevel: this.peakLevel,
      lastLevel: this.lastLevel,
      silentFraction: this.totalBlocks ? this.silentBlocks / this.totalBlocks : 1,
      audible: this.peakLevel > 0.0005,
    };
  }

  get oldestAvailableMs() {
    if (this.epochMs === null) return null;
    const dropped = Math.max(0, this.totalSamples - this.ringSize);
    return this.epochMs + (dropped / this.sampleRate) * 1000;
  }

  get newestAvailableMs() {
    if (this.epochMs === null) return null;
    return this.epochMs + (this.totalSamples / this.sampleRate) * 1000;
  }

  sliceToWav(startMs, endMs) {
    if (this.epochMs === null || this.totalSamples === 0) return null;

    const toSample = (ms) => Math.round(((ms - this.epochMs) / 1000) * this.sampleRate);
    const firstAvailable = Math.max(0, this.totalSamples - this.ringSize);

    let from = Math.max(firstAvailable, toSample(startMs));
    const to = Math.min(this.totalSamples, toSample(endMs));
    if (to <= from) return null;

    const length = to - from;
    const pcm = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      pcm[i] = this.ring[(from + i) % this.ringSize];
    }

    return {
      blob: encodeWav(pcm, this.sampleRate),
      clipStartMs: Math.round(this.epochMs + (from / this.sampleRate) * 1000),
      clipEndMs: Math.round(this.epochMs + (to / this.sampleRate) * 1000),
      durationMs: Math.round((length / this.sampleRate) * 1000),
      truncated: from > toSample(startMs),
    };
  }

  clearBuffer() {
    if (this.ring) this.ring.fill(0);
    this.writeIndex = 0;
    this.totalSamples = 0;
    this.epochMs = null;
    this.startedAtMs = null;
    this.peakLevel = 0;
    this.lastLevel = 0;
    this.silentBlocks = 0;
    this.totalBlocks = 0;
  }

  async stop() {
    try {
      if (this.source && this.source.stop) this.source.stop();
    } catch { /* may already have ended */ }
    if (this.node) this.node.port.onmessage = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.context && this.context.state !== "closed") await this.context.close();
    this.clearBuffer();
    this.context = null;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.sourceLabel = "none";
  }
}

export function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}
__END__

cat > gaze-interface.js <<'__END__'
/**
 * The integration contract for the gaze team: the 2-second rule state machine.
 */

export const LOOKING = "LOOKING";
export const POTENTIAL_AWAY = "POTENTIAL_AWAY";
export const CONFIRMED_AWAY = "CONFIRMED_AWAY";

export function createGazeController({
  thresholdMs = 2000,
  onMissedWindow = async () => {},
  onStateChange = () => {},
  onDiscarded = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  let state = LOOKING;
  let awayStartMs = null;
  let timer = null;

  function setState(next) {
    if (state === next) return;
    state = next;
    onStateChange(state, awayStartMs);
  }

  function clearTimer() {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  return {
    awayStart(nowMs) {
      if (state !== LOOKING) return state;

      awayStartMs = nowMs;
      setState(POTENTIAL_AWAY);

      clearTimer();
      timer = setTimeoutFn(() => {
        timer = null;
        if (state === POTENTIAL_AWAY) setState(CONFIRMED_AWAY);
      }, thresholdMs);

      return state;
    },

    async returned(nowMs) {
      if (state === LOOKING) return null;

      clearTimer();
      const start = awayStartMs;
      const durationMs = nowMs - start;

      if (durationMs < thresholdMs) {
        awayStartMs = null;
        setState(LOOKING);
        onDiscarded({ start_ms: start, end_ms: nowMs, duration_ms: durationMs });
        return null;
      }

      const window = { start_ms: start, end_ms: nowMs };
      awayStartMs = null;
      setState(LOOKING);
      return onMissedWindow(window);
    },

    cancel() {
      clearTimer();
      awayStartMs = null;
      setState(LOOKING);
    },

    getState: () => state,
    getAwayStartMs: () => awayStartMs,
    thresholdMs,
  };
}
__END__

cat > gaze-stub.js <<'__END__'
/**
 * Stand-in gaze driver for testing (hold Space = away).
 */

import { sessionNowMs } from "./session.js";

export function attachKeyboardGaze(gaze, { key = " " } = {}) {
  let down = false;

  const onKeyDown = (event) => {
    if (event.key !== key || event.repeat || down) return;
    event.preventDefault();
    down = true;
    gaze.awayStart(sessionNowMs());
  };

  const onKeyUp = (event) => {
    if (event.key !== key || !down) return;
    event.preventDefault();
    down = false;
    gaze.returned(sessionNowMs());
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  };
}

export function playGazeTimeline(gaze, events, { onEvent = () => {} } = {}) {
  const timers = [];
  for (const event of events) {
    const delay = Math.max(0, event.awayAtMs - sessionNowMs());
    timers.push(
      setTimeout(() => {
        gaze.awayStart(sessionNowMs());
        onEvent({ type: "away", ...event });
        timers.push(
          setTimeout(() => {
            gaze.returned(sessionNowMs());
            onEvent({ type: "return", ...event });
          }, event.durationMs)
        );
      }, delay)
    );
  }
  return () => timers.forEach(clearTimeout);
}

export const FLICKER_TIMELINE = Array.from({ length: 10 }, (_, i) => ({
  awayAtMs: 2000 + i * 2500,
  durationMs: 500 + (i % 3) * 500,
}));
__END__

cat > gaze-websocket.js <<'__END__'
/**
 * Client for the teammate's eye tracker (`python gaze.py run --no-preview`).
 */

import { epochToSessionMs } from "./session.js";

export const DEFAULT_GAZE_URL = "ws://localhost:8765";

const ZONE_LOOKING = "panel";
const ZONE_AWAY = "away";

export function connectGaze({
  gaze,
  url = DEFAULT_GAZE_URL,
  leadMs = 0,
  reconnectMs = 2000,
  onStatus = () => {},
  WebSocketImpl = typeof WebSocket !== "undefined" ? WebSocket : null,
} = {}) {
  if (!WebSocketImpl) throw new Error("no WebSocket implementation available");

  let socket = null;
  let closed = false;
  let firstMessage = true;
  let reconnectTimer = null;

  const toSession = (epochMs) => epochToSessionMs(epochMs) - leadMs;

  function handle(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!msg || msg.type !== "zone") return null;

    const isSnapshot = firstMessage;
    firstMessage = false;

    if (isSnapshot) {
      onStatus({ phase: "snapshot", zone: msg.zone });
      return null;
    }

    if (msg.zone === ZONE_AWAY) {
      gaze.awayStart(toSession(msg.t));
      onStatus({ phase: "away", at: msg.t });
      return "away";
    }

    if (msg.zone === ZONE_LOOKING) {
      if (gaze.getState() === "LOOKING" && typeof msg.since === "number") {
        gaze.awayStart(toSession(msg.since));
      }
      const result = gaze.returned(toSession(msg.t));
      onStatus({ phase: "returned", at: msg.t, since: msg.since, result });
      return result;
    }

    return null;
  }

  function open() {
    if (closed) return;
    onStatus({ phase: "connecting", url });
    firstMessage = true;

    socket = new WebSocketImpl(url);

    socket.onopen = () => {
      firstMessage = true;
      onStatus({ phase: "connected", url });
    };
    socket.onmessage = (event) => handle(event.data);
    socket.onerror = () => onStatus({ phase: "error", url });
    socket.onclose = () => {
      onStatus({ phase: "offline", url });
      gaze.cancel();
      if (!closed) {
        reconnectTimer = setTimeout(open, reconnectMs);
        if (typeof reconnectTimer?.unref === "function") reconnectTimer.unref();
      }
    };
  }

  open();

  return {
    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      if (socket) socket.close();
    },
    _handle: handle,
    get isFirstMessage() {
      return firstMessage;
    },
  };
}
__END__

cat > missed-selector.js <<'__END__'
/**
 * Client-side mirror of backend/missed_selector.py.
 */

export const DEFAULT_THRESHOLD_MS = 2000;

const SENTENCE_END = [".", "?", "!"];
const HAS_ALNUM = /[\p{L}\p{N}]/u;

export class InvalidAwayInterval extends Error {}

export function selectMissedWords(words, awayStartMs, awayEndMs, thresholdMs = DEFAULT_THRESHOLD_MS) {
  if (awayEndMs < awayStartMs) {
    throw new InvalidAwayInterval(
      `away_end_ms (${awayEndMs}) precedes away_start_ms (${awayStartMs})`
    );
  }
  if (awayEndMs - awayStartMs < thresholdMs) return [];

  return (words ?? []).filter(
    (word) => word.end_ms > awayStartMs && word.start_ms < awayEndMs
  );
}

export function isValidAwayWindow(awayStartMs, awayEndMs, thresholdMs = DEFAULT_THRESHOLD_MS) {
  return awayEndMs >= awayStartMs && awayEndMs - awayStartMs >= thresholdMs;
}

export function buildRawText(words) {
  return (words ?? [])
    .map((w) => (w.text ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

export function dedupeWords(words) {
  const seen = new Set();
  return [...(words ?? [])]
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms)
    .filter((w) => {
      const key = `${w.start_ms}|${w.end_ms}|${(w.text ?? "").trim()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function fragmentMissedText(words, maxWordsPerFragment = null) {
  const fragments = [];
  let current = [];

  const flush = () => {
    if (current.length === 0) return;
    const text = buildRawText(current);
    if (HAS_ALNUM.test(text)) {
      fragments.push({
        start_ms: current[0].start_ms,
        end_ms: current[current.length - 1].end_ms,
        text,
      });
    }
    current = [];
  };

  for (const word of words ?? []) {
    const stripped = (word.text ?? "").trim();
    if (!stripped) continue;
    current.push(word);
    const endsSentence = SENTENCE_END.some((p) => stripped.endsWith(p));
    const tooLong = maxWordsPerFragment !== null && current.length >= maxWordsPerFragment;
    if (endsSentence || tooLong) flush();
  }
  flush();
  return fragments;
}

export function sortForCard(items) {
  return [...(items ?? [])].sort(
    (a, b) => (b.priority ?? 1) - (a.priority ?? 1) || a.start_ms - b.start_ms
  );
}
__END__

cat > pcm-recorder.worklet.js <<'__END__'
/**
 * Forwards raw mono PCM to the main thread in fixed blocks.
 */
class PCMRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel = input[0];
    if (!channel) return true;

    this.port.postMessage(new Float32Array(channel), []);
    return true;
  }
}

registerProcessor("pcm-recorder", PCMRecorder);
__END__

cat > recovery.js <<'__END__'
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
__END__

cat > session.js <<'__END__'
/**
 * The session clock (performance.now) and the bridge to epoch ms.
 */

let sessionOrigin = null;
let sessionEpochOrigin = null;
let driftTimer = null;
let onDrift = null;

export const DRIFT_WARN_MS = 250;

export function startSession({ onClockDrift = null } = {}) {
  sessionOrigin = performance.now();
  sessionEpochOrigin = Date.now();
  onDrift = onClockDrift;
  startDriftWatchdog();
  return sessionOrigin;
}

export function sessionNowMs() {
  if (sessionOrigin === null) startSession();
  return performance.now() - sessionOrigin;
}

export function epochToSessionMs(epochMs) {
  if (sessionOrigin === null) startSession();
  return sessionNowMs() - (Date.now() - epochMs);
}

export function sessionToEpochMs(sessionMs) {
  if (sessionOrigin === null) startSession();
  return Math.round(Date.now() - (sessionNowMs() - sessionMs));
}

export function getSessionEpochOrigin() {
  return sessionEpochOrigin;
}

export function clockDriftMs() {
  if (sessionEpochOrigin === null) return 0;
  return Date.now() - (sessionEpochOrigin + sessionNowMs());
}

function startDriftWatchdog(intervalMs = 5000) {
  stopDriftWatchdog();
  driftTimer = setInterval(() => {
    const drift = clockDriftMs();
    if (Math.abs(drift) > DRIFT_WARN_MS) {
      console.warn(
        `[silentspecs] wall clock moved ${Math.round(drift)} ms relative to the ` +
        `monotonic clock; gaze windows may be misaligned`
      );
      if (onDrift) onDrift(drift);
    }
  }, intervalMs);
  if (typeof driftTimer?.unref === "function") driftTimer.unref();
}

export function stopDriftWatchdog() {
  if (driftTimer !== null) {
    clearInterval(driftTimer);
    driftTimer = null;
  }
}

export function isSessionStarted() {
  return sessionOrigin !== null;
}

export function resetSession() {
  stopDriftWatchdog();
  sessionOrigin = null;
  sessionEpochOrigin = null;
  onDrift = null;
}

export function newSessionId() {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
__END__

cat > store.js <<'__END__'
/**
 * Session-wide missed transcript (memory only).
 */

import { buildRawText, dedupeWords } from "./missed-selector.js";

export class MissedStore {
  constructor(sessionId = "default") {
    this.sessionId = sessionId;
    this.startedAtMs = 0;
    this.windows = [];
    this._listeners = new Set();
  }

  onMissedWindow(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  addWindow(record) {
    if (!record || !record.raw_text) return null;

    const overlapping = this.windows.filter(
      (w) => record.start_ms <= w.end_ms && w.start_ms <= record.end_ms
    );
    let merged = record;
    if (overlapping.length > 0) {
      this.windows = this.windows.filter((w) => !overlapping.includes(w));
      merged = mergeWindows([...overlapping, record]);
    }

    this.windows.push(merged);
    this.windows.sort((a, b) => a.start_ms - b.start_ms);

    for (const listener of this._listeners) {
      try {
        listener(merged, this.getSessionMissed());
      } catch (err) {
        console.warn("missed-window listener threw:", err);
      }
    }
    return merged;
  }

  getSessionMissed() {
    const sentences = this.windows
      .flatMap((w) => w.items ?? [])
      .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);

    return {
      session_id: this.sessionId,
      started_at_ms: this.startedAtMs,
      windows: this.windows,
      sentences,
      raw_text: this.windows.map((w) => w.raw_text).filter(Boolean).join("\n"),
    };
  }

  get windowCount() {
    return this.windows.length;
  }

  reset(sessionId = this.sessionId, startedAtMs = 0) {
    this.sessionId = sessionId;
    this.startedAtMs = startedAtMs;
    this.windows = [];
  }
}

export function mergeWindows(windows) {
  const sorted = [...windows].sort((a, b) => a.start_ms - b.start_ms);
  const words = dedupeWords(sorted.flatMap((w) => w.words ?? []));

  const seen = new Set();
  const items = sorted
    .flatMap((w) => w.items ?? [])
    .filter((item) => {
      const key = `${item.start_ms}|${item.end_ms}|${item.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);

  return {
    start_ms: Math.min(...sorted.map((w) => w.start_ms)),
    end_ms: Math.max(...sorted.map((w) => w.end_ms)),
    raw_text: words.length
      ? buildRawText(words)
      : sorted.map((w) => w.raw_text).filter(Boolean).join(" "),
    items,
    words,
    classifier_ok: sorted.every((w) => w.classifier_ok !== false),
  };
}
__END__

echo "created:"
ls -1
