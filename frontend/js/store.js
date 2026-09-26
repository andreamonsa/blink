/**
 * Session-wide missed transcript (memory only).
 */

import { buildRawText, dedupeWords } from "./missed-selector.js";

export class MissedStore {
  constructor(sessionId = "default") {
    this.sessionId = sessionId;
    this.startedAtMs = 0;
    this.windows = [];
    this._listeners = new Set();
  }

  onMissedWindow(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  addWindow(record) {
    if (!record || !record.raw_text) return null;

    const overlapping = this.windows.filter(
      (w) => record.start_ms <= w.end_ms && w.start_ms <= record.end_ms
    );
    let merged = record;
    if (overlapping.length > 0) {
      this.windows = this.windows.filter((w) => !overlapping.includes(w));
      merged = mergeWindows([...overlapping, record]);
    }

    this.windows.push(merged);
    this.windows.sort((a, b) => a.start_ms - b.start_ms);

    for (const listener of this._listeners) {
      try {
        listener(merged, this.getSessionMissed());
      } catch (err) {
        console.warn("missed-window listener threw:", err);
      }
    }
    return merged;
  }

  getSessionMissed() {
    const sentences = this.windows
      .flatMap((w) => w.items ?? [])
      .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);

    return {
      session_id: this.sessionId,
      started_at_ms: this.startedAtMs,
      windows: this.windows,
      sentences,
      raw_text: this.windows.map((w) => w.raw_text).filter(Boolean).join("\n"),
    };
  }

  get windowCount() {
    return this.windows.length;
  }

  reset(sessionId = this.sessionId, startedAtMs = 0) {
    this.sessionId = sessionId;
    this.startedAtMs = startedAtMs;
    this.windows = [];
  }
}

export function mergeWindows(windows) {
  const sorted = [...windows].sort((a, b) => a.start_ms - b.start_ms);
  const words = dedupeWords(sorted.flatMap((w) => w.words ?? []));

  const seen = new Set();
  const items = sorted
    .flatMap((w) => w.items ?? [])
    .filter((item) => {
      const key = `${item.start_ms}|${item.end_ms}|${item.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);

  return {
    start_ms: Math.min(...sorted.map((w) => w.start_ms)),
    end_ms: Math.max(...sorted.map((w) => w.end_ms)),
    raw_text: words.length
      ? buildRawText(words)
      : sorted.map((w) => w.raw_text).filter(Boolean).join(" "),
    items,
    words,
    classifier_ok: sorted.every((w) => w.classifier_ok !== false),
  };
}
