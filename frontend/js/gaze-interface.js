/**
 * The integration contract for the gaze team.
 *
 * The tracker reports raw transitions; this controller owns the 2-second rule
 * and the state machine, so a noisy per-frame tracker cannot create duplicate
 * away sessions:
 *
 *   LOOKING        --away-->            POTENTIAL_AWAY
 *   POTENTIAL_AWAY --return < 2s-->     LOOKING (discard everything)
 *   POTENTIAL_AWAY --reaches 2s-->      CONFIRMED_AWAY
 *   CONFIRMED_AWAY --return-->          finalize [original awayStart, return]
 *
 * The confirmed interval always starts at the ORIGINAL away timestamp: the
 * first two seconds are part of what the user missed, and the threshold is
 * only a trigger.
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
    /** Called by the gaze tracker when the student looks away. */
    awayStart(nowMs) {
      // Repeated away signals for the same event are ignored, not restarted.
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

    /** Called by the gaze tracker when the student looks back. */
    async returned(nowMs) {
      if (state === LOOKING) return null;

      clearTimer();
      const start = awayStartMs;
      const durationMs = nowMs - start;

      // Re-check the duration rather than trusting the timer: a paused tab or
      // a slow event loop can fire it late.
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

    /** Drop any in-flight away event without recovering it (session stop). */
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
