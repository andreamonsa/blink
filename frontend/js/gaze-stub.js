/**
 * Stand-in gaze driver for testing, until the gaze teammate's tracker lands.
 *
 * It calls exactly the same two methods the real tracker will call --
 * gaze.awayStart(ms) and gaze.returned(ms) -- so nothing downstream has to
 * change when it is swapped out.
 */

import { sessionNowMs } from "./session.js";

/** Hold a key to look away, release to look back. */
export function attachKeyboardGaze(gaze, { key = " " } = {}) {
  let down = false;

  const onKeyDown = (event) => {
    if (event.key !== key || event.repeat || down) return;
    event.preventDefault();
    down = true;
    gaze.awayStart(sessionNowMs());
  };

  const onKeyUp = (event) => {
    if (event.key !== key || !down) return;
    event.preventDefault();
    down = false;
    gaze.returned(sessionNowMs());
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  };
}

/**
 * Replay a scripted list of {awayAtMs, durationMs} against the session clock.
 * This is how the flicker and boundary trials are run reproducibly.
 */
export function playGazeTimeline(gaze, events, { onEvent = () => {} } = {}) {
  const timers = [];
  for (const event of events) {
    const delay = Math.max(0, event.awayAtMs - sessionNowMs());
    timers.push(
      setTimeout(() => {
        gaze.awayStart(sessionNowMs());
        onEvent({ type: "away", ...event });
        timers.push(
          setTimeout(() => {
            gaze.returned(sessionNowMs());
            onEvent({ type: "return", ...event });
          }, event.durationMs)
        );
      }, delay)
    );
  }
  return () => timers.forEach(clearTimeout);
}

/** Ten short glances: expect zero cards and zero durable text. */
export const FLICKER_TIMELINE = Array.from({ length: 10 }, (_, i) => ({
  awayAtMs: 2000 + i * 2500,
  durationMs: 500 + (i % 3) * 500,
}));
