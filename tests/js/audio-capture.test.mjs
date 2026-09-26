/**
 * Ring buffer timeline mapping and WAV encoding.
 *
 * No AudioContext here: the buffer state is set up directly, which is exactly
 * what the worklet does at runtime. What matters is that a sample index maps
 * back to the right session millisecond, because the missed-word filter is
 * only as good as that mapping.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { AudioCapture, encodeWav } from "../../frontend/js/audio-capture.js";

const RATE = 48000;

/** A capture primed with `seconds` of audio, sample i holding value i. */
function primed({ bufferSeconds = 30, seconds = 10, epochMs = 1000 } = {}) {
  const cap = new AudioCapture({ bufferSeconds });
  cap.sampleRate = RATE;
  cap.ringSize = Math.ceil(RATE * bufferSeconds);
  cap.ring = new Float32Array(cap.ringSize);
  cap.epochMs = epochMs;

  const total = Math.round(RATE * seconds);
  for (let i = 0; i < total; i++) {
    cap.ring[i % cap.ringSize] = i;
  }
  cap.totalSamples = total;
  cap.writeIndex = total % cap.ringSize;
  return cap;
}

function wavSamples(blob, bytes) {
  const view = new DataView(bytes);
  return { view, count: view.getUint32(40, true) / 2 };
}

test("wav header describes 16-bit mono PCM at the capture rate", async () => {
  const blob = encodeWav(new Float32Array([0, 0.5, -0.5]), RATE);
  const bytes = await blob.arrayBuffer();
  const view = new DataView(bytes);
  assert.equal(String.fromCharCode(...new Uint8Array(bytes, 0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...new Uint8Array(bytes, 8, 4)), "WAVE");
  assert.equal(view.getUint16(20, true), 1, "PCM");
  assert.equal(view.getUint16(22, true), 1, "mono");
  assert.equal(view.getUint32(24, true), RATE);
  assert.equal(view.getUint16(34, true), 16, "bits per sample");
  assert.equal(view.getUint32(40, true), 3 * 2, "data size");
});

test("wav encoding clamps instead of wrapping", async () => {
  const blob = encodeWav(new Float32Array([2, -2, 0]), RATE);
  const view = new DataView(await blob.arrayBuffer());
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
  assert.equal(view.getInt16(48, true), 0);
});

test("slice maps milliseconds onto the right samples", () => {
  const cap = primed({ epochMs: 1000, seconds: 10 });
  // Audio covers session time 1000..11000 ms.
  const slice = cap.sliceToWav(3000, 5000);
  assert.equal(slice.clipStartMs, 3000);
  assert.equal(slice.clipEndMs, 5000);
  assert.equal(slice.durationMs, 2000);
  assert.equal(slice.truncated, false);
});

test("clipStartMs reports the real start after clamping to the buffer", () => {
  // 5 s buffer holding 10 s of audio: the first 5 s have been overwritten.
  const cap = primed({ bufferSeconds: 5, seconds: 10, epochMs: 0 });
  assert.equal(Math.round(cap.oldestAvailableMs), 5000);
  assert.equal(Math.round(cap.newestAvailableMs), 10000);

  const slice = cap.sliceToWav(1000, 8000);
  assert.equal(slice.truncated, true, "must admit the start was lost");
  assert.equal(slice.clipStartMs, 5000, "clip_start_ms must match the audio sent");
  assert.equal(slice.clipEndMs, 8000);
});

test("a slice reads correct samples after the ring has wrapped", async () => {
  const cap = primed({ bufferSeconds: 5, seconds: 10, epochMs: 0 });
  // Request 100 samples starting at second 9; sample value == sample index.
  const from = 9 * RATE;
  const slice = cap.sliceToWav(9000, 9000 + (100 / RATE) * 1000);
  const view = new DataView(await slice.blob.arrayBuffer());
  // Values were written as raw indices, far beyond 1.0, so they clamp high.
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(slice.clipStartMs, Math.round((from / RATE) * 1000));
});

test("slice returns null when the range is entirely gone or empty", () => {
  const cap = primed({ bufferSeconds: 5, seconds: 20, epochMs: 0 });
  assert.equal(cap.sliceToWav(0, 3000), null, "range fully overwritten");
  assert.equal(cap.sliceToWav(8000, 8000), null, "empty range");
  assert.equal(cap.sliceToWav(30000, 40000), null, "range in the future");
});

test("an unstarted capture yields no slice", () => {
  const cap = new AudioCapture();
  assert.equal(cap.sliceToWav(0, 5000), null);
  assert.equal(cap.oldestAvailableMs, null);
});

test("the padded request of a real away window maps to the right clip", () => {
  // Away [4333, 9824] with a 250 ms pad, as in the synthetic fixture.
  const cap = primed({ bufferSeconds: 30, seconds: 15, epochMs: 0 });
  const slice = cap.sliceToWav(4333 - 250, 9824 + 250);
  assert.equal(slice.clipStartMs, 4083);
  assert.equal(slice.clipEndMs, 10074);
  assert.equal(slice.truncated, false);
});

test("clearBuffer forgets everything", () => {
  const cap = primed();
  cap.clearBuffer();
  assert.equal(cap.totalSamples, 0);
  assert.equal(cap.epochMs, null);
  assert.equal(cap.sliceToWav(0, 1000), null);
});

test("the sample clock stays exact over many blocks", () => {
  const cap = new AudioCapture({ bufferSeconds: 30 });
  cap.sampleRate = RATE;
  cap.ringSize = RATE * 30;
  cap.ring = new Float32Array(cap.ringSize);
  cap.epochMs = 0;
  cap.totalSamples = 0;

  const block = new Float32Array(128);
  for (let i = 0; i < 3750; i++) cap._write(block); // 3750 * 128 = 10 s at 48k

  assert.equal(cap.totalSamples, 480000);
  assert.equal(Math.round(cap.newestAvailableMs), 10000,
    "sample counting must not drift");
});

// --- capture health: is it really getting ALL the audio? -------------------

function live({ seconds = 10, blocks = null, peak = 0.3, silent = false } = {}) {
  const cap = new AudioCapture({ bufferSeconds: 60 });
  cap.sampleRate = RATE;
  cap.ringSize = RATE * 60;
  cap.ring = new Float32Array(cap.ringSize);
  cap.epochMs = 0;
  cap.startedAtMs = 0;
  cap.context = { state: "running" };
  const n = blocks ?? Math.round((RATE * seconds) / 128);
  const block = new Float32Array(128);
  if (!silent) block[0] = peak;
  for (let i = 0; i < n; i++) cap._write(block);
  return cap;
}

test("health reports full coverage when no blocks are dropped", () => {
  const cap = live({ seconds: 10 });
  cap.startedAtMs = -10000; // pretend 10 s of session time elapsed
  const h = cap.getHealth();
  assert.ok(h.receiving);
  assert.ok(Math.abs(h.capturedMs - 10000) < 50);
  assert.ok(h.coverage > 0.98 && h.coverage < 1.02, `coverage ${h.coverage}`);
  assert.equal(h.audible, true);
  assert.equal(h.silentFraction, 0);
});

test("health flags a track carrying pure digital silence", () => {
  const cap = live({ seconds: 5, silent: true });
  const h = cap.getHealth();
  assert.equal(h.silentFraction, 1, "every block was exact zeros");
  assert.equal(h.audible, false, "must not claim it is capturing sound");
  assert.ok(h.receiving, "blocks did arrive -- the track exists but is silent");
});

test("health detects dropped audio as negative drift", () => {
  // 5 s of blocks arrived, but 10 s of session time passed.
  const cap = live({ seconds: 5 });
  cap.startedAtMs = -10000;
  const h = cap.getHealth();
  assert.ok(h.coverage < 0.55, `coverage ${h.coverage} should show the gap`);
  assert.ok(h.driftMs < -4000, `drift ${h.driftMs} should be about -5000 ms`);
});

test("health before any audio arrives says so rather than lying", () => {
  const cap = new AudioCapture();
  const h = cap.getHealth();
  assert.equal(h.receiving, false);
  assert.equal(h.running, false);
});

test("buffered duration saturates at the ring size, not the session length", () => {
  const cap = live({ seconds: 90 });   // 90 s into a 60 s ring
  const h = cap.getHealth();
  assert.ok(Math.abs(h.bufferedMs - 60000) < 50, `bufferedMs ${h.bufferedMs}`);
  assert.ok(h.capturedMs > 89000, "total captured keeps counting past the ring");
});

test("a 60 s ring covers a long away window that a 30 s ring would truncate", () => {
  const cap = live({ seconds: 90 });
  // Looked away from 40 s to 85 s -- a 45 s window.
  const slice = cap.sliceToWav(40000, 85000);
  assert.equal(slice.truncated, false, "45 s window must fit in the 60 s ring");
  assert.equal(slice.clipStartMs, 40000);
});
