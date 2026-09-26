/**
 * The session clock, and the bridge to everyone else's clock.
 *
 * Internally we use performance.now(): monotonic, immune to NTP steps, and the
 * only sane basis for measuring an away window or aligning audio samples.
 *
 * Everything upstream disagrees. gaze.py emits `int(time.time()*1000)` and the
 * web app uses Date.now() throughout, so all cross-module timestamps are
 * wall-clock epoch milliseconds. We convert at exactly one boundary, here,
 * rather than letting two clocks mix downstream -- a mixed comparison would
 * silently attribute speech to the wrong gaze window rather than fail loudly.
 */

let sessionOrigin = null;
// Epoch ms corresponding to session ms 0. NOT the epoch at performance.now()===0:
// performance.now() counts from page load, so anchoring there would offset every
// converted gaze timestamp by however long the page had been open.
let sessionEpochOrigin = null;
let driftTimer = null;
let onDrift = null;

/** How far the two clocks may diverge before we suspect an NTP step or sleep. */
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

/**
 * Epoch ms -> session ms. Use for every timestamp arriving from gaze.py.
 *
 * Converted *relative to now*, not against a fixed anchor: "this event is
 * (Date.now() - epochMs) old by the wall clock, so it happened that long before
 * the monotonic now". The wall clock is then only ever used to measure an
 * event's age -- a few milliseconds for a fresh gaze frame -- so an NTP step or
 * a sleep/wake earlier in the lecture cannot shift it. Interval arithmetic
 * downstream is monotonic, as CLAUDE.md requires. A fixed anchor would instead
 * carry any clock step into every later conversion for the rest of the session.
 */
export function epochToSessionMs(epochMs) {
  if (sessionOrigin === null) startSession();
  return sessionNowMs() - (Date.now() - epochMs);
}

/** Session ms -> epoch ms, relative to now. Use for timestamps handed to the web app. */
export function sessionToEpochMs(sessionMs) {
  if (sessionOrigin === null) startSession();
  return Math.round(Date.now() - (sessionNowMs() - sessionMs));
}

export function getSessionEpochOrigin() {
  return sessionEpochOrigin;
}

/**
 * Current divergence between the wall clock and the monotonic clock.
 *
 * Zero at session start by construction. It moves when the system clock is
 * stepped (NTP) or the laptop sleeps -- precisely the moments when a gaze
 * timestamp would start mapping to the wrong audio.
 */
export function clockDriftMs() {
  if (sessionEpochOrigin === null) return 0;
  // Where the wall clock says we are, minus where the monotonic clock says we
  // are. Zero at session start by construction; moves only on an NTP step or
  // a suspend, which is exactly when conversions start lying.
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
  // Never hold the process open in Node (tests).
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

/** A session id unique per page load, for the summarizer hand-off. */
export function newSessionId() {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
