"""
gaze_listener.py — receive the PANEL / NOT PANEL signal from gaze.py

Zachary runs:      py gaze.py run            (same laptop)
               or  py gaze.py run --host 0.0.0.0   (you're on another laptop, same Wi-Fi)

You run:           python gaze_listener.py
               or  python gaze_listener.py ws://192.168.x.x:8765   (address gaze.py prints)
               add --live to watch everything arriving:  python gaze_listener.py --live

Install once:      pip install websockets

Put your code in on_panel() and on_not_panel() below.

Message format (JSON), sent only when the signal CHANGES:
  {"type": "zone", "zone": "panel",
   "t": 1790413408092,            # ms since 1970 (JavaScript Date.now() style), when they looked
   "since": 1790413405573,        # when they last stopped looking at the panel
   "evidence_nats": 5.35, "likelihood_ratio": 211.6}
  {"type": "zone", "zone": "away", "t": ...}
So on "panel": summarise the transcript between `since` and `t`.
On "away": clear / reset the recap.
(The first message after connecting is just the current state.)
gaze.py also sends {"type": "status", ...} ~5x/s with the live evidence; it's
only shown with --live and can otherwise be ignored.
"""

import asyncio
import json
import sys
from datetime import datetime

args = [a for a in sys.argv[1:] if not a.startswith("-")]
URL = args[0] if args else "ws://localhost:8765"
LIVE = "--live" in sys.argv     # python gaze_listener.py --live  -> show every message


def on_panel(since_ms, t_ms, msg):
    """User is looking at the panel -> make and show the recap."""
    secs = (t_ms - since_ms) / 1000
    print(f"PANEL: summarise transcript from {fmt(since_ms)} to {fmt(t_ms)} ({secs:.0f}s)")
    # e.g. text = transcript_between(since_ms, t_ms); show(summarise(text))


def on_not_panel(t_ms, msg):
    """User looked away -> reset the recap."""
    print(f"NOT PANEL at {fmt(t_ms)}: reset recap")
    # e.g. clear_recap()


def fmt(ms):
    return datetime.fromtimestamp(ms / 1000).strftime("%H:%M:%S")


def handle(raw):
    """Calls your functions. Errors in YOUR code are printed in full but don't drop the connection."""
    try:
        msg = json.loads(raw)
        if msg.get("type") == "status":
            if LIVE:   # redraw one line in place with what gaze.py is seeing right now
                p = " no face" if msg["p"] is None else f"p={msg['p']:.2f}"
                n = int(20 * min(1, msg["evidence"] / msg["threshold"]))
                sys.stdout.write(f"\r  live: {msg['zone'].upper():5s}  {p}  evidence "
                                 f"[{'#' * n}{'-' * (20 - n)}] {msg['evidence']:.1f}/{msg['threshold']:.1f}   ")
                sys.stdout.flush()
            return
        if msg.get("type") != "zone":
            return
        if LIVE:
            sys.stdout.write("\r" + " " * 80 + "\r")
            print(f"  received: {raw}")
        if msg["zone"] == "panel":
            on_panel(msg.get("since", msg["t"]), msg["t"], msg)
        else:
            on_not_panel(msg["t"], msg)
    except Exception:
        import traceback
        print("\n*** Error in on_panel / on_not_panel (your code), still listening: ***")
        traceback.print_exc()


async def main():
    try:
        from websockets.asyncio.client import connect
    except ImportError:
        sys.exit("websockets is missing or too old. Run:  python -m pip install -U websockets")
    print(f"Listening for gaze.py at {URL} ...")
    while True:
        try:
            async with connect(URL, open_timeout=3) as ws:
                print(f"Connected to {URL}")
                async for raw in ws:
                    handle(raw)
            print("gaze.py closed the connection. Reconnecting...")
        except (OSError, asyncio.TimeoutError) as e:
            print(f"Can't reach gaze.py at {URL} ({e.__class__.__name__}). "
                  f"Is `gaze.py run` running? Retrying in 2s...")
        except Exception as e:
            print(f"Connection problem: {e!r}. Retrying in 2s...")
        await asyncio.sleep(2)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass