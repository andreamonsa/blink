"""
gaze_listener.py — receive the PANEL / NOT PANEL signal from gaze.py

Zachary runs:      py gaze.py run            (same laptop)
               or  py gaze.py run --host 0.0.0.0   (you're on another laptop, same Wi-Fi)

You run:           python gaze_listener.py
               or  python gaze_listener.py ws://192.168.x.x:8765   (address gaze.py prints)

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
"""

import asyncio
import json
import sys
from datetime import datetime

URL = sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:8765"


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


async def main():
    from websockets.asyncio.client import connect
    while True:
        try:
            async with connect(URL) as ws:
                print(f"Connected to {URL}")
                async for raw in ws:
                    msg = json.loads(raw)
                    if msg.get("type") != "zone":
                        continue
                    if msg["zone"] == "panel":
                        on_panel(msg.get("since", msg["t"]), msg["t"], msg)
                    else:
                        on_not_panel(msg["t"], msg)
        except (OSError, Exception) as e:
            print(f"Not connected ({e.__class__.__name__}). Is gaze.py run going? Retrying in 2s...")
            await asyncio.sleep(2)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
