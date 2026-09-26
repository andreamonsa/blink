// Data sources for the web app. app.js only talks to Blink.sources, so swapping
// a mock for a teammate's real module is a change in THIS file only.
//
//   ?source=mock    (default) scripted lecture + hold Space to "look away"
//   ?source=python  gaze from Zachary's `python gaze.py run` (ws://localhost:8765)
//                   + real speech-to-text of the lecture tab + real summarizer.
//                   Serve this page from the STT backend (uvicorn backend.app:app).
//   &gaze=ws://host:port   override the gaze WebSocket URL
//   &live=0         with ?source=python: no live transcript. Only what was missed
//                   is transcribed, when you look back (attended speech never is).
//   &audio=mic      with ?source=python: listen to the microphone (lecture in
//                   the room) instead of a Chrome tab (online lecture)
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
  const AUDIO = params.get("audio") === "mic" ? "mic" : "tab";
  // Live transcript of the whole lecture is on by default; &live=0 is the
  // strict mode where only what was missed is ever transcribed.
  const LIVE = params.get("live") !== "0";

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
  // Troubleshooting overlays (microphone picker, audio status badge) only with
  // &debug=1, so the student's screen stays clean. Without the picker the
  // browser's default microphone is used.
  const DEBUG = params.get("debug") === "1";
  const micPicker = DEBUG && SOURCE === "python" && AUDIO === "mic" ? createMicPicker() : null;

  const realSource = SOURCE === "python"
    ? import("/js/silentspecs-source.js").then((m) =>
        m.createSilentSpecsSource({
          gazeUrl: GAZE_URL, audioSource: AUDIO, live: LIVE,
          getMicDeviceId: () => micPicker?.getId() ?? null,
        }))
    : null;

  // ------------------------------------------------------------ microphone picker
  // For a lecture in the room: choose which microphone to listen with, for
  // example an external USB microphone. Chrome only reveals device names after
  // the page has been given microphone permission once, hence the button.
  // &mic=<part of a device name> pre-selects a device, e.g. &mic=usb.
  function createMicPicker() {
    const KEY = "silentspecs.micDeviceId";
    const wanted = (params.get("mic") || "").toLowerCase();
    let running = false;

    const box = document.createElement("div");
    box.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:9999;width:300px;" +
      "padding:9px 12px;border-radius:8px;font:12px/1.45 ui-monospace,Menlo,monospace;" +
      "background:#1c1c1c;color:#eee;box-shadow:0 2px 10px rgba(0,0,0,.35)";
    const title = document.createElement("div");
    title.textContent = "\u{1F399} Microfono";
    const select = document.createElement("select");
    select.style.cssText = "display:none;width:100%;margin-top:5px;font:inherit";
    const ask = document.createElement("button");
    ask.textContent = "Consenti il microfono per sceglierlo";
    ask.style.cssText = "margin-top:5px;font:inherit;cursor:pointer";
    const probe = document.createElement("button");
    probe.textContent = "Prova i microfoni (parla adesso)";
    probe.style.cssText = "display:none;margin-top:5px;font:inherit;cursor:pointer";
    const note = document.createElement("div");
    note.style.cssText = "margin-top:4px;color:#fc6;white-space:pre-line";
    box.append(title, select, ask, probe, note);
    const levels = new Map();   // deviceId -> text shown next to its name
    document.body.appendChild(box);

    async function refresh() {
      let devices = [];
      try {
        devices = (await navigator.mediaDevices.enumerateDevices())
          .filter((d) => d.kind === "audioinput" && d.deviceId !== "communications");
      } catch { /* leave the picker on its permission button */ }
      const named = devices.filter((d) => d.label);
      if (!named.length) { select.style.display = "none"; ask.style.display = ""; return; }

      const previous = select.value || localStorage.getItem(KEY) || "default";
      select.replaceChildren(...named.map((d) => {
        const o = document.createElement("option");
        o.value = d.deviceId; o.textContent = d.label + (levels.get(d.deviceId) || "");
        return o;
      }));
      const byName = wanted && named.find((d) => d.label.toLowerCase().includes(wanted));
      const chosen = byName ? byName.deviceId
        : named.some((d) => d.deviceId === previous) ? previous : "default";
      select.value = named.some((d) => d.deviceId === chosen) ? chosen : named[0].deviceId;
      select.style.display = ""; ask.style.display = "none"; probe.style.display = "";
    }

    /** Peak level of one microphone over ~2.4 s, or null if it will not open. */
    async function measure(deviceId) {
      const processing = { echoCancellation: false, noiseSuppression: false, autoGainControl: true };
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId && deviceId !== "default" ? { ...processing, deviceId: { exact: deviceId } } : processing,
        });
      } catch { return null; }
      const ctx = new AudioContext();
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      const an = ctx.createAnalyser();
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      let peak = 0;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 80));
        an.getFloatTimeDomainData(buf);
        for (const v of buf) { const a = Math.abs(v); if (a > peak) peak = a; }
      }
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
      return peak;
    }

    probe.onclick = async () => {
      if (running) { note.textContent = "Ferma la sessione prima di provare i microfoni."; return; }
      const ids = [...select.options].map((o) => o.value);
      probe.disabled = true;
      let best = null;
      for (let i = 0; i < ids.length; i++) {
        note.textContent = "Parla ora, provo il microfono " + (i + 1) + " di " + ids.length + "…";
        const peak = await measure(ids[i]);
        levels.set(ids[i], peak === null ? " — non si apre"
          : peak < 0.005 ? " — silenzio" : " — sente (livello " + peak.toFixed(2) + ")");
        if (peak !== null && peak >= 0.005 && (!best || peak > best.peak)) best = { id: ids[i], peak };
      }
      probe.disabled = false;
      const keep = select.value;
      await refresh();
      if (best) {
        select.value = best.id; localStorage.setItem(KEY, best.id);
        note.textContent = "Scelto il microfono che sente meglio. Ora premi Start.";
      } else {
        select.value = keep;
        note.textContent = "Nessun microfono manda audio.\nmacOS: Impostazioni di Sistema > Privacy e sicurezza >\nMicrofono > attiva Google Chrome, poi riavvia Chrome.";
      }
    };

    ask.onclick = async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());   // only to unlock the device names
      } catch (err) { note.textContent = "Permesso negato: " + err.message; return; }
      note.textContent = ""; refresh();
    };
    select.onchange = () => {
      localStorage.setItem(KEY, select.value);
      note.textContent = running ? "Vale dal prossimo Start." : "";
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    refresh();

    return {
      getId: () => (select.style.display === "none" || select.value === "default" ? null : select.value),
      setRunning(on) { running = on; if (on) note.textContent = ""; },
    };
  }

  // ------------------------------------------------------- audio status badge
  // Says, in plain words, whether the lecture audio is really arriving. Without
  // it "nothing appears" can mean a muted mic, the wrong device, or just the
  // few seconds the first slice takes.
  let badge = null, badgeTimer = null, badgeSince = 0;

  function showBadge(src) {
    hideBadge();
    badgeSince = Date.now();
    badge = document.createElement("div");
    badge.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:9999;max-width:340px;" +
      "padding:9px 12px;border-radius:8px;font:12px/1.45 ui-monospace,Menlo,monospace;" +
      "background:#1c1c1c;color:#eee;box-shadow:0 2px 10px rgba(0,0,0,.35);white-space:pre-line";
    document.body.appendChild(badge);
    const paint = () => {
      const h = src.health();
      const secs = Math.round((Date.now() - badgeSince) / 1000);
      let color = "#8f8", line1, line2 = "";
      if (!h.receiving) {
        color = "#fc6"; line1 = "In attesa dell'audio dal browser…";
        if (secs > 4) line1 += AUDIO === "mic"
          ? "\nHai dato il permesso al microfono a questa pagina?"
          : "\nHai scelto una scheda e spuntato \"Condividi anche l'audio\"?";
      } else if (h.silentFraction > 0.99) {
        color = "#f88"; line1 = "SILENZIO: nessun audio dalla lezione.";
        line2 = AUDIO === "mic"
          ? "Controlla il microfono scelto da Chrome (icona 🎙 nella barra) e che non sia disattivato."
          : "La lezione sta suonando (non in muto)? Altrimenti premi Stop, poi Start e spunta \"Condividi anche l'audio\".";
      } else if (!h.audible) {
        color = "#fc6"; line1 = AUDIO === "mic"
          ? "Audio quasi assente: parla piu' forte o avvicinati."
          : "Audio quasi assente: la lezione e' in pausa o a volume zero?";
      } else {
        line1 = "Audio ok";
      }
      const bar = "\u2588".repeat(Math.min(12, Math.round((h.lastLevel ?? 0) * 40))).padEnd(12, "\u00b7");

      const live = h.live;
      const liveLine = !live ? "" : live.slices === 0
        ? `\nPrimo testo tra ~${Math.max(0, 7 - secs)} s (trascrive a blocchi di ${h.chunkMs / 1000} s)`
        : `\nBlocchi trascritti: ${live.slices} · parole: ${live.words} · ultimo: ${live.lastWords} parole` +
          (live.lastWords === 0 ? " (nessun parlato rilevato)" : "") + (live.errors ? ` · errori: ${live.errors}` : "");
      badge.style.color = color;
      badge.textContent = `\u{1F399} ${h.device || "?"}\n${bar} livello ${(h.peakLevel ?? 0).toFixed(3)}\n${line1}${line2 ? "\n" + line2 : ""}${liveLine}`;


    };
    paint();
    badgeTimer = setInterval(paint, 500);
  }

  function hideBadge() {
    clearInterval(badgeTimer);
    if (badge) badge.remove();
    badge = null;
  }

  function realTranscript() {
    return {
      async start(onLine) {
        const src = await realSource;
        micPicker?.setRunning(true);
        src.start(onLine).then(() => { if (DEBUG) showBadge(src); }).catch(reportStartError);
      },
      async stop() { hideBadge(); micPicker?.setRunning(false); (await realSource).stop(); },
      // app.js awaits this before building a gaze catch-up card, so the card
      // finds the recovered lines instead of rendering before they exist.
      async waitForWindow(from, to) { return (await realSource).waitForWindow(from, to); },
    };
  }

  function reportStartError(err) {
    console.error("speech-to-text failed to start", err);
    const hint = AUDIO === "mic"
      ? "Allow microphone access for this page (address bar -> site settings)."
      : 'In the share dialog pick the lecture\'s Chrome tab and tick "Also share tab audio".';
    alert("Couldn't capture the lecture audio.\n\n" + hint + "\n\n(" + err.message + ")");
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
