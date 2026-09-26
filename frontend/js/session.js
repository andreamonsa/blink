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
