/**
 * The gaze.py adapter, driven by recorded message sequences.
 *
 * No webcam and no running tracker: these are the exact JSON frames gaze.py
 * emits, so the whole integration is deterministic and runs in CI.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { connectGaze } from "../../frontend/js/gaze-websocket.js";
import { createGazeController } from "../../frontend/js/gaze-interface.js";
import { resetSession, startSession, stopDriftWatchdog, sessionToEpochMs } from "../../frontend/js/session.js";

/** A WebSocket stand-in we can drive frame by frame. */
class FakeSocket {
  static last = null;
  constructor(url) { this.url = url; FakeSocket.last = this; }
  open() { this.onopen?.(); }
  deliver(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  deliverRaw(data) { this.onmessage?.({ data }); }
  close() { this.onclose?.(); }
}

function harness({ leadMs = 0 } = {}) {
  resetSession();
  startSession();
  stopDriftWatchdog();

  const windows = [];
  const discarded = [];
  const gaze = createGazeController({
    thresholdMs: 2000,
    onMissedWindow: async (w) => { windows.push(w); return w; },
    onDiscarded: (d) => discarded.push(d),
  });
  const client = connectGaze({
    gaze, leadMs, WebSocketImpl: FakeSocket, reconnectMs: 10_000,
  });
  const sock = FakeSocket.last;
  sock.open();
  return { gaze, client, sock, windows, discarded };
}

/** Build the frames gaze.py sends for an absence of `durationMs`. */
function absence(durationMs, { at = Date.now() } = {}) {
  const since = at;
  const t = at + durationMs;
  return [
    { type: "zone", zone: "away", t: since, evidence_nats: 3.11, likelihood_ratio: 22.4 },
    { type: "zone", zone: "panel", t, since, evidence_nats: 5.35, likelihood_ratio: 211.6 },
  ];
}

test("a real absence produces exactly one missed window", async () => {
  const { sock, windows } = harness();
  sock.deliver({ type: "zone", zone: "panel", t: Date.now(), since: Date.now() }); // snapshot
  for (const frame of absence(5491)) sock.deliver(frame);
  await new Promise((r) => setImmediate(r));

  assert.equal(windows.length, 1);
  assert.equal(Math.round(windows[0].end_ms - windows[0].start_ms), 5491,
    "the away duration must survive the epoch->session conversion");
});

test("the connect snapshot never triggers a recovery", async () => {
  const { sock, windows } = harness();
  // gaze.py's hello carries a `since` that can be its process start time.
  sock.deliver({ type: "zone", zone: "panel", t: Date.now(), since: Date.now() - 900_000 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(windows, [], "a 15-minute bogus window must not be recovered");
});

test("gaze.py has no 2 s rule, so we enforce it", async () => {
  const { sock, windows, discarded } = harness();
  sock.deliver({ type: "zone", zone: "away", t: Date.now() });   // snapshot
  for (const frame of absence(1800)) sock.deliver(frame);
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(windows, [], "a 1.8 s glance must produce nothing");
  assert.equal(discarded.length, 1);
});

test("exactly 2000 ms is recovered", async () => {
  const { sock, windows } = harness();
  sock.deliver({ type: "zone", zone: "away", t: Date.now() });
  for (const frame of absence(2000)) sock.deliver(frame);
  await new Promise((r) => setImmediate(r));
  assert.equal(windows.length, 1);
});

test("connecting mid-absence rebuilds the start from `since`", async () => {
  const { sock, windows } = harness();
  const now = Date.now();
  // Snapshot says we are already away, then the return arrives. We never saw
  // the "away" frame, so only `since` can tell us when it began.
  sock.deliver({ type: "zone", zone: "away", t: now - 8000 });          // snapshot
  sock.deliver({ type: "zone", zone: "panel", t: now, since: now - 8000 });
  await new Promise((r) => setImmediate(r));

  assert.equal(windows.length, 1, "a mid-absence connect must still recover");
  assert.equal(Math.round(windows[0].end_ms - windows[0].start_ms), 8000);
});

test("flicker: ten short glances produce nothing", async () => {
  const { sock, windows, discarded } = harness();
  sock.deliver({ type: "zone", zone: "panel", t: Date.now(), since: Date.now() });
  let at = Date.now();
  for (let i = 0; i < 10; i++) {
    for (const frame of absence(500 + (i % 3) * 500, { at })) sock.deliver(frame);
    at += 3000;
  }
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(windows, []);
  assert.equal(discarded.length, 10);
});

test("consecutive absences stay separate", async () => {
  const { sock, windows } = harness();
  sock.deliver({ type: "zone", zone: "panel", t: Date.now(), since: Date.now() });
  const at = Date.now();
  for (const frame of absence(3000, { at })) sock.deliver(frame);
  for (const frame of absence(4000, { at: at + 10_000 })) sock.deliver(frame);
  await new Promise((r) => setImmediate(r));

  assert.equal(windows.length, 2);
  assert.equal(Math.round(windows[0].end_ms - windows[0].start_ms), 3000);
  assert.equal(Math.round(windows[1].end_ms - windows[1].start_ms), 4000);
});

test("repeated away frames do not restart the window", async () => {
  const { sock, windows } = harness();
  sock.deliver({ type: "zone", zone: "panel", t: Date.now(), since: Date.now() });
  const at = Date.now();
  sock.deliver({ type: "zone", zone: "away", t: at });
  sock.deliver({ type: "zone", zone: "away", t: at + 500 });
  sock.deliver({ type: "zone", zone: "away", t: at + 1200 });
  sock.deliver({ type: "zone", zone: "panel", t: at + 4000, since: at });
  await new Promise((r) => setImmediate(r));

  assert.equal(windows.length, 1);
  assert.equal(Math.round(windows[0].end_ms - windows[0].start_ms), 4000,
    "the window must start at the first away signal");
});

test("a disconnect drops a half-open window instead of pairing it wrongly", async () => {
  const { sock, gaze, windows } = harness();
  sock.deliver({ type: "zone", zone: "panel", t: Date.now(), since: Date.now() });
  sock.deliver({ type: "zone", zone: "away", t: Date.now() });
  assert.notEqual(gaze.getState(), "LOOKING");

  sock.close();  // gaze.py died or the socket dropped
  assert.equal(gaze.getState(), "LOOKING", "the stale away window must be dropped");
  assert.deepEqual(windows, []);
});

test("malformed and non-zone frames are ignored", async () => {
  const { sock, windows } = harness();
  sock.deliver({ type: "zone", zone: "panel", t: Date.now(), since: Date.now() });
  sock.deliverRaw("not json at all");
  sock.deliver({ type: "something-else", t: Date.now() });
  sock.deliver({ type: "zone", zone: "unknown-zone", t: Date.now() });
  for (const frame of absence(3000)) sock.deliver(frame);
  await new Promise((r) => setImmediate(r));
  assert.equal(windows.length, 1, "valid frames must still work after junk");
});

test("leadMs shifts both edges and preserves the duration", async () => {
  const { sock, windows } = harness({ leadMs: 400 });
  sock.deliver({ type: "zone", zone: "panel", t: Date.now(), since: Date.now() });
  const at = Date.now();
  for (const frame of absence(5000, { at })) sock.deliver(frame);
  await new Promise((r) => setImmediate(r));

  assert.equal(windows.length, 1);
  assert.equal(Math.round(windows[0].end_ms - windows[0].start_ms), 5000,
    "compensation must shift, not stretch");
  // Both edges moved 400 ms earlier than the uncompensated conversion.
  assert.ok(Math.round(sessionToEpochMs(windows[0].start_ms)) <= at - 399);
});
