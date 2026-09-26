# Blink web app

Live transcript (left), catch-up card and past catch-ups (right), and **start/stop** and **summary** buttons.
Plain HTML/CSS/JS with no build step and nothing to install.

## Run it

```bash
python3 -m http.server 8000 --directory web
```

- Demo mode: http://localhost:8000/. It plays a scripted lecture. **Hold Space** to simulate looking away, then release to get a catch-up card.
- With Zachary's eye tracker: run `python gaze.py run`, then open http://localhost:8000/?source=python.
- Opening `web/index.html` directly (double-click) also works.

## Files

| File | What it does |
|---|---|
| `index.html` / `styles.css` | Layout and the "Editorial notebook" design |
| `app.js` | UI: transcript, scroll-back, "missed" highlighting, catch-up cards, buttons |
| `ruled.js` | Keeps text sitting exactly on the ruled lines (visual only) |
| `attention.js` | Glare: name box, edge glow and notification when the student's name is called |
| `sources.js` | **The only place teammates' code plugs in**: gaze, transcript, summarizer |
| `mock-lecture.js` | Scripted lecture for demo mode |

## Message formats

**Gaze: uses the official format from `gaze.py run`.** WebSocket `ws://localhost:8765`; the page connects as a client:

```json
{"type": "zone", "zone": "away",  "t": 1727340000000}
{"type": "zone", "zone": "panel", "t": 1727340019000, "since": 1727340000000}
```

When `zone` becomes `"panel"`, the app builds a catch-up card for the lines spoken between `since` and `t`. The snapshot that `gaze.py` sends on connect is treated as state only, so it doesn't create a card.

**Transcript: not in the repo yet (mock for now).** The app expects each line as
`{ id, t, text, final }`, where `t` is epoch ms. Repeated messages with the same `id` update that line until `final: true`.

**Summarizer: `summarizer.py` exists, but the browser can't call a Python function yet.**
The card accepts `{ summary: string | string[], priorities?: string[] }`. The plain string that
`summarize()` returns works as-is. The Priorities section only appears if someone provides `priorities`.

## LaTeX

Formulas are rendered with KaTeX (loaded from a CDN) using the `\( \)`, `\[ \]` and `$$ $$` delimiters, which is what
`summarizer.py` produces. Single `$` is ignored on purpose, so "$5" in speech isn't treated as math. Formulas render while a line is still being spoken. A formula that's only half spoken, with no closing `\)` yet, stays as plain text until it's complete. If KaTeX can't load, formulas show as raw text.

## Glare: "someone said your name"

The student types their name in the header box. Nicknames can be added with commas, for example `Andrea, Andy`, and the name is saved in the browser. When the name shows up in the transcript:

- **Glow**, only if the student is **not looking at the screen**: a pulsing amber gradient around the screen edges, aimed at peripheral vision. It stops as soon as the eye tracker reports `zone: "panel"`, or after 30 seconds as a safety net.
- **Notification**, always: shows what was said, with a "Show in transcript" link. It closes with ✕ or Esc, or on its own after 30 seconds.

"Not looking" is checked when the line reaches the page, because live speech-to-text lags a few seconds behind the speaker. Detection runs in the browser as soon as the name appears, including in text that's still being transcribed. It ignores case and accents, only matches whole words, and allows one wrong letter in names of five or more letters, because speech-to-text often misspells names. It relies on `app.js` dispatching `blink:line` and `blink:zone` events. Other sources can trigger the same alert with `Blink.callAttention({ text, t })`.

## Ruled lines

`ruled.js` lines text up with the paper's rules. Any container that defines `--lh` (the spacing between rules) and `--rule-y` (the position of the first rule) gets each text block's height rounded up to a whole number of rules, and its first baseline nudged onto a rule. This works across different font sizes and after tall formulas. If you change fonts or sizes in `styles.css`, keep the `line-height` of ruled text equal to `var(--lh)`.
