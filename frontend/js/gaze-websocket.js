/**
 * Client for the teammate's eye tracker (`python gaze.py run --no-preview`).
 *
 * gaze.py is a WebSocket *server* on ws://localhost:8765 that broadcasts to
 * every connected client, so we open our own connection alongside the web
 * app's rather than threading events through it.
 *
 * Wire format (epoch milliseconds, from time.time()):
 *   {"type":"zone","zone":"away","t":1790413412001}
 *   {"type":"zone","zone":"panel","t":1790413418092,"since":1790413412001}
 * plus one state-snapshot message immediately after every connect.
 *
 * Two things gaze.py deliberately does not do, which we must:
 *   - it has no minimum away duration (its hysteresis is evidence-based, so a
 *     confident 300 ms glance still flips the state). Our gaze controller
 *     applies the 2 s rule.
 *   - its timestamps are wall clock; ours are monotonic. We convert on arrival.
 */

import { epochToSessionMs } from "./session.js";

export const DEFAULT_GAZE_URL = "ws://localhost:8765";

/** gaze.py's "panel" means looking at the screen; "away" means not. */
const ZONE_LOOKING = "panel";
const ZONE_AWAY = "away";

export function connectGaze({
  gaze,
  url = DEFAULT_GAZE_URL,
  leadMs = 0,
  reconnectMs = 2000,
  onStatus = () => {},
  WebSocketImpl = typeof WebSocket !== "undefined" ? WebSocket : null,
} = {}) {
  if (!WebSocketImpl) throw new Error("no WebSocket implementation available");

  let socket = null;
  let closed = false;
  let firstMessage = true;
  let reconnectTimer = null;

  /**
   * gaze.py stamps a transition after inference returns, so both edges of the
   * window arrive a few hundred ms late. Shifting both by one measured
   * constant corrects it; the ring buffer already holds the past, so moving
   * the start earlier costs nothing. Defaults to 0 -- measure before setting.
   */
  const toSession = (epochMs) => epochToSessionMs(epochMs) - leadMs;

  function handle(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!msg || msg.type !== "zone") return null;

    const isSnapshot = firstMessage;
    firstMessage = false;

    // The snapshot tells us the current state; it is not a transition, and its
    // `since` can be the tracker's process-start time. Acting on it would fire
    // a bogus recovery over an arbitrary window on every reconnect.
    if (isSnapshot) {
      onStatus({ phase: "snapshot", zone: msg.zone });
      return null;
    }

    if (msg.zone === ZONE_AWAY) {
      gaze.awayStart(toSession(msg.t));
      onStatus({ phase: "away", at: msg.t });
      return "away";
    }

    if (msg.zone === ZONE_LOOKING) {
      // If we connected mid-absence we never saw the matching "away", so
      // rebuild the start from `since` rather than losing the whole window.
      if (gaze.getState() === "LOOKING" && typeof msg.since === "number") {
        gaze.awayStart(toSession(msg.since));
      }
      const result = gaze.returned(toSession(msg.t));
      // `result` is the recovery promise, or null for a sub-2 s glance. The
      // web app keys its catch-up card on this same `t`, so passing both lets
      // it wait for exactly this return rather than whatever happens to be
      // pending -- delivery order across two sockets is not guaranteed.
      onStatus({ phase: "returned", at: msg.t, since: msg.since, result });
      return result;
    }

    return null;
  }

  function open() {
    if (closed) return;
    onStatus({ phase: "connecting", url });
    firstMessage = true;

    socket = new WebSocketImpl(url);

    socket.onopen = () => {
      firstMessage = true;
      onStatus({ phase: "connected", url });
    };
    socket.onmessage = (event) => handle(event.data);
    socket.onerror = () => onStatus({ phase: "error", url });
    socket.onclose = () => {
      onStatus({ phase: "offline", url });
      // Events emitted while we are disconnected are lost -- gaze.py has no
      // replay -- so drop any half-open away window rather than pairing it
      // with a return that belongs to a different absence.
      gaze.cancel();
      if (!closed) {
        reconnectTimer = setTimeout(open, reconnectMs);
        if (typeof reconnectTimer?.unref === "function") reconnectTimer.unref();
      }
    };
  }

  open();

  return {
    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      if (socket) socket.close();
    },
    /** Exposed for tests: feed a raw frame as though it arrived on the socket. */
    _handle: handle,
    get isFirstMessage() {
      return firstMessage;
    },
  };
}
