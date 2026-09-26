// Data sources for the web app. app.js only talks to Blink.sources, so swapping
// a mock for a teammate's real module is a change in THIS file only.
//
//   ?source=mock    (default) scripted lecture + hold Space to "look away"
//   ?source=python  gaze from Zachary's `python gaze.py run` (ws://localhost:8765)
//                   + real speech-to-text of the lecture tab + real summarizer.
//                   Serve this page from the STT backend (uvicorn backend.app:app).
//   &gaze=ws://host:port   override the gaze WebSocket URL
//
// Interfaces app.js expects:
//   gaze.connect({ onZone, onStatus })
//       onZone(msg, { sync })  msg is gaze.py's message verbatim:
//         { type: "zone", zone: "panel" | "away", t: <epoch ms>, since?: <epoch ms> }
//         `since` comes with zone "panel": summarise the transcript from `since` to `t`.
//         sync = true for the snapshot gaze.py sends on connect (not a real transition).
//       onStatus("mock" | "connecting" | "connected" | "offline")
//   transcript.start(onLine) / transcript.stop()
//       onLine({ id, t: <epoch ms>, text, final })   same id = update of the same line
//   summarizer.summarize({ text, lines, from, to }) -> Promise<{ summary, priorities? }>
//       summary: string (summarizer.py returns prose) or string[] (bullets)
//       priorities: string[] (optional; section is hidden when missing)
window.Blink = window.Blink || {};

(function () {
  const params = new URLSearchParams(location.search);
  const SOURCE = params.get("source") || "mock";
  const GAZE_URL = params.get("gaze") || "ws://localhost:8765"; // gaze.py run --port default

  // ------------------------------------------------------------ gaze (real)
  // Zachary's gaze.py is the WebSocket server; we are a client. Reconnects
  // every 2s so the page can be opened before the tracker is running.
  function pythonGaze({ onZone, onStatus }) {
    let firstMessage = true;
    function connect() {
      onStatus("connecting");
      const ws = new WebSocket(GAZE_URL);
      ws.onopen = () => { firstMessage = true; onStatus("connected"); };
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type !== "zone") return;
        onZone(msg, { sync: firstMessage });
        firstMessage = false;
      };
      ws.onclose = () => { onStatus("offline"); setTimeout(connect, 2000); };
    }
    connect();
  }

  // ------------------------------------------------------------ gaze (mock)
  // Hold Space = looking away. Emits the same messages gaze.py would.
  function mockGaze({ onZone, onStatus }) {
    let awaySince = null;
    onStatus("mock");
    onZone({ type: "zone", zone: "panel", t: Date.now() }, { sync: true });

    const leave = () => {
      if (awaySince !== null) return;
      awaySince = Date.now();
      onZone({ type: "zone", zone: "away", t: awaySince }, { sync: false });
    };
    const back = () => {
      if (awaySince === null) return;
      onZone({ type: "zone", zone: "panel", t: Date.now(), since: awaySince }, { sync: false });
      awaySince = null;
    };
    // Space works even when a button has focus (preventDefault stops it from
    // clicking start/stop); only text fields keep their normal Space.
    const isSpace = (e) => e.code === "Space" && !e.target.closest?.("input, textarea, [contenteditable]");
    addEventListener("keydown", (e) => { if (isSpace(e)) { e.preventDefault(); leave(); } });
    addEventListener("keyup", (e) => { if (isSpace(e)) { e.preventDefault(); back(); } });
    addEventListener("blur", back);
  }

  // ------------------------------------------------------ transcript (mock)
  // Plays Blink.MOCK_LECTURE word by word (interim updates, then final),
  // like a streaming speech-to-text would.
  // TODO(Mattia): replace with the real speech-to-text feed once it's in the repo.
  const mockMeta = new Map(); // line id -> script entry (used by the mock summarizer)

  function mockTranscript() {
    let index = 0, timer = null, onLine = null, nextId = 1;
    let current = null; // the line being "spoken": { id, t, words, n }

    function emit(final) {
      onLine({ id: current.id, t: current.t, text: current.words.slice(0, current.n).join(" "), final });
      if (final) { current = null; index += 1; }
    }

    function tick() {
      current.n += 1;
      if (current.n >= current.words.length) { emit(true); playLine(); }
      else { emit(false); timer = setTimeout(tick, 170); }
    }

    function playLine() {
      const entry = Blink.MOCK_LECTURE[index];
      if (!entry) { timer = null; return; }
      timer = setTimeout(() => {
        current = { id: nextId++, t: Date.now(), words: entry.text.split(" "), n: 0 };
        mockMeta.set(current.id, entry);
        tick();
      }, entry.after * 1000);
    }

    return {
      start(cb) { onLine = cb; if (!timer) playLine(); },
      // Like a real recognizer: whatever was heard so far becomes final.
      stop() {
        clearTimeout(timer); timer = null;
        if (current) emit(true);
      },
    };
  }

  // ------------------------------------------------------ summarizer (mock)
  // TODO(Louis): summarizer.py's summarize(text, max_words) is a Python function;
  // it needs a small HTTP/WebSocket bridge before the browser can call it.
  function mockSummarizer() {
    return {
      summarize({ lines }) {
        const entries = lines.map((l) => mockMeta.get(l.id)).filter(Boolean);
        const priorities = entries.filter((e) => e.priority).map((e) => e.priority);
        const summary = entries.filter((e) => e.gist).map((e) => e.gist);
        return new Promise((resolve) =>
          setTimeout(() => resolve({ priorities, summary }), 900));
      },
    };
  }

  // ------------------------------------------------- transcript (real, Mattia)
  // Tab audio -> faster-whisper -> exact missed-word selection -> Laya tags.
  // Emits ONLY lines spoken while the student was away: attended speech is
  // never transcribed or stored (CLAUDE.md's invariant), so the transcript
  // fills in when they look back rather than streaming the whole lecture.
  //
  // The module is an ES module loaded from the STT backend. Importing it now,
  // at page load, keeps start() inside the Start click: tab capture needs that
  // user gesture, and an import started inside the click could outlive it.
  const realSource = SOURCE === "python"
    ? import("/js/silentspecs-source.js").then((m) =>
        m.createSilentSpecsSource({ gazeUrl: GAZE_URL }))
    : null;

  function realTranscript() {
    return {
      async start(onLine) { (await realSource).start(onLine).catch(reportStartError); },
      async stop() { (await realSource).stop(); },
      // app.js awaits this before building a gaze catch-up card, so the card
      // finds the recovered lines instead of rendering before they exist.
      async waitForWindow(from, to) { return (await realSource).waitForWindow(from, to); },
    };
  }

  function reportStartError(err) {
    console.error("speech-to-text failed to start", err);
    alert("Couldn't capture the lecture audio.\n\n" +
          'In the share dialog pick the lecture\'s Chrome tab and tick "Also share tab audio".' +
          "\n\n(" + err.message + ")");
  }

  // ------------------------------------------------- summarizer (real, Louis)
  // summarizer.py runs inside the STT backend (backend/summarizer_bridge.py).
  // We send a *range*, never text: the backend reads the missed windows from
  // its own store, so nothing but missed speech can reach the LLM.
  // Priorities come from the Laya tags, so they still work if Ollama is down.
  function realSummarizer() {
    return {
      async summarize({ lines }) {
        const src = await realSource;
        const range = src.rangeFor(lines.map((l) => l.id));
        if (!range) return { summary: null, priorities: [] };
        const res = await fetch(`/session/${src.sessionId}/summarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(range),
        });
        if (!res.ok) throw new Error(`summarize ${res.status}`);
        const { summary, priorities } = await res.json();
        return { summary, priorities };
      },
    };
  }

  const REAL = SOURCE === "python";
  Blink.sources = {
    mode: SOURCE,
    gazeUrl: GAZE_URL,
    gaze: { connect: REAL ? pythonGaze : mockGaze },
    transcript: REAL ? realTranscript() : mockTranscript(),
    summarizer: REAL ? realSummarizer() : mockSummarizer(),
  };
})();
