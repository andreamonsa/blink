// Keeps text sitting on the ruled lines of the paper background.
// Purely visual: load it after app.js; remove it and the app still works.
//
// A container opts in by defining two CSS custom properties:
//   --lh      distance between rules (and the text line-height), e.g. 44px
//   --rule-y  where the first rule is drawn, from the top of the padding box
// and optionally --baseline-lift (default 3px): how far above the rule the
// text baseline sits, like handwriting resting on the line.
//
// For every text block in the container we
//   1. round its height up to a whole number of rules, so the next block
//      starts on the grid even after a tall formula;
//   2. nudge it (position: relative; top) so its first baseline lands on a rule.
// Different font sizes (timestamps, labels, headings) all end up on the lines.
(function () {
  const GROUPS = [
    { root: "#transcript", blocks: ":scope > .line, :scope > .marker, :scope > .empty", text: ".line-text" },
    {
      root: "#catchup-current",
      blocks: ":scope > .cu-title, :scope > .cu-meta, :scope > .muted, .cu-section h3, .cu-section li, .cu-section > p, .verbatim > summary, .verbatim-line",
    },
  ];

  const num = (el, name, fallback) => {
    const v = parseFloat(getComputedStyle(el).getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };

  function align({ root: sel, blocks: blockSel, text }) {
    const root = document.querySelector(sel);
    if (!root) return;
    const lh = num(root, "--lh", 0);
    if (!lh) return;
    const target = num(root, "--rule-y", 0) - num(root, "--baseline-lift", 3);
    const blocks = [...root.querySelectorAll(blockSel)].filter((b) => b.offsetParent !== null);
    // Snapping can add a few px below the fold; keep following the live line.
    const atBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 80;

    // 1. snap heights (reset first so shrinking content can shrink again)
    for (const b of blocks) { b.style.minHeight = ""; b.style.top = ""; b.style.position = "relative"; }
    const heights = blocks.map((b) => b.offsetHeight);
    blocks.forEach((b, i) => {
      const snapped = Math.max(1, Math.ceil((heights[i] - 0.5) / lh)) * lh;
      if (snapped !== heights[i]) b.style.minHeight = `${snapped}px`;
    });

    // 2. measure every first baseline with a zero-size probe (batched writes, then reads)
    const probes = blocks.map((b) => {
      const host = (text && b.querySelector(text)) || b;
      const probe = document.createElement("span");
      probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
      host.prepend(probe);
      return probe;
    });
    const r = root.getBoundingClientRect();
    const originY = r.top + root.clientTop - root.scrollTop; // top of the scrolled padding box
    const ys = probes.map((p) => p.getBoundingClientRect().top - originY);
    probes.forEach((p) => p.remove());

    // 3. nudge each block so baseline ≡ target (mod lh), by the smallest amount
    blocks.forEach((b, i) => {
      let d = (((target - ys[i]) % lh) + lh) % lh;
      if (d > lh / 2) d -= lh;
      if (Math.abs(d) > 0.4) b.style.top = `${d.toFixed(2)}px`;
    });
    if (atBottom && root.scrollHeight > root.clientHeight) root.scrollTop = root.scrollHeight;
  }

  let queued = false;
  const observer = new MutationObserver(schedule);
  function run() {
    queued = false;
    GROUPS.forEach(align);
    observer.takeRecords(); // ignore the probe insertions we just made
  }
  function schedule() {
    if (!queued) { queued = true; requestAnimationFrame(run); }
  }

  function start() {
    for (const { root } of GROUPS) {
      const el = document.querySelector(root);
      if (!el) continue;
      observer.observe(el, { childList: true, subtree: true, characterData: true });
      el.addEventListener("toggle", schedule, true); // <details> opening
    }
    addEventListener("resize", schedule);
    document.fonts?.ready.then(schedule);
    document.fonts?.addEventListener?.("loadingdone", schedule);
    addEventListener("load", schedule);
    schedule();
  }
  start();
})();
