/**
 * Clock conversion. gaze.py and the web app both speak wall-clock epoch ms;
 * our audio timeline is monotonic. Getting this wrong misattributes speech to
 * the wrong away window without any visible error, so it is pinned hard.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DRIFT_WARN_MS,
  clockDriftMs,
  epochToSessionMs,
  getSessionEpochOrigin,
  resetSession,
  sessionNowMs,
  sessionToEpochMs,
  startSession,
  stopDriftWatchdog,
} from "../../frontend/js/session.js";

test("epoch and session ms round-trip exactly", () => {
  resetSession(); startSession();
  for (const sessionMs of [0, 1, 1234, 60000, 3_600_000]) {
    assert.equal(Math.round(epochToSessionMs(sessionToEpochMs(sessionMs))), sessionMs);
  }
  stopDriftWatchdog();
});

test("session time starts at zero and the epoch origin is 'now'", () => {
  resetSession(); startSession();
  assert.ok(sessionNowMs() < 50, "session clock must start near zero");
  // The origin is the epoch time of session ms 0 -- i.e. "now" -- NOT the epoch
  // at performance.now()===0, which would be page-load time.
  assert.ok(Math.abs(getSessionEpochOrigin() - Date.now()) < 50,
    "epoch origin must anchor to session start, not page load");
  stopDriftWatchdog();
});

test("a gaze timestamp from just now maps to roughly now on the session clock", () => {
  resetSession(); startSession();
  const gazeEvent = Date.now();              // what gaze.py would send
  const asSession = epochToSessionMs(gazeEvent);
  assert.ok(Math.abs(asSession - sessionNowMs()) < 50,
    `gaze event mapped to ${asSession} but session time is ${sessionNowMs()}`);
  stopDriftWatchdog();
});

test("a real gaze window converts to the right duration", () => {
  resetSession(); startSession();
  // gaze.py: {"zone":"panel","t":<now>,"since":<now-5491>}
  const t = Date.now();
  const since = t - 5491;
  const startMs = epochToSessionMs(since);
  const endMs = epochToSessionMs(t);
  assert.equal(Math.round(endMs - startMs), 5491,
    "duration must survive conversion exactly");
  assert.ok(startMs < endMs);
  stopDriftWatchdog();
});

test("an event from before the session maps to negative session time", () => {
  resetSession(); startSession();
  // An event 10 minutes before the session started (gaze connected earlier).
  // Relative conversion reads the two clocks microseconds apart, so compare
  // within a millisecond rather than demanding float equality.
  const old = getSessionEpochOrigin() - 600_000;
  const got = epochToSessionMs(old);
  assert.ok(Math.abs(got - -600_000) < 5,
    `pre-session events must map to about -600000, got ${got}`);
  stopDriftWatchdog();
});

test("an NTP step earlier in the lecture does not shift a fresh gaze event", () => {
  // The reason conversion is relative rather than anchored: a step that
  // happened minutes ago must not move where a *new* event lands.
  resetSession(); startSession();
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 7000;   // the wall clock jumped 7 s at some point
    const freshGazeEvent = Date.now();   // gaze.py stamps with the same, jumped clock
    const asSession = epochToSessionMs(freshGazeEvent);
    assert.ok(Math.abs(asSession - sessionNowMs()) < 20,
      `a fresh event must land at 'now' despite the step, got ${asSession} vs ${sessionNowMs()}`);
  } finally {
    Date.now = realNow;
  }
  stopDriftWatchdog();
});

test("drift is ~zero at session start", () => {
  resetSession(); startSession();
  assert.ok(Math.abs(clockDriftMs()) < 10, `drift was ${clockDriftMs()}`);
  stopDriftWatchdog();
});

test("drift is detected when the wall clock is stepped", () => {
  resetSession(); startSession();
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 4000;      // simulate an NTP jump forward
    assert.ok(clockDriftMs() > DRIFT_WARN_MS,
      `a 4 s clock step must exceed the ${DRIFT_WARN_MS} ms warn threshold`);
  } finally {
    Date.now = realNow;
  }
  stopDriftWatchdog();
});

test("the watchdog reports drift to its callback", async () => {
  resetSession();
  const seen = [];
  startSession({ onClockDrift: (d) => seen.push(d) });
  const realNow = Date.now;
  Date.now = () => realNow() + 10_000;
  try {
    await new Promise((r) => setTimeout(r, 5200));  // one watchdog tick
    assert.ok(seen.length >= 1, "watchdog never fired");
    assert.ok(seen[0] > DRIFT_WARN_MS);
  } finally {
    Date.now = realNow;
    stopDriftWatchdog();
  }
});

test("resetSession clears both origins", () => {
  startSession();
  resetSession();
  assert.equal(getSessionEpochOrigin(), null);
});

test("converting before startSession auto-starts rather than returning NaN", () => {
  resetSession();
  const v = epochToSessionMs(Date.now());
  assert.ok(Number.isFinite(v), "must not produce NaN");
  assert.ok(Math.abs(v) < 50);
  stopDriftWatchdog();
});
