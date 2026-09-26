/** Recovery orchestration: chunked flushing, the client guard, and the race fix. */
import test from "node:test";
import assert from "node:assert/strict";

import { createRecovery } from "../../frontend/js/recovery.js";
import { MissedStore } from "../../frontend/js/store.js";

const WORDS = [
  { start_ms: 2000, end_ms: 2600, text: "The" },
  { start_ms: 2600, end_ms: 3400, text: "assignment" },
  { start_ms: 3400, end_ms: 4200, text: "moved." },
];

/** A capture whose buffered audio we advance by hand. */
function fakeCapture({ newest = 60_000 } = {}) {
  return {
    newestAvailableMs: newest,
    calls: [],
    sliceToWav(a, b) {
      this.calls.push([Math.round(a), Math.round(b)]);
      return { blob: new Blob(["x"]), clipStartMs: Math.round(a), clipEndMs: Math.round(b), truncated: false };
    },
  };
}

/** Records every request and answers chunk/finalize calls. */
function fakeFetch({ record = null, ok = true } = {}) {
  const sent = [];
  const fn = async (url, init) => {
    sent.push({ url, form: init.body });
    if (!ok) return { ok: false, status: 500, json: async () => ({}), text: async () => "boom" };
    const body = url.endsWith("/finalize")
      ? (record ?? { raw_text: "The assignment moved.", words: WORDS, items: [], start_ms: 2000, end_ms: 4200 })
      : { words_total: 3 };
    return { ok: true, status: 200, json: async () => body, text: async () => "" };
  };
  fn.sent = sent;
  return fn;
}

const chunksOf = (f) => f.sent.filter((s) => s.url.endsWith("/chunk"));
const finalizeOf = (f) => f.sent.filter((s) => s.url.endsWith("/finalize"));
const tick = () => new Promise((r) => setTimeout(r, 0));

test("a short absence sends one chunk then finalizes", async () => {
  const capture = fakeCapture();
  const store = new MissedStore("s1");
  global.fetch = fakeFetch();
  const rec = createRecovery({ capture, store });

  rec.beginWindow(2000);
  await rec.recoverMissedWindow({ start_ms: 2000, end_ms: 4200 });

  assert.equal(chunksOf(global.fetch).length, 1);
  assert.equal(finalizeOf(global.fetch).length, 1);
  const chunk = chunksOf(global.fetch)[0].form;
  assert.equal(chunk.get("is_first"), "true");
  assert.equal(chunk.get("is_last"), "true");
});

test("the outer edges use the small pad, not the generous one", async () => {
  const capture = fakeCapture();
  const store = new MissedStore("s1");
  global.fetch = fakeFetch();
  const rec = createRecovery({ capture, store, getConfig: () => ({ outerPadMs: 250, innerPadMs: 2000 }) });

  rec.beginWindow(10_000);
  await rec.recoverMissedWindow({ start_ms: 10_000, end_ms: 14_000 });

  assert.deepEqual(capture.calls[0], [9_750, 14_250],
    "a single chunk is both first and last, so both edges get the small pad");
});

test("interior chunk edges get the generous pad", async () => {
  const capture = fakeCapture({ newest: 100_000 });
  const store = new MissedStore("s1");
  global.fetch = fakeFetch();
  const rec = createRecovery({
    capture, store,
    getConfig: () => ({ chunkMs: 20_000, minChunkMs: 8_000, outerPadMs: 250, innerPadMs: 2_000 }),
  });

  rec.beginWindow(0);
  // 100 s of audio buffered: two whole chunks are ready immediately.
  await rec.recoverMissedWindow({ start_ms: 0, end_ms: 50_000 });

  // chunk 0 is first  -> [0-250, 20000+2000]
  assert.deepEqual(capture.calls[0], [-250, 22_000]);
  assert.equal(chunksOf(global.fetch)[0].form.get("is_first"), "true");
  assert.equal(chunksOf(global.fetch)[0].form.get("is_last"), "false");
});

test("a long absence is flushed in several chunks, tiled without gaps", async () => {
  const capture = fakeCapture({ newest: 200_000 });
  const store = new MissedStore("s1");
  global.fetch = fakeFetch({
    record: { raw_text: "x", words: [{ start_ms: 1, end_ms: 2, text: "x" }], items: [], start_ms: 0, end_ms: 90_000 },
  });
  const rec = createRecovery({
    capture, store,
    getConfig: () => ({ chunkMs: 20_000, minChunkMs: 8_000, outerPadMs: 250, innerPadMs: 2_000, thresholdMs: 0 }),
  });

  rec.beginWindow(0);
  await rec.recoverMissedWindow({ start_ms: 0, end_ms: 90_000 });

  const chunks = chunksOf(global.fetch).map((c) => [
    Number(c.form.get("chunk_start_ms")), Number(c.form.get("chunk_end_ms")),
  ]);
  assert.deepEqual(chunks, [[0, 20_000], [20_000, 40_000], [40_000, 60_000], [60_000, 80_000], [80_000, 90_000]]);

  // Contiguous: every chunk begins exactly where the previous ended.
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i][0], chunks[i - 1][1], "gap or overlap between chunks");
  }
  assert.equal(chunksOf(global.fetch).at(-1).form.get("is_last"), "true");
  // Indices must be unique so a retry can be detected server-side.
  const idx = chunksOf(global.fetch).map((c) => c.form.get("chunk_index"));
  assert.equal(new Set(idx).size, idx.length);
});

test("a too-short tail is widened rather than sent as a sliver", async () => {
  const capture = fakeCapture({ newest: 200_000 });
  const store = new MissedStore("s1");
  global.fetch = fakeFetch({
    record: { raw_text: "x", words: [{ start_ms: 1, end_ms: 2, text: "x" }], items: [], start_ms: 0, end_ms: 42_000 },
  });
  const rec = createRecovery({
    capture, store,
    getConfig: () => ({ chunkMs: 20_000, minChunkMs: 8_000, outerPadMs: 250, innerPadMs: 2_000, thresholdMs: 0 }),
  });

  rec.beginWindow(0);
  await rec.recoverMissedWindow({ start_ms: 0, end_ms: 42_000 });

  const last = chunksOf(global.fetch).at(-1).form;
  const span = Number(last.get("chunk_end_ms")) - Number(last.get("chunk_start_ms"));
  assert.ok(span >= 8_000, `tail chunk was only ${span} ms; Whisper mangles slivers`);
  assert.equal(last.get("chunk_end_ms"), "42000");
});

test("chunks flush while still away, before the student returns", async () => {
  const capture = fakeCapture({ newest: 0 });
  const store = new MissedStore("s1");
  global.fetch = fakeFetch();
  const rec = createRecovery({
    capture, store,
    getConfig: () => ({ chunkMs: 20_000, minChunkMs: 8_000, outerPadMs: 250, innerPadMs: 2_000 }),
  });

  rec.beginWindow(0);
  assert.equal(chunksOf(global.fetch).length, 0, "nothing to flush yet");

  capture.newestAvailableMs = 45_000;           // 45 s of audio has now arrived
  await new Promise((r) => setTimeout(r, 1100)); // one flush tick
  assert.equal(chunksOf(global.fetch).length, 2,
    "two whole chunks should be uploaded before the return");
  assert.equal(finalizeOf(global.fetch).length, 0, "must not finalize early");
  await rec.recoverMissedWindow({ start_ms: 0, end_ms: 45_000 });
});

test("the client guard strips anything left outside the window", async () => {
  const capture = fakeCapture();
  const store = new MissedStore("s1");
  global.fetch = fakeFetch({
    record: {
      raw_text: "The assignment moved. LEAKED",
      words: [...WORDS, { start_ms: 9000, end_ms: 9600, text: "LEAKED" }],
      items: [
        { start_ms: 2000, end_ms: 4200, text: "The assignment moved.", kind: "instruction_change", priority: 3, show_by_default: true },
        { start_ms: 9000, end_ms: 9600, text: "LEAKED", kind: "ordinary_context", priority: 1, show_by_default: false },
      ],
      start_ms: 2000, end_ms: 4200,
    },
  });
  const rec = createRecovery({ capture, store });
  rec.beginWindow(2000);
  const stored = await rec.recoverMissedWindow({ start_ms: 2000, end_ms: 4200 });

  assert.equal(stored.raw_text, "The assignment moved.");
  assert.ok(!stored.items.some((i) => i.text === "LEAKED"));
});

test("waitForWindow lets the UI await the text before rendering its card", async () => {
  const capture = fakeCapture();
  const store = new MissedStore("s1");
  let release;
  global.fetch = async (url) => {
    if (url.endsWith("/finalize")) {
      await new Promise((r) => { release = r; });
      return { ok: true, status: 200, json: async () => ({ raw_text: "late text", words: WORDS, items: [], start_ms: 2000, end_ms: 4200 }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const rec = createRecovery({ capture, store });
  rec.beginWindow(2000);
  const inflight = rec.recoverMissedWindow({ start_ms: 2000, end_ms: 4200 });

  let settled = false;
  rec.waitForWindow().then(() => { settled = true; });
  await tick();
  assert.equal(settled, false, "waitForWindow must not resolve before the text exists");

  release();
  await inflight;
  await rec.waitForWindow();
  assert.equal(store.windowCount, 1, "the card can now find its line");
});

test("a backend failure never throws into the gaze controller", async () => {
  const store = new MissedStore("s1");
  const phases = [];
  global.fetch = fakeFetch({ ok: false });
  const rec = createRecovery({
    capture: fakeCapture(), store, onStatus: (s) => phases.push(s.phase),
  });
  rec.beginWindow(2000);
  assert.equal(await rec.recoverMissedWindow({ start_ms: 2000, end_ms: 4200 }), null);
  assert.ok(phases.includes("error"));
  assert.equal(store.windowCount, 0);
  assert.equal(rec.hasOpenWindow(), false, "a failed window must not stay open");
});

test("an empty selection stores nothing", async () => {
  const store = new MissedStore("s1");
  const phases = [];
  global.fetch = fakeFetch({ record: { raw_text: "", words: [], items: [], start_ms: 0, end_ms: 3000 } });
  const rec = createRecovery({ capture: fakeCapture(), store, onStatus: (s) => phases.push(s.phase) });
  rec.beginWindow(0);
  assert.equal(await rec.recoverMissedWindow({ start_ms: 0, end_ms: 3000 }), null);
  assert.ok(phases.includes("empty"));
});

test("the gaze state hook opens a window only on CONFIRMED_AWAY", () => {
  const rec = createRecovery({ capture: fakeCapture(), store: new MissedStore("s1") });
  rec.onGazeState("POTENTIAL_AWAY", 1000);
  assert.equal(rec.hasOpenWindow(), false);
  rec.onGazeState("CONFIRMED_AWAY", 1000);
  assert.equal(rec.hasOpenWindow(), true);
  // Close it: a live flush timer would otherwise keep posting through whatever
  // global.fetch a *later* test installs, polluting that test's request log.
  rec.dispose();
});

test("stop() finalizes an open window instead of discarding it", async () => {
  const capture = fakeCapture();
  const store = new MissedStore("s1");
  global.fetch = fakeFetch();
  const rec = createRecovery({ capture, store });

  rec.beginWindow(2000);
  const stored = await rec.stop(4200);   // session stopped while still away
  assert.ok(stored, "stopping mid-absence must not lose what was missed");
  assert.equal(store.windowCount, 1);
});

test("the session id sent matches the store", async () => {
  const store = new MissedStore("session-xyz");
  global.fetch = fakeFetch();
  const rec = createRecovery({ capture: fakeCapture(), store });
  rec.beginWindow(2000);
  await rec.recoverMissedWindow({ start_ms: 2000, end_ms: 4200 });
  assert.equal(chunksOf(global.fetch)[0].form.get("session_id"), "session-xyz");
  assert.equal(finalizeOf(global.fetch)[0].form.get("session_id"), "session-xyz");
});

// --- regressions: bugs these tests caught ------------------------------------

test("a short tail after mid-absence flushes widens its clip, never its bounds", async () => {
  // Earlier bug: to avoid a sliver, the tail's chunk_start_ms was moved back
  // over the previous chunk. The server assigns words by start time per chunk,
  // so every word in that overlap was stored twice.
  const capture = fakeCapture({ newest: 0 });
  const store = new MissedStore("s1");
  global.fetch = fakeFetch();
  const rec = createRecovery({
    capture, store,
    getConfig: () => ({ chunkMs: 20_000, minChunkMs: 8_000, outerPadMs: 250, innerPadMs: 2_000 }),
  });

  rec.beginWindow(0);
  capture.newestAvailableMs = 41_000;
  await new Promise((r) => setTimeout(r, 1100));        // timer flushes [0,20k] [20k,40k]
  await rec.recoverMissedWindow({ start_ms: 0, end_ms: 43_000 });   // 3 s tail

  const bounds = chunksOf(global.fetch).map((c) => [
    Number(c.form.get("chunk_start_ms")), Number(c.form.get("chunk_end_ms")),
  ]);
  assert.deepEqual(bounds, [[0, 20_000], [20_000, 40_000], [40_000, 43_000]],
    "assignment bounds must tile with no overlap");

  const [clipStart, clipEnd] = capture.calls.at(-1);
  assert.ok(clipEnd - clipStart >= 8_000,
    `the tail's audio must still be >= minChunkMs, got ${clipEnd - clipStart} ms`);
  rec.dispose();
});

test("a throttled background timer still yields proper chunks on return", async () => {
  // Our page is a background tab; Chrome may run setInterval once a minute.
  // Simulate the timer never ticking at all before a 90 s absence ends.
  const capture = fakeCapture({ newest: 95_000 });
  const store = new MissedStore("s1");
  global.fetch = fakeFetch({
    record: { raw_text: "x", words: [{ start_ms: 1, end_ms: 2, text: "x" }], items: [], start_ms: 0, end_ms: 90_000 },
  });
  const rec = createRecovery({
    capture, store,
    getConfig: () => ({ chunkMs: 20_000, minChunkMs: 8_000, outerPadMs: 250, innerPadMs: 2_000, thresholdMs: 0 }),
  });
  rec.beginWindow(0);
  await rec.recoverMissedWindow({ start_ms: 0, end_ms: 90_000 });   // immediately

  const spans = chunksOf(global.fetch).map(
    (c) => Number(c.form.get("chunk_end_ms")) - Number(c.form.get("chunk_start_ms"))
  );
  assert.ok(spans.length >= 4, `expected several chunks, got ${spans.length}`);
  assert.ok(Math.max(...spans) <= 28_000,
    "no single clip may swallow the whole absence");
});

test("a return racing an in-flight timer flush never sends a chunk twice", async () => {
  const capture = fakeCapture({ newest: 0 });
  const store = new MissedStore("s1");
  // Slow network: each chunk upload takes 300 ms.
  const inner = fakeFetch();
  global.fetch = async (url, init) => {
    if (url.endsWith("/chunk")) await new Promise((r) => setTimeout(r, 300));
    return inner(url, init);
  };
  global.fetch.sent = inner.sent;
  const rec = createRecovery({
    capture, store,
    getConfig: () => ({ chunkMs: 20_000, minChunkMs: 8_000, outerPadMs: 250, innerPadMs: 2_000 }),
  });

  rec.beginWindow(0);
  capture.newestAvailableMs = 45_000;
  await new Promise((r) => setTimeout(r, 1050));   // timer starts uploading chunk 0
  await rec.recoverMissedWindow({ start_ms: 0, end_ms: 45_000 });  // return mid-upload

  const idx = inner.sent.filter((s) => s.url.endsWith("/chunk")).map((s) => s.form.get("chunk_index"));
  assert.equal(new Set(idx).size, idx.length, `a chunk index was sent twice: ${idx}`);
  const starts = inner.sent.filter((s) => s.url.endsWith("/chunk")).map((s) => s.form.get("chunk_start_ms"));
  assert.equal(new Set(starts).size, starts.length, `a chunk range was sent twice: ${starts}`);
});

test("dispose stops the flush timer so nothing keeps running", () => {
  const rec = createRecovery({ capture: fakeCapture(), store: new MissedStore("s1") });
  rec.beginWindow(0);
  assert.equal(rec.hasOpenWindow(), true);
  rec.dispose();
  assert.equal(rec.hasOpenWindow(), false);
});
