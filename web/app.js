// Blink web app: live transcript (left), catch-up card + history (right),
// start/stop + manual summary buttons. All data comes from Blink.sources.
(function () {
  const { gaze, transcript, summarizer, mode, gazeUrl } = Blink.sources;
  const $ = (sel) => document.querySelector(sel);
  const el = {
    transcript: $("#transcript"),
    empty: $("#transcript-empty"),
    jumpLive: $("#jump-live"),
    start: $("#btn-start"),
    summary: $("#btn-summary"),
    current: $("#catchup-current"),
    pastTitle: $("#past-title"),
    past: $("#past-list"),
    livePill: $("#live-pill"),
    gazePill: $("#gaze-pill"),
    hint: $("#hint"),
  };

  const state = {
    recording: false,
    lines: new Map(),        // id -> { id, t, tEnd, text, final, el }
    zone: null,              // "panel" | "away" | null (unknown)
    awayFrom: null,          // epoch ms when the current away period started
    gazeStatus: null,
    lastCatchupAt: null,     // manual summary covers lastCatchupAt -> now
    current: null,           // current catch-up
    past: [],                // older catch-ups, newest first
  };
  let catchupSeq = 0;

  // ------------------------------------------------------------- helpers
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const clockShort = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const duration = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) node.append(c);
    return node;
  }

  // Text is always inserted as textContent first, then KaTeX typesets the
  // delimited math in place, so transcript text can never inject HTML.
  function renderMath(node) {
    if (!window.renderMathInElement) return;
    renderMathInElement(node, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false },
        // single $...$ left out on purpose: "it costs $5 or $10" would become math
      ],
      throwOnError: false,
    });
  }

  // ---------------------------------------------------------- transcript
  const nearBottom = () =>
    el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight < 80;

  function withFollow(mutate) {
    const follow = nearBottom();
    mutate();
    if (follow) el.transcript.scrollTop = el.transcript.scrollHeight;
    else el.jumpLive.hidden = false;
  }

  el.transcript.addEventListener("scroll", () => { if (nearBottom()) el.jumpLive.hidden = true; });
  el.jumpLive.addEventListener("click", () => {
    el.transcript.scrollTo({ top: el.transcript.scrollHeight, behavior: "smooth" });
    el.jumpLive.hidden = true;
  });

  function onLine({ id, t, text, final, missed }) {
    el.empty.hidden = true;
    withFollow(() => {
      let line = state.lines.get(id);
      if (!line) {
        const body = h("span", { class: "line-text" });
        line = { id, t, el: h("p", { class: "line", "data-id": id }, h("time", { class: "line-time" }, clock(t)), body) };
        state.lines.set(id, line);
        el.transcript.append(line.el);
      }
      line.text = text;
      line.final = final;
      line.tEnd = Date.now();
      const body = line.el.querySelector(".line-text");
      body.textContent = text;
      line.el.classList.toggle("interim", !final);
      // A source that knows when each line was spoken says so with `missed`.
      // Otherwise (the mock) fall back to whether we are away as it arrives,
      // which is wrong for a source whose text lags the speech.
      if (missed === true || (missed === undefined && state.zone === "away")) line.el.classList.add("missed");
      // Safe on interim text too: auto-render only typesets closed \( \) pairs
      // and leaves a half-spoken formula as plain text until it's complete.
      renderMath(body);
    });
  }

  function marker(kind, text) {
    if (!state.recording) return;
    withFollow(() => el.transcript.append(h("div", { class: `marker marker-${kind}` }, text)));
  }

  function jumpToLine(id) {
    const line = state.lines.get(id);
    if (!line) return;
    line.el.scrollIntoView({ behavior: "smooth", block: "center" });
    line.el.classList.remove("flash");
    void line.el.offsetWidth; // restart the animation
    line.el.classList.add("flash");
  }

  // ---------------------------------------------------------------- gaze
  function onZone(msg, { sync }) {
    const prev = state.zone;
    state.zone = msg.zone;

    if (sync || prev === null || prev === msg.zone) {
      // Snapshot on (re)connect: adopt the state, don't fire a catch-up.
      state.awayFrom = msg.zone === "away" ? (msg.since ?? msg.t) : null;
    } else if (msg.zone === "away") {
      state.awayFrom = msg.t;
      marker("away", `You looked away · ${clock(msg.t)}`);
    } else {
      const from = msg.since ?? state.awayFrom ?? msg.t;
      state.awayFrom = null;
      marker("back", `Back · away for ${duration(msg.t - from)}`);
      createCatchup(from, msg.t, "gaze");
    }
    renderGazePill();
  }

  function onGazeStatus(status) {
    state.gazeStatus = status;
    renderGazePill();
  }

  let awayTicker = null;
  function renderGazePill() {
    const p = el.gazePill;
    clearInterval(awayTicker);
    p.className = "pill";
    if (state.gazeStatus === "connecting" || state.gazeStatus === "offline") {
      p.textContent = state.gazeStatus === "offline" ? "Eye tracker offline" : "Connecting eye tracker…";
      p.classList.add("pill-warn");
      p.title = `Waiting for gaze.py on ${gazeUrl}`;
      return;
    }
    p.title = state.gazeStatus === "mock" ? "Demo mode: hold Space to simulate looking away" : gazeUrl;
    if (state.zone === "away") {
      p.classList.add("pill-away");
      const tick = () => { p.textContent = `Looking away ${state.awayFrom ? duration(Date.now() - state.awayFrom) : ""}`; };
      tick();
      awayTicker = setInterval(tick, 1000);
    } else if (state.zone === "panel") {
      p.classList.add("pill-ok");
      p.textContent = "Reading";
    } else {
      p.textContent = "Eye tracker ready";
    }
  }

  // ----------------------------------------------------------- catch-ups
  async function createCatchup(from, to, reason) {
    // Real speech-to-text arrives ~1 s after the return that triggers this
    // card. If the source can tell us, wait for this window and take exactly
    // its lines; otherwise (the mock) fall back to the time-overlap filter.
    const own = reason === "gaze" && transcript.waitForWindow
      ? await transcript.waitForWindow(from, to) : null;
    const lines = [...state.lines.values()].filter((l) =>
      l.final && (own ? own.has(l.id) : l.tEnd >= from && l.t <= to));
    if (!lines.length && reason === "gaze") return; // nothing was said, nothing to show

    const c = { id: ++catchupSeq, from, to, reason, lines, status: lines.length ? "loading" : "empty", result: null };
    if (state.current) state.past.unshift(state.current);
    state.current = c;
    state.lastCatchupAt = to;
    renderCatchups();
    if (!lines.length) return;

    try {
      const text = lines.map((l) => l.text).join(" ");
      c.result = await summarizer.summarize({ text, lines: lines.map(({ id, t, text }) => ({ id, t, text })), from, to });
      c.status = "ready";
    } catch (err) {
      console.error("summarizer failed", err);
      c.status = "error";
    }
    renderCatchups();
  }

  function manualCatchup() {
    const now = Date.now();
    const firstLine = state.lines.values().next().value;
    const from = state.lastCatchupAt ?? firstLine?.t ?? now;
    createCatchup(from, now, "manual");
  }

  function catchupMeta(c) {
    if (c.reason === "gaze") return `You looked away for ${duration(c.to - c.from)} · ${clockShort(c.from)}–${clockShort(c.to)}`;
    return `Since ${clock(c.from)} · ${duration(c.to - c.from)}`;
  }

  function list(items) {
    return h("ul", {}, items.map((txt) => h("li", {}, txt)));
  }

  function catchupBody(c) {
    const body = [];
    if (c.status === "empty") {
      body.push(h("p", { class: "muted" }, "Nothing new was said since your last catch-up."));
      return body;
    }
    if (c.status === "loading") {
      body.push(h("p", { class: "muted loading" }, `Summarizing ${c.lines.length} line${c.lines.length > 1 ? "s" : ""}…`));
      body.push(h("div", { class: "skeleton" }), h("div", { class: "skeleton short" }));
    }
    if (c.status === "error") {
      body.push(h("p", { class: "muted" }, "Couldn't summarize this part. Here's exactly what was said."));
    }
    if (c.status === "ready") {
      const { priorities = [], summary } = c.result || {};
      if (priorities.length) body.push(h("section", { class: "cu-section cu-priorities" }, h("h3", {}, "Priorities:"), list(priorities)));
      const missed = Array.isArray(summary) ? (summary.length ? list(summary) : null)
                   : summary ? h("p", {}, summary) : null;
      if (missed) body.push(h("section", { class: "cu-section" }, h("h3", {}, "What you missed:"), missed));
    }
    body.push(h("details", { class: "verbatim", open: c.status === "error" },
      h("summary", {}, `Exact words (${c.lines.length})`),
      h("ol", {}, c.lines.map((l) =>
        h("li", {}, h("button", { class: "verbatim-line", title: "Show in transcript", onclick: () => jumpToLine(l.id) },
          h("time", {}, clock(l.t)), " ", h("span", {}, l.text)))))));
    return body;
  }

  function renderCatchups() {
    const c = state.current;
    el.current.replaceChildren(
      h("h2", { class: "cu-title" }, "Catch Up Card"),
      ...(c
        ? [h("p", { class: "cu-meta" }, catchupMeta(c)), ...catchupBody(c)]
        : [h("p", { class: "muted" }, "When you look back at the screen, what you missed shows up here. You can also press summary.")]),
    );
    renderMath(el.current);

    el.pastTitle.hidden = state.past.length === 0;
    el.past.replaceChildren(...state.past.map((p) => {
      const node = h("details", { class: "past-card" },
        h("summary", {},
          h("span", { class: "past-icon", "aria-hidden": "true" }, "✦"),
          h("span", { class: "past-head" },
            h("span", { class: "past-when" }, clockShort(p.from)),
            h("span", { class: "past-meta" }, catchupMeta(p)))),
        h("div", { class: "past-body" }, catchupBody(p)));
      renderMath(node);
      return node;
    }));
  }

  // ------------------------------------------------------------ controls
  function setRecording(on) {
    state.recording = on;
    el.start.textContent = on ? "stop" : "start";
    el.start.setAttribute("aria-pressed", String(on));
    el.start.classList.toggle("is-live", on);
    el.livePill.textContent = on ? "● Live" : "Paused";
    el.livePill.classList.toggle("pill-live", on);
    if (on) {
      state.lastCatchupAt ??= Date.now();
      transcript.start(onLine);
    } else {
      transcript.stop();
    }
  }

  el.start.addEventListener("click", () => setRecording(!state.recording));
  el.summary.addEventListener("click", manualCatchup);

  // ---------------------------------------------------------------- boot
  el.hint.textContent = mode === "python"
    ? `Eye tracking from gaze.py (${gazeUrl}). Transcript: demo lecture.`
    : "Demo mode: hold Space to simulate looking away.";
  renderCatchups();
  gaze.connect({ onZone, onStatus: onGazeStatus });
  // KaTeX loads with `defer`; typeset anything rendered before it arrived.
  addEventListener("load", () => { renderMath(el.transcript); renderCatchups(); });
})();
