# Blink

**Captions that notice when you look away.**

Blink is a live-caption app for deaf and hard-of-hearing students. It uses your
laptop's webcam to see when your eyes leave the captions, and when you look back
it tells you what you missed. If the professor says your name while you're
looking somewhere else, the edges of your screen light up.

Everything runs on your own laptop. No audio or video goes to the cloud.

<img width="1187" height="624" alt="Screenshot 2026-09-26 at 17 27 59" src="https://github.com/user-attachments/assets/1542736c-d43f-441d-8e36-ca9995fd4262" />


---

## The problem

In a lecture, a hearing student can look at the board, write notes and still
follow what the professor is saying. A deaf student can't. They read the
captions to know what's being said, so every time they look up at the board,
down at their notes or at the professor, the captions keep going without them.

Scrolling back to find what they missed means missing what's being said now.
Then they fall behind again, and the loop repeats.

Blink breaks that loop.

## What it does

- **Live transcript.** Everything the professor says appears on the left, a few
  seconds behind. You can scroll back at any time. Formulas show up as real
  maths, not code.
- **Catch-up card.** When you look back at the screen, a card on the right tells
  you what you missed. It puts the important things first: a question aimed at
  you, a changed deadline, a decision. Below that is a short summary, and the
  exact words are one click away.
- **Glare.** Type your name in the box at the top. If someone says it while
  you're not looking at the screen, the edges of the screen glow. Deaf people
  often have sharper peripheral vision, so you notice the glow even while
  you're looking at the board. A small notification shows exactly what was said.
  The glow stops as soon as you look back.
- **Missed lines are marked.** Lines spoken while you were looking away are
  highlighted, so you can see at a glance which parts you still need to read.

## A lecture with Blink

1. You open Blink, type your name and press **Start**.
2. The professor talks. The transcript fills in on the left.
3. You look down to write something. Blink notices and starts keeping track.
4. The professor says: "The problem set is now due Friday, not Monday."
5. You look back up. The catch-up card lists the deadline change at the top,
   under **Priorities**, with a short summary of the rest below it.
6. Later, while you're looking at the board, the professor asks: "Andrea, what
   do you think?" The screen edges glow and you look down. The question is right
   there in the notification.

---

## How it works

Blink is four small programs that talk to each other on your laptop.

```
 webcam ──► Eye tracker ──── "looking away" / "looking back" ────┐
                                                                   ▼
 microphone ──► Speech-to-text ──► Priority tagging ──► Web app (what you see)
                                          │                        ▲
                                          └──► Summarizer ──────────┘
```

**1. Eye tracker** (`gaze.py`, by Zachary). It watches your face through the
webcam, using Google's MediaPipe to find your eyes, irises and head angle. A
small model trained on *your* face decides, frame by frame, whether you're
looking at the Blink window. It doesn't react to a single frame, though. It
adds up the evidence over a few frames and only says "you looked away" once
it's confident, so blinks and quick glances don't trigger anything.

**2. Speech-to-text** (`backend/`, by Mattia). It listens through the
microphone, or to a Chrome tab for an online lecture, and turns speech into text
with Whisper. While you look away, it cuts out exactly the words spoken in that
window, down to the word. A second model, Laya, then tags those words as a
question to you, a change of instructions, a decision, or just lecture content.

**3. Summarizer** (`summarizer.py`, by Louis). A small language model (Qwen 2.5,
3B, run by Ollama) turns what you missed into a recap of about 60 words. It
keeps names, numbers, dates and formulas exactly as they were said. If the
summarizer isn't running, the cards still show the priorities and the exact
words.

**4. Web app** (`web/`, by Andrea). The page you actually look at: the
transcript on ruled "notebook" paper, the catch-up cards, the glare, and a demo
mode for trying it without a webcam or microphone.

### Privacy

- Nothing leaves your laptop. Whisper, Laya, the summarizer and the eye tracker
  all run locally, so it works without internet once it's set up.
- The live transcript is only kept in the open page. The server only stores the
  words you **missed**, and only those can reach the summarizer. It's built
  that way on purpose: it can't be asked to summarize anything else.
- The webcam images are never saved. Only "looking" or "not looking" leaves the
  eye tracker.

---

## Try it in 1 minute (demo mode)

No webcam, microphone or setup needed, just Python and Chrome:

```bash
python3 -m http.server 8000 --directory web
```

Open <http://localhost:8000> and press **Start**. A scripted maths lecture plays.

- **Hold the Space bar** to pretend you're looking away. Let go to "look back".
- Type **Andrea** in the name box, then hold Space around 25 seconds in. The
  professor calls on Andrea and the screen glows.

## Run the real thing

You need a Mac or Linux laptop with **16 GB of RAM** (8 GB works, but it's
slow), **Chrome**, **Python 3.12 or 3.13** and, for the summaries,
[Ollama](https://ollama.com).

**1. Install** (once, about 15 minutes, several GB of downloads):

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

**2. Teach the eye tracker your face** (once, about 5 minutes). The model in the
repo was trained on someone else's face and screen, so it won't be reliable for
you.

```bash
.venv/bin/python gaze.py collect
.venv/bin/python gaze.py train
```

Put the Blink window where you'll read it. In `collect`, press **P** while
looking at it and **A** while looking elsewhere: the professor, your notes, the
middle of the screen, your phone. Do at least 8 of each, then press **Q**.
`train` tells you how accurate the result is.

**3. Start everything:**

```bash
./run.sh
```

It starts the eye tracker, speech-to-text and the summarizer, warms up the
models and opens Chrome. The first run downloads the models, so give it a few
minutes. Press **Start**, allow the microphone, and you're live. **Ctrl+C** in
the terminal stops everything.

### Options

| Command | What it does |
|---|---|
| `./run.sh` | Lecture in the room, heard through the microphone |
| `BLINK_AUDIO=tab ./run.sh` | Online lecture: share the Chrome tab it's playing in, with "Also share tab audio" ticked |
| `BLINK_LIVE=0 ./run.sh` | Strict privacy mode: only transcribe what you missed, no live transcript |
| `BLINK_CAMERA=1 ./run.sh` | Use a different webcam. By default Blink picks the laptop's own camera |
| `SUMMARIZER_MODEL=qwen2.5:1.5b-instruct-q5_K_M ./run.sh` | Smaller summarizer for a slower laptop |

Add `&debug=1` to the page's address to show the microphone picker and an audio
level meter.

## If something goes wrong

| What you see | What to do |
|---|---|
| **"Eye tracker offline"** | The eye tracker couldn't use the camera. On a Mac, allow the camera for the app you ran `./run.sh` from: System Settings → Privacy & Security → Camera. If your terminal isn't in the list, run it from the Terminal app and click Allow. Then run it again. |
| **Your iPhone camera turns on** | Blink should pick the laptop camera by itself. If it doesn't, run `BLINK_CAMERA=1 ./run.sh`, or turn off Continuity Camera on the phone. |
| **"Reading" / "Looking away" is wrong** | Redo step 2 with more varied takes, especially looking just next to the window. |
| **It stalls at "warming models"** | The first run downloads Whisper and Laya. If it's stuck for more than 5 minutes, press Ctrl+C and run it again. |
| **Nothing appears in the transcript** | Check that Chrome has microphone access, and open the page with `&debug=1` to see the audio level. |
| **The glow didn't come on** | It only glows if you're still looking away when your name *reaches the screen*, which is about 4 seconds after it's said. If you'd already looked back, you just get the notification. |
| **Catch-up cards are slow** | You're probably short on memory. Close other apps, or use the smaller summarizer (see Options). |

Logs are in `.logs/`: `gaze.log` for the eye tracker and `backend.log` for the
rest.

---

## What's in this repo

| Path | What it is |
|---|---|
| `web/` | The web app: transcript, catch-up cards, glare, demo mode |
| `gaze.py` | The eye tracker: record, train and run |
| `backend/` | Speech-to-text, word selection, Laya tagging, the summarizer bridge |
| `frontend/js/` | Audio capture and the live-transcript pipeline the web app loads |
| `summarizer.py` | The summarizer (Ollama) |
| `run.sh` | Starts everything with one command |
| `tools/` | Helpers: camera picker, test audio, summarizer checks |
| `docs/TECHNICAL.md` | The detailed technical write-up: APIs, clocks, edge cases, tests |

## The team

Built at the BAINSA hackathon, September 2026.

- **Zachary**: eye tracking
- **Mattia**: speech-to-text and the backend
- **Louis**: summarizer
- **Andrea**: web app and design
