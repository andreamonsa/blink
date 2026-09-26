# Silent Specs — speech-to-text + missed-information subsystem

Our slice of Silent Specs: lecture audio in, and **only the speech the student
missed while looking away** out — timestamped, tagged, and accumulated for the
summarizer.

The rule everything here serves:

> After the user looks back, the durable transcript contains only the words
> spoken during valid gaze-away windows, never the surrounding attended
> lecture. Laya may rank and tag that missed text, but may never cause missed
> text to be lost.

Two teammate-owned pieces plug in at the edges: the **gaze tracker** calls in,
the **summarizer** reads out. Both contracts are documented below.

---

## Running the whole team's system

On `main` every piece lives in this repo. On a machine with
[Ollama](https://ollama.com) installed:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
ollama pull qwen2.5:3b-instruct-q5_K_M        # the summarizer's model, ~2.3 GB
.venv/bin/python tools/generate_synthetic_audio.py   # test fixtures (macOS only)
```

Then three processes, all from the repo root:

```bash
ollama serve                                         # 1. summarizer model
.venv/bin/python gaze.py run --no-preview            # 2. eye tracker, ws://localhost:8765
.venv/bin/python -m uvicorn backend.app:app --port 8000   # 3. STT + Laya + summarizer + UI
```

Warm all three models once so the first card isn't a cold start:

```bash
curl -X POST http://127.0.0.1:8000/warmup
```

Open **<http://127.0.0.1:8000/?source=python>** in Chrome, play the lecture in
another Chrome tab, press Start, and share that tab **with "Also share tab
audio"** ticked. `/?source=mock` runs the scripted demo
with no hardware; `/debug/` is the diagnostics page.

What each piece does, and where they meet:

| | |
|---|---|
| `gaze.py` | Publishes `away` / `panel` transitions (wall-clock epoch ms) over a WebSocket. Has no minimum away duration. |
| `frontend/js/gaze-websocket.js` | Our second client of that socket. Converts timestamps to the monotonic session clock and applies the 2 s rule. Ignores the snapshot `gaze.py` sends on every connect. |
| `frontend/js/recovery.js` | Flushes 20 s chunks while the student is still away, the rest on return. |
| `backend/` | Whisper → exact word-overlap selection → Laya → session store. |
| `frontend/js/silentspecs-source.js` | Feeds the web app **only missed lines**, one per Laya fragment. |
| `web/` | The teammate's UI, unchanged apart from `sources.js` and a 7-line patch to `createCatchup`. |
| `summarizer.py` | The teammate's summarizer, imported by the backend from the repo root. |
| `gaze.py` | The teammate's eye tracker, run as its own process. |
| `backend/summarizer_bridge.py` | Runs `summarizer.py`. Card priorities come from Laya tags, so they still appear if Ollama is down. |

**The transcript pane only ever shows missed speech.** The teammate's mock
streamed the whole lecture; CLAUDE.md's invariant forbids attended speech from
being transcribed or stored, so lines appear when the student looks back.

### Things the integration had to handle

- **Two clocks.** `gaze.py` and the web app use wall-clock epoch ms; audio is
  on `performance.now()`. Conversion is done *relative to now*, so the wall
  clock only measures a gaze event's age (a few ms). An NTP step or sleep/wake
  earlier in the lecture therefore cannot shift later windows.
- **A race.** The web app builds its card the moment `gaze.py` reports a
  return, about a second before the words exist, and its gaze socket and ours
  deliver in no guaranteed order. `waitForWindow(from, to)` is keyed on
  `gaze.py`'s `t`, which both sockets receive identically, and resolves to the
  exact ids of that window's lines.
- **Long absences.** Chunks are tiled by start time at interior edges and by
  the overlap rule at the outer edges, so the union is word-for-word what a
  single clip would give (`tests/test_window_buffer.py`). The server also
  refuses to count a time range twice, whatever bounds a client sends.
- **Background-tab throttling.** Our page sits in the background while the
  student watches the lecture, and Chrome can run its timers once a minute. The
  return path drains every whole chunk itself rather than trusting the timer.
- **Nothing but missed text reaches the LLM.** `/session/{id}/summarize` takes a
  time range, never text, and reads the windows from the session store.

### Notes on the teammates' modules

- The committed `gaze_model.pkl` was trained on one person's face, camera and
  screen. Anyone else needs `python gaze.py collect` then `python gaze.py train`.
- `gaze.py` must run from the repo root (its model paths are relative) and with
  `--no-preview`; the OpenCV window otherwise throttles its event loop.
- The `web` branch's own `gaze.py` still ends in a stray `r` (a `SyntaxError`);
  `main` carries the working copy from the `eyetracker` branch.

### Memory: the full stack is tight on an 8 GB laptop

Whisper and Laya need roughly 2 GB together; Ollama's 3B model needs about
2.5 GB more; Chrome and `gaze.py` add to that. On the demo laptop, with other
apps open, swap reached 14 GB and a catch-up card took 5–14 s instead of about
1 s, because the models kept paging each other out -- Laya alone classifies 8
fragments in 0.7 s when its pages are resident. Before demoing: close other
apps, or run Ollama on a second machine (`OLLAMA_HOST=...`), or set
`LAYA_ENABLED=0` (cards then show exact words without priorities).

---

## Setup

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt

# One-off: cache the models (~1 GB). Needed once; afterwards everything is offline.
.venv/bin/python -c "
from faster_whisper import WhisperModel; WhisperModel('base.en', device='cpu', compute_type='int8')
import laya; laya.load('convaiinnovations/laya', subfolder='typed-decisions')"

.venv/bin/python tools/generate_synthetic_audio.py   # test fixture (macOS `say`)
```

## Run

```bash
.venv/bin/python -m uvicorn backend.app:app --port 8000
```

Open <http://127.0.0.1:8000>, click **Warm models**, pick an audio source, then
hold <kbd>SPACE</kbd> to simulate looking away.

**Warm the models before demoing.** Cold start is ~7 s for Laya; warm it once
and recovery lands in well under a second.

---

## Capturing an online lecture (macOS)

Play the lecture in a **Chrome tab**, click *Capture Chrome tab audio*, select
that tab, and tick **"Also share tab audio"**.

| | |
|---|---|
| Chrome, share a **tab** + tab audio | works |
| Chrome, share **entire screen** + audio | not supported on macOS (Windows/ChromeOS only) |
| Safari / Firefox | no tab audio on macOS at all |
| Zoom / Teams **desktop app** | not a browser tab — route output through a virtual device (e.g. BlackHole) and capture it as a microphone |

`getDisplayMedia` cannot be audio-only, so a video track is requested and then
never read.

---

## Integration contract: gaze in

The teammate's `gaze.py` reaches this through `frontend/js/gaze-websocket.js`,
which calls the two methods below. Any other tracker can call them directly.
The controller owns the 2-second rule, so a noisy per-frame tracker cannot
create duplicate away sessions.

```js
import { createGazeController } from "./gaze-interface.js";
import { sessionNowMs } from "./session.js";

const gaze = createGazeController({
  thresholdMs: 2000,
  onMissedWindow: recoverMissedWindow,   // from recovery.js
});

gaze.awayStart(sessionNowMs());   // call when the student looks away
gaze.returned(sessionNowMs());    // call when they look back
```

```
LOOKING        --away-->        POTENTIAL_AWAY
POTENTIAL_AWAY --return <2s-->  LOOKING          (discard everything)
POTENTIAL_AWAY --reaches 2s-->  CONFIRMED_AWAY
CONFIRMED_AWAY --return-->      finalize [original awayStart, return]
```

Both timestamps must come from `sessionNowMs()` — `performance.now()` relative
to session start. Never wall-clock time: it can jump backwards.

The confirmed interval always begins at the **original** away timestamp. The
first two seconds are part of what was missed; 2000 ms is only the trigger.

The debug page exposes the live controller as `window.silentSpecsGaze`, so a
tracker can be tested against it before the modules are merged.

## Integration contract: summarizer out

Every valid away window is appended to a session-wide missed transcript, held
in memory and ordered by `start_ms`. It contains only missed sentences.

```js
store.onMissedWindow((record, session) => { /* fires per window */ });
store.getSessionMissed();   // the whole SessionMissedTranscript
```

```bash
curl http://127.0.0.1:8000/session/{session_id}/missed
```

```jsonc
{
  "session_id": "s-...",
  "windows":   [ /* MissedWindowRecord, raw_text always intact */ ],
  "sentences": [ /* flat, ordered by start_ms — the summarizer's input */ ],
  "raw_text":  "everything missed, one window per line"
}
```

Each sentence carries `kind`, `priority`, `confidence` and timestamps, so the
summarizer can weight an `instruction_change` above `ordinary_context` without
re-deriving anything. **Nothing is ever dropped**, including `ordinary_context`
and anything Laya failed on.

Set `SUMMARIZER_URL` to also have each new record POSTed there,
fire-and-forget — a failing summarizer can never block or break recovery.

---

## How it works

```
Chrome tab audio
  -> AudioWorklet -> 60 s Float32 ring buffer          [ephemeral, memory only]

gaze tracker -> gaze controller -> valid away window

on return:
  slice [away_start - pad, away_end + pad] -> 16-bit WAV
  POST /recover
    -> faster-whisper, word_timestamps=True -> absolute session-ms words
    -> select words where end_ms > away_start AND start_ms < away_end   <- unpadded
    -> raw_text preserved first, unconditionally
    -> split on . ? !
    -> Laya tags those fragments only
    -> MissedWindowRecord -> session store
  <- client re-runs the selector as a guard, then stores and renders
```

### Why an AudioWorklet instead of MediaRecorder

`MediaRecorder.start()` has unspecified startup latency, so `clip_start_ms`
drifts from the true first sample. Counting samples in a worklet gives an exact
clock, and a rolling buffer means the beginning of an away event is never lost
to reaction time. The buffer is memory-only and holds 60 s; attended audio is
overwritten and only the away slice is ever sent anywhere.

### Why the clip is padded but the selection is not

Whisper aligns words badly at a hard clip edge, so `CLIP_PAD_MS` of acoustic
context is added on each side *of the audio*. Selection still runs against the
unpadded window, so padded words are dropped before anything is stored.

The pad must stay small. Measured on the synthetic fixture: 0–500 ms all
recover the missed sentence exactly, but at **750 ms** the clip reached 400 ms
into the next sentence and Whisper stretched its first word backwards across
the silence, dragging an attended word inside the window and dropping all
punctuation. Default is **250 ms**, and `tests/test_end_to_end_synthetic.py`
fails if it is set outside the validated range.

### Laya is an accelerator, never a dependency

Timestamps decide what was missed; Laya only decides how to rank and tag it.
Every failure mode — disabled, unavailable, throwing, malformed answer, too few
answers, unknown label — returns the complete raw missed text with
`kind="unclassified"` and `show_by_default=true`. **Fail open, never closed.**
`ordinary_context` may be collapsed in the compact card but stays in `raw_text`
under *Show everything I missed*.

Notes from reading the laya 0.3.20 source (its docs site documents a newer
unreleased API, hence the pin):

- `answer["confidence"]` is normalized Shannon entropy, **not** calibrated.
  `answer["answer_confidence"]` (`max(p)`) is the calibrated one, and that is
  what we report. Neither ever gates visibility.
- Each `criteria` description is hard-truncated at 48 tokens, and
  `instructions` shares a 256-token head budget with them. Both are checked by
  a test so nothing is silently clipped.
- States are passed as plain strings; a dict would be JSON-dumped verbatim into
  the prompt.

---

## API

| | |
|---|---|
| `GET /health` | model and classifier status, active thresholds |
| `POST /warmup` | force both models to load and run once |
| `POST /transcribe` | raw STT with word timestamps (debugging) |
| `POST /recover` | single-shot: `audio`, `away_start_ms`, `away_end_ms`, `clip_start_ms`, `session_id` → `MissedWindowRecord` |
| `POST /window/{id}/chunk` | one slice of an absence still in progress |
| `POST /window/{id}/finalize` | close a chunked absence → `MissedWindowRecord` |
| `GET /session/{id}/missed` | accumulated missed transcript |
| `POST /session/{id}/summarize` | `{from_ms, to_ms}` → `{summary, priorities}`; takes a range, never text |
| `GET /session/{id}/summary` | recap of everything missed this session |
| `POST /session/{id}/reset` | clear a session |

## Configuration

| Variable | Default | |
|---|---|---|
| `WHISPER_MODEL` | `base.en` | `tiny.en` if latency is tight, `small.en` for accuracy |
| `WHISPER_DEVICE` / `WHISPER_COMPUTE_TYPE` | `cpu` / `int8` | |
| `AWAY_THRESHOLD_MS` | `2000` | the two-second rule |
| `CLIP_PAD_MS` | `250` | pad on the two outer edges; validated range 0–500 |
| `CHUNK_MS` | `20000` | slice length flushed while the student is away |
| `MIN_CHUNK_MS` | `8000` | shorter tails are merged: Whisper mangles slivers |
| `CHUNK_PAD_MS` | `2000` | pad on interior chunk edges; safe to be generous |
| `LAYA_ENABLED` | `1` | `0` disables tagging; raw missed text still works |
| `LAYA_DEVICE` | auto | `mps` on Apple Silicon, or `cpu` |
| `SUMMARIZER_DIR` | unset | directory containing the teammate's `summarizer.py` |
| `SUMMARY_MAX_WORDS` | `60` | passed to `summarize()` |
| `SUMMARY_MAX_WINDOWS` | `5` | windows per manual catch-up; each is one Ollama call |
| `SUMMARIZER_URL` | unset | optional fire-and-forget hand-off |
| `DEBUG_TRANSCRIPT` | `0` | **off by default** — transcript text must not reach the logs |

---

## Tests

```bash
.venv/bin/python -m unittest discover -s tests -t . -p "test_*.py"   # 136
node --test tests/js/*.test.mjs                                      # 102
.venv/bin/python tools/validate_with_whisper.py                      # 20 checks
```

Note the glob in the Node command: `node --test tests/js/` is interpreted as a
module path, not a directory, on Node 24.

`tests/js/integration.test.mjs` is the end-to-end check: the synthetic lecture
plays as the tab audio and recorded `gaze.py` frames stand in for the eye
tracker, through the real source, recovery and backend, then the web app's card
filter and the summarizer bridge. It needs the backend running on port 8000 and
skips itself otherwise.

The Laya benchmark prints per-case predictions, accuracy, confusion counts and
latency measured on the machine it runs on:

```bash
.venv/bin/python -m unittest tests.test_laya_classifier_real
```

### Measured on the demo laptop (Apple M1, 8 GB)

| | |
|---|---|
| Recovery, gaze-return → record, 6 s clip | **658 ms** median (607–950 over 5 warm runs) |
| Whisper `base.en` int8 CPU | 0.44 s for a 6 s clip; 0.7 s cold load from cache |
| Laya `typed-decisions` on MPS | 6.9 s cold load, 127 ms warm single, 92 ms/fragment batched |
| Laya 12-case accuracy | **11/12 (91.7%)** |
| Demo sentence → `instruction_change` | yes, confidence 0.70 |

The criteria wording was tuned once against the 12-case set: describing the
speaker's act ("the speaker asks the student…") scored 11/12 where naming the
category scored 6/12. That wording is frozen in `backend/classifier.py`.

Laya's published ~33 ms is a T4 GPU number. The figures above are this laptop.

---

## Repo layout

```
backend/
  missed_selector.py   the correctness core — no third-party imports
  pipeline.py          select -> preserve raw -> fragment -> classify
  stt.py               faster-whisper, loaded once
  classifier.py        Laya, loaded once, fail-open
  session_store.py     session accumulation for the summarizer
  app.py schemas.py config.py
frontend/js/
  session.js           the one clock (performance.now)
  pcm-recorder.worklet.js + audio-capture.js   ring buffer, WAV slicing
  gaze-interface.js    the gaze contract + 2 s state machine
  gaze-stub.js         keyboard + scripted timelines, for testing
  missed-selector.js   JS mirror, runs as a client-side guard
  recovery.js store.js app.js
tools/     generate_synthetic_audio.py, validate_with_whisper.py, wav_util.py
tests/     python suites + tests/js/*.test.mjs
```

## Known limitations

- Absence length is no longer bounded by the 60 s ring buffer, because chunks
  are flushed while the student is away. The exception is a background tab so
  throttled that no flush runs for over a minute; the return path then drains
  what is still buffered, and `recovery.js` warns if the start was lost.
- The sample clock is anchored to `performance.now()` once at the first audio
  block. Over a very long session the AudioContext clock can drift slightly
  from `performance.now()`; irrelevant at the scale of a single away window.
- One of the 12 classifier cases ("Can you tell me why the demand curve shifts
  to the right?") is tagged `ordinary_context`, and it is misread the same way
  in the long synthetic lecture. It is collapsed in the compact card and left
  out of the priorities, but remains in the exact words.
- Only one away window is recovered at a time. A second absence starting before
  the first finishes recovering waits for it.
- `tools/generate_synthetic_audio.py` uses macOS `say` and is macOS-only. The
  rest of the system is not.
