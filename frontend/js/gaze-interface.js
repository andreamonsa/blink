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
