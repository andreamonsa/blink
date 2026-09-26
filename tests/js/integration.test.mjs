/**
 * End to end, without a webcam or Ollama:
 *
 *   synthetic lecture (as the "tab audio")
 *   + recorded gaze.py frames (as the eye tracker)
 *   -> our real source, recovery, chunking and client guard
 *   -> the real backend: faster-whisper + selector + Laya
 *   -> the web app's patched createCatchup filter
 *   -> the summarizer bridge
 *
 * Only the audio device and the WebSocket are simulated. Needs the backend:
 *   .venv/bin/python -m uvicorn backend.app:app --port 8000
 * and skips itself if it is not running.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createSilentSpecsSource } from "../../frontend/js/silentspecs-source.js";
import { connectGaze } from "../../frontend/js/gaze-websocket.js";
import { encodeWav } from "../../frontend/js/audio-capture.js";
import { sessionToEpochMs } from "../../frontend/js/session.js";

const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";
const ROOT = new URL("../../", import.meta.url);

async function backendUp() {
  try { return (await fetch(`${BACKEND}/health`)).ok; } catch { return false; }
}

/** Plays a WAV file as if it were captured tab audio on the session timeline. */
function fileCapture(wavPath) {
  const buf = readFileSync(wavPath);
  const rate = buf.readUInt32LE(24);
  const dataStart = 44;
  const samples = (buf.length - dataStart) / 2;
  const durationMs = (samples / rate) * 1000;

  return class FileCapture {
    constructor() { this.newestAvailableMs = durationMs; }
    async startTabAudio() { return { sampleRate: rate, label: "file" }; }
    async stop() {}
    sliceToWav(startMs, endMs) {
      const a = Math.max(0, Math.round((startMs / 1000) * rate));
      const b = Math.min(samples, Math.round((endMs / 1000) * rate));
      if (b <= a) return null;
      const pcm = new Float32Array(b - a);
      for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(dataStart + (a + i) * 2) / 32768;
      return {
        blob: encodeWav(pcm, rate),
        clipStartMs: Math.round((a / rate) * 1000),
        clipEndMs: Math.round((b / rate) * 1000),
        durationMs: Math.round(((b - a) / rate) * 1000),
        truncated: a > Math.round((startMs / 1000) * rate),
      };
    }
  };
}

/** Starts the source with a controllable gaze socket. */
async function startPipeline(fixture) {
  const manifest = JSON.parse(readFileSync(new URL(`synthetic/${fixture}`, ROOT)));
  const lines = new Map();          // the web app's state.lines
  let socket = null;

  class FakeSocket {
    constructor() { socket = this; queueMicrotask(() => this.onopen?.()); }
    close() { this.onclose?.(); }
    send(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  }

  const source = createSilentSpecsSource({
    backendUrl: BACKEND,
    AudioCaptureImpl: fileCapture(new URL(manifest.audio, ROOT).pathname),
    connectGazeImpl: (opts) => connectGaze({ ...opts, WebSocketImpl: FakeSocket }),
  });
  // Exactly what web/app.js's onLine does with a line: store it by id.
  await source.start((line) => lines.set(line.id, { ...line, tEnd: Date.now() }));
  await new Promise((r) => setTimeout(r, 0));   // let the socket "open"
  socket.send({ type: "zone", zone: "panel", t: Date.now(), since: Date.now() }); // hello
  return { source, manifest, lines, gazeSocket: () => socket };
}

/** web/app.js createCatchup, as patched: wait for our window, select by id. */
async function createCatchup(source, lines, from, to) {
  const own = await source.waitForWindow(from, to);
  const picked = [...lines.values()].filter((l) =>
    l.final && (own ? own.has(l.id) : l.tEnd >= from && l.t <= to));
  if (!picked.length) return null;
  // web/sources.js realSummarizer
  const range = source.rangeFor(picked.map((l) => l.id));
  const res = await fetch(`${BACKEND}/session/${source.sessionId}/summarize`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(range),
  });
  return { lines: picked, result: await res.json() };
}

function gazeFrames(away) {
  const since = sessionToEpochMs(away.start_ms);
  const t = sessionToEpochMs(away.end_ms);
  return {
    since, t,
    away: { type: "zone", zone: "away", t: since, evidence_nats: 3.1, likelihood_ratio: 22 },
    panel: { type: "zone", zone: "panel", t, since, evidence_nats: 5.4, likelihood_ratio: 211 },
  };
}

const up = await backendUp();
const skip = up ? false : `backend not running at ${BACKEND}`;

test("the card shows the deadline change and nothing attended", { skip, timeout: 120_000 }, async () => {
  const { source, manifest, lines, gazeSocket } = await startPipeline("manifest.json");
  const f = gazeFrames(manifest.away_window);

  gazeSocket().send(f.away);
  gazeSocket().send(f.panel);
  const card = await createCatchup(source, lines, f.since, f.t);
  await source.stop();

  assert.ok(card, "no catch-up card was produced");
  const text = card.lines.map((l) => l.text).join(" ").toLowerCase();
  for (const token of manifest.expect_contains) assert.ok(text.includes(token.toLowerCase()), `missing ${token}: ${text}`);
  for (const token of manifest.expect_absent) assert.ok(!text.includes(token), `attended ${token} leaked: ${text}`);
  assert.ok(card.result.priorities.some((p) => /friday/i.test(p)),
    `Laya should promote the deadline to a priority: ${JSON.stringify(card.result.priorities)}`);
});

test("race: the card asks before our socket has even seen the return", { skip, timeout: 120_000 }, async () => {
  const { source, manifest, lines, gazeSocket } = await startPipeline("manifest.json");
  const f = gazeFrames(manifest.away_window);

  gazeSocket().send(f.away);
  // Their socket delivered the return first; they call createCatchup now...
  const pending = createCatchup(source, lines, f.since, f.t);
  // ...and only afterwards does our socket receive the same frame.
  await new Promise((r) => setTimeout(r, 50));
  gazeSocket().send(f.panel);
  const card = await pending;
  await source.stop();

  assert.ok(card, "the card must wait for our recovery, not render empty");
  assert.ok(card.lines.map((l) => l.text).join(" ").toLowerCase().includes("friday"));
});

test("the transcript feed never carries an attended line", { skip, timeout: 120_000 }, async () => {
  const { source, manifest, lines, gazeSocket } = await startPipeline("manifest.json");
  const f = gazeFrames(manifest.away_window);
  gazeSocket().send(f.away);
  gazeSocket().send(f.panel);
  await createCatchup(source, lines, f.since, f.t);
  await source.stop();

  // Everything the web app ever received, not just what the card picked.
  const everything = [...lines.values()].map((l) => l.text).join(" ").toLowerCase();
  assert.ok(everything.length > 0);
  for (const token of manifest.expect_absent) {
    assert.ok(!everything.includes(token), `onLine received attended word ${token}`);
  }
});

test("a sub-2 s glance produces no card and no lines", { skip, timeout: 60_000 }, async () => {
  const { source, manifest, lines, gazeSocket } = await startPipeline("manifest.json");
  const start = manifest.away_window.start_ms;
  const f = gazeFrames({ start_ms: start, end_ms: start + 1500 });
  gazeSocket().send(f.away);
  gazeSocket().send(f.panel);
  const card = await createCatchup(source, lines, f.since, f.t);
  await source.stop();

  assert.equal(card, null);
  assert.equal(lines.size, 0, "a glance must not emit anything to the transcript");
});

test("a long absence is chunked and recovered in full", { skip, timeout: 240_000 }, async () => {
  const { source, manifest, lines, gazeSocket } = await startPipeline("long_manifest.json");
  const f = gazeFrames(manifest.away_window);
  gazeSocket().send(f.away);
  gazeSocket().send(f.panel);
  const card = await createCatchup(source, lines, f.since, f.t);
  await source.stop();

  assert.ok(card);
  const text = card.lines.map((l) => l.text).join(" ").toLowerCase();
  for (const token of ["assignment", "friday", "website", "elasticity", "chapter", "midterm"]) {
    assert.ok(text.includes(token), `${token} lost from a 37 s absence: ${text}`);
  }
  for (const token of manifest.expect_absent) assert.ok(!text.includes(token), `attended ${token} leaked`);
  // Laya tagged the actionable ones; the summarizer bridge surfaces them.
  assert.ok(card.result.priorities.length >= 2, JSON.stringify(card.result.priorities));
});
