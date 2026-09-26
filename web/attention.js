// "Someone said your name": watches the live transcript for the student's name
// and pulls their attention back to the screen.
//
//   * glow   — a slowly pulsing gradient around the screen edges, aimed at
//              peripheral vision. Only when the student is NOT looking at the
//              screen as the name comes in; stops as soon as they look back.
//   * notice — a notification with what was said. Always shown; stays until
//              dismissed or for 30 seconds.
//
// "Not looking" is checked when the line reaches the page, not when it was
// spoken: live speech-to-text lags a few seconds, and what matters is whether
// the student can see the screen right now.
//
// Listens to the "blink:line" / "blink:zone" events that app.js dispatches.
// Other sources (e.g. a summarizer tag) can trigger it with Blink.callAttention().
(function () {
  const NAME_KEY = "blink.studentName";
  const NOTICE_MS = 30000;
  const MAX_GLOW_MS = NOTICE_MS; // safety net if the eye tracker never reports back

  const $ = (sel) => document.querySelector(sel);
  const nameInput = $("#student-name");
  const namePill = $("#name-pill");
  const glow = $("#attention-glow");
  const notice = $("#attention-notice");
  const noticeTime = notice.querySelector(".notice-time");
  const noticeQuote = notice.querySelector(".notice-quote");

  // ---------------------------------------------------------------- name
  const fold = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  let names = [];

  function readNames() {
    // "Andrea, Andy" -> ["andrea", "andy"]; nicknames are common in class
    names = nameInput.value.split(",").map((n) => fold(n.trim())).filter((n) => n.length >= 2);
    namePill.classList.toggle("is-empty", names.length === 0);
  }
  try { nameInput.value = localStorage.getItem(NAME_KEY) || ""; } catch {}
  readNames();
  nameInput.addEventListener("input", () => {
    try { localStorage.setItem(NAME_KEY, nameInput.value.trim()); } catch {}
    readNames();
  });
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "Escape") nameInput.blur(); });

  // Pressing start without a name: point at the name box (but don't block).
  $("#btn-start").addEventListener("click", () => {
    if (names.length) return;
    namePill.classList.remove("nudge");
    void namePill.offsetWidth;
    namePill.classList.add("nudge");
    nameInput.focus();
  });

  // ------------------------------------------------------------ matching
  // Speech-to-text often misspells names, so names of 5+ letters also match
  // with one letter off ("Andreia" -> "Andrea"). Shorter names must be exact.
  function oneEditAway(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++;
      else if (a.length < b.length) j++;
      else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }

  function isName(word) {
    const w = fold(word);
    return names.some((n) => w === n || (n.length >= 5 && oneEditAway(w, n)));
  }

  const WORD = /[\p{L}\p{M}'’-]+/gu;
  const mentionsName = (text) => (text.match(WORD) || []).some(isName);

  // Wrap the name in <mark> once the line is final (earlier, app.js rewrites the text).
  function markName(lineEl) {
    const host = lineEl.querySelector(".line-text");
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest(".katex, mark") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const parts = node.textContent.split(/([\p{L}\p{M}'’-]+)/u);
      if (!parts.some((p, i) => i % 2 && isName(p))) continue;
      node.replaceWith(...parts.map((p, i) => (i % 2 && isName(p) ? Object.assign(document.createElement("mark"), { className: "name-hit", textContent: p }) : p)));
    }
  }

  // ------------------------------------------------------------- glow
  let zone = null;          // latest gaze zone: "panel" | "away" | null
  let glowTimer = null;

  function glowOn() {
    clearTimeout(glowTimer);
    glow.classList.remove("is-leaving");
    glow.classList.add("is-on");
    glowTimer = setTimeout(glowOff, MAX_GLOW_MS);
  }
  function glowOff() {
    clearTimeout(glowTimer);
    if (!glow.classList.contains("is-on")) return;
    glow.classList.add("is-leaving");
    glow.classList.remove("is-on");
  }

  document.addEventListener("blink:zone", (e) => {
    zone = e.detail.zone;
    if (zone === "panel") glowOff(); // they looked back: the notice takes over
  });

  // ------------------------------------------------------------ notice
  let noticeTimer = null;
  let current = null;       // { id, el } of the line that triggered the notice

  function showNotice(t, text) {
    noticeTime.textContent = new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setQuote(text);
    notice.hidden = false;
    notice.classList.remove("is-counting");
    void notice.offsetWidth; // restart the 30s progress bar
    notice.classList.add("is-counting");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(hideNotice, NOTICE_MS);
  }
  function setQuote(text) {
    noticeQuote.textContent = `“${text}”`;
    if (window.renderMathInElement) {
      renderMathInElement(noticeQuote, {
        delimiters: [{ left: "\\[", right: "\\]", display: false }, { left: "\\(", right: "\\)", display: false }],
        throwOnError: false,
      });
    }
  }
  function hideNotice() {
    clearTimeout(noticeTimer);
    notice.hidden = true;
    glowOff();
  }

  notice.querySelector(".notice-close").addEventListener("click", hideNotice);
  notice.querySelector(".notice-jump").addEventListener("click", () => {
    if (!current?.el?.isConnected) return;
    current.el.scrollIntoView({ behavior: "smooth", block: "center" });
    current.el.classList.remove("flash");
    void current.el.offsetWidth;
    current.el.classList.add("flash");
  });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !notice.hidden) hideNotice(); });

  // ------------------------------------------------------------ trigger
  function callAttention({ id = null, t = Date.now(), text = "", el = null } = {}) {
    current = { id, el };
    el?.classList.add("called");
    if (zone !== "panel") glowOn(); // looking at the screen already: the notice is enough
    showNotice(t, text);
  }

  const alerted = new Set(); // line ids that already triggered

  document.addEventListener("blink:line", (e) => {
    const { id, t, text, final, el } = e.detail;
    if (current?.id === id) {                    // keep the quote in sync while it's spoken
      setQuote(text);
      if (final) markName(el);
      return;
    }
    if (alerted.has(id) || !names.length || !mentionsName(text)) return;
    alerted.add(id);                              // fire on the interim text: as soon as the name is heard
    callAttention({ id, t, text, el });
    if (final) markName(el);
  });

  window.Blink = window.Blink || {};
  Blink.callAttention = callAttention;
})();
