#!/usr/bin/env bash
# Blink — one-command launcher. Ctrl+C stops everything.
#
#   ./run.sh                    lecture heard through the microphone (default)
#   BLINK_AUDIO=tab ./run.sh    online lecture: capture a Chrome tab's audio
#   BLINK_LIVE=0 ./run.sh       strict mode: only what was missed is transcribed
#   SUMMARIZER_MODEL=qwen2.5:1.5b-instruct-q5_K_M ./run.sh   weaker laptop
cd "$(dirname "$0")"
PY=.venv/bin/python
AUDIO="${BLINK_AUDIO:-mic}"
LIVE="${BLINK_LIVE:-1}"
URL="http://127.0.0.1:8000/?source=python&audio=$AUDIO&live=$LIVE"
LOGS=.logs; mkdir -p "$LOGS"

[ -x "$PY" ] || { echo "No .venv found. Run: python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt"; exit 1; }

cleanup() { echo; echo "stopping..."; kill $(jobs -p) 2>/dev/null; wait 2>/dev/null; }
trap cleanup EXIT INT TERM

# 1. Ollama (optional: without it the cards still show priorities and the exact words)
if command -v ollama >/dev/null 2>&1; then
  if ! curl -s localhost:11434 >/dev/null; then
    ollama serve >"$LOGS/ollama.log" 2>&1 &
    for _ in $(seq 1 60); do curl -s localhost:11434 >/dev/null && break; sleep 0.5; done
  fi
  ollama list | grep -q "${SUMMARIZER_MODEL:-qwen2.5:3b-instruct-q5_K_M}" \
    || ollama pull "${SUMMARIZER_MODEL:-qwen2.5:3b-instruct-q5_K_M}"
else
  echo "Ollama not installed: summaries are off (install it from https://ollama.com to enable them)."
fi

# 2. Eye tracker (needs camera permission for this terminal)
$PY gaze.py run --no-preview >"$LOGS/gaze.log" 2>&1 &
GAZE_PID=$!

# 3. Backend + UI
$PY -m uvicorn backend.app:app --port 8000 >"$LOGS/backend.log" 2>&1 &
BACKEND_PID=$!
echo -n "starting backend"
for _ in $(seq 1 120); do
  curl -s localhost:8000/health >/dev/null && break
  kill -0 "$BACKEND_PID" 2>/dev/null || { echo; echo "backend crashed, see $LOGS/backend.log"; exit 1; }
  echo -n .; sleep 0.5
done
echo

# 4. Warm models, then open the app
echo "warming models (first time can take a minute)..."
curl -s -X POST localhost:8000/warmup >/dev/null
sleep 2
kill -0 "$GAZE_PID" 2>/dev/null || echo "WARNING: the eye tracker stopped, see $LOGS/gaze.log (camera permission? try --camera 1)"

# 5. Open in a Chromium-based browser (tab audio + AudioWorklet need it; Firefox can't share tab audio)
opened=0
for b in google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge; do
  if command -v "$b" >/dev/null 2>&1; then "$b" --new-window "$URL" >/dev/null 2>&1 & opened=1; break; fi
done
if [ "$opened" = 0 ]; then
  if [ "$(uname)" = "Darwin" ] && open -Ra "Google Chrome" 2>/dev/null; then open -a "Google Chrome" "$URL"
  elif command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
  else echo "open $URL"; fi
  echo "NOTE: Chrome/Chromium not found; opened in the default browser. Tab-audio mode needs Chrome."
fi

echo "Blink is running at $URL"
echo "Logs in $LOGS/.  Ctrl+C to stop."
wait
