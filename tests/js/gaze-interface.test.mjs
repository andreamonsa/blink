/**
 * Gaze state machine: the 2-second rule and debounce behaviour.
 * Uses a fake clock so the flicker test (CLAUDE.md Part 9F) is deterministic.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIRMED_AWAY,
  LOOKING,
  POTENTIAL_AWAY,
  createGazeController,
} from "../../frontend/js/gaze-interface.js";

/** Minimal controllable timer so tests never actually wait. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    now: () => now,
    setTimeoutFn: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeoutFn: (id) => pending.delete(id),
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

function harness(overrides = {}) {
  const clock = fakeClock();
  const windows = [];
  const discarded = [];
  const states = [];
  const gaze = createGazeController({
    thresholdMs: 2000,
    onMissedWindow: async (win) => { windows.push(win); return win; },
    onDiscarded: (info) => discarded.push(info),
    onStateChange: (state) => states.push(state),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    ...overrides,
  });
  return { clock, gaze, windows, discarded, states };
}

test("a glance shorter than 2s produces no missed window", async () => {
  const { clock, gaze, windows, discarded } = harness();
  gaze.awayStart(clock.now());
  clock.advance(1999);
  await gaze.returned(clock.now());

  assert.deepEqual(windows, []);
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].duration_ms, 1999);
  assert.equal(gaze.getState(), LOOKING);
});

test("exactly 2000 ms away is a valid missed window", async () => {
  const { clock, gaze, windows } = harness();
  gaze.awayStart(clock.now());
  clock.advance(2000);
  await gaze.returned(clock.now());

  assert.deepEqual(windows, [{ start_ms: 0, end_ms: 2000 }]);
});

test("the window starts at the original away time, not away+2000", async () => {
  const { clock, gaze, windows } = harness();
  clock.advance(5000);
  gaze.awayStart(clock.now());
  clock.advance(6000);
  await gaze.returned(clock.now());

  assert.equal(windows[0].start_ms, 5000, "the first two seconds must be included");
  assert.equal(windows[0].end_ms, 11000);
});

test("state machine walks LOOKING -> POTENTIAL_AWAY -> CONFIRMED_AWAY", async () => {
  const { clock, gaze, states } = harness();
  assert.equal(gaze.getState(), LOOKING);
  gaze.awayStart(clock.now());
  assert.equal(gaze.getState(), POTENTIAL_AWAY);
  clock.advance(2000);
  assert.equal(gaze.getState(), CONFIRMED_AWAY);
  await gaze.returned(clock.now());
  assert.deepEqual(states, [POTENTIAL_AWAY, CONFIRMED_AWAY, LOOKING]);
});

test("repeated away signals do not restart or duplicate the session", async () => {
  const { clock, gaze, windows } = harness();
  gaze.awayStart(clock.now());
  clock.advance(500);
  gaze.awayStart(clock.now()); // noisy webcam frame
  clock.advance(500);
  gaze.awayStart(clock.now());
  clock.advance(1500);
  await gaze.returned(clock.now());

  assert.equal(windows.length, 1);
  assert.equal(windows[0].start_ms, 0, "away start must not be pushed forward");
  assert.equal(windows[0].end_ms, 2500);
});

test("a return while already LOOKING is ignored", async () => {
  const { clock, gaze, windows, discarded } = harness();
  assert.equal(await gaze.returned(clock.now()), null);
  assert.deepEqual(windows, []);
  assert.deepEqual(discarded, []);
});

test("flicker test: ten 0.5-1.5 s glances produce nothing", async () => {
  const { clock, gaze, windows, discarded } = harness();
  for (let i = 0; i < 10; i++) {
    gaze.awayStart(clock.now());
    clock.advance(500 + (i % 3) * 500); // 500, 1000, 1500 ms
    await gaze.returned(clock.now());
    clock.advance(800);
  }
  assert.deepEqual(windows, [], "no durable text may come from glances");
  assert.equal(discarded.length, 10);
});

test("a late timer does not turn a short glance into a missed window", async () => {
  // A paused tab can fire the 2 s timer after the user already looked back.
  const { clock, gaze, windows, discarded } = harness();
  gaze.awayStart(clock.now());
  clock.advance(2500);          // timer fires -> CONFIRMED_AWAY
  assert.equal(gaze.getState(), CONFIRMED_AWAY);
  await gaze.returned(1200);    // but the real return was at 1200 ms
  assert.deepEqual(windows, [], "duration is re-checked against real timestamps");
  assert.equal(discarded.length, 1);
});

test("consecutive valid windows stay separate", async () => {
  const { clock, gaze, windows } = harness();
  gaze.awayStart(clock.now());
  clock.advance(3000);
  await gaze.returned(clock.now());
  clock.advance(4000);
  gaze.awayStart(clock.now());
  clock.advance(2500);
  await gaze.returned(clock.now());

  assert.deepEqual(windows, [
    { start_ms: 0, end_ms: 3000 },
    { start_ms: 7000, end_ms: 9500 },
  ]);
});

test("cancel drops an in-flight away event without recovering it", async () => {
  const { clock, gaze, windows } = harness();
  gaze.awayStart(clock.now());
  clock.advance(5000);
  gaze.cancel();
  assert.equal(gaze.getState(), LOOKING);
  await gaze.returned(clock.now());
  assert.deepEqual(windows, []);
});
