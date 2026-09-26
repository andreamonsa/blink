#!/usr/bin/env bash
# Blink — one-command launcher. Ctrl+C stops everything.
cd "$(dirname "$0")"
PY=.venv/bin/python
URL="http://127.0.0.1:8000/?source=python&audio=mic"
LOGS=.logs; mkdir -p "$LOGS"

cleanup() { echo; echo "stopping..."; kill $(jobs -p) 2>/dev/null; wait 2>/dev/null; }
trap cleanup EXIT INT TERM

# 1. Ollama (skip if already running as a service)
if ! curl -s localhost:11434 >/dev/null; then
  ollama serve >"$LOGS/ollama.log" 2>&1 &
  until curl -s localhost:11434 >/dev/null; do sleep 0.5; done
fi
ollama list | grep -q "${SUMMARIZER_MODEL:-qwen2.5:3b-instruct-q5_K_M}" \
  || ollama pull "${SUMMARIZER_MODEL:-qwen2.5:3b-instruct-q5_K_M}"

# 2. Eye tracker
$PY gaze.py run --no-preview >"$LOGS/gaze.log" 2>&1 &

# 3. Backend + UI
$PY -m uvicorn backend.app:app --port 8000 >"$LOGS/backend.log" 2>&1 &
echo -n "starting backend"
until curl -s localhost:8000/health >/dev/null; do echo -n .; sleep 0.5; done
echo

# 4. Warm models, then open the app
echo "warming models (first time can take a minute)..."
curl -s -X POST localhost:8000/warmup >/dev/null
xdg-open "$URL" >/dev/null 2>&1 || echo "open $URL"

echo "Blink is running.  Logs in $LOGS/.  Ctrl+C to stop."
wait
