/**
 * Debug harness wiring the pieces together.
 *
 * Intentionally plain: the real UI belongs to a teammate. What this needs to
 * prove is that the pipeline behaves -- what is captured, what is judged
 * missed, what the classifier tagged it, and how long it took.
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
// Server-side settings from /health, so chunking matches the backend exactly.
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

    // ordinary_context is collapsed from the compact card, never deleted.
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
    // Opens chunked flushing once an absence is confirmed (>= 2 s).
    onStateChange: (state, awayStartMs) => {
      setGazeState(state);
      recovery.onGazeState(state, awayStartMs);
    },
    onDiscarded: ({ duration_ms, ...win }) => {
      log(`glance of ${Math.round(duration_ms)} ms discarded (under 2 s)`);
      recovery.abandonWindow(win);
    },
  });
  // The gaze teammate's tracker replaces this by calling the same two methods.
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
  } catch { /* the backend may not be up yet; recovery will report it */ }

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
  // Finalize an open absence rather than discard it: stopping while away
  // must not lose what was missed.
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
