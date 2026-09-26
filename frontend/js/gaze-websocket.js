/**
 * Client for the teammate's eye tracker (`python gaze.py run --no-preview`).
 */

import { epochToSessionMs } from "./session.js";

export const DEFAULT_GAZE_URL = "ws://localhost:8765";

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
      if (gaze.getState() === "LOOKING" && typeof msg.since === "number") {
        gaze.awayStart(toSession(msg.since));
      }
      const result = gaze.returned(toSession(msg.t));
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
    _handle: handle,
    get isFirstMessage() {
      return firstMessage;
    },
  };
}
