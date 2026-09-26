/** Session accumulation and the summarizer hand-off, mirroring tests/test_session_store.py. */
import test from "node:test";
import assert from "node:assert/strict";

import { MissedStore, mergeWindows } from "../../frontend/js/store.js";

const item = (text, start_ms, end_ms, kind = "ordinary_context", priority = 1) => ({
  start_ms, end_ms, text, kind, priority, show_by_default: kind !== "ordinary_context",
});
const record = (start_ms, end_ms, raw_text, items = [], words = []) => ({
  start_ms, end_ms, raw_text, items, words, classifier_ok: true,
});

test("windows accumulate in timeline order", () => {
  const store = new MissedStore("s1");
  store.addWindow(record(20000, 25000, "third", [item("third", 20000, 25000)]));
  store.addWindow(record(2000, 5000, "first", [item("first", 2000, 5000)]));
  store.addWindow(record(9000, 13000, "second", [item("second", 9000, 13000)]));

  const session = store.getSessionMissed();
  assert.deepEqual(session.windows.map((w) => w.start_ms), [2000, 9000, 20000]);
  assert.deepEqual(session.sentences.map((s) => s.text), ["first", "second", "third"]);
  assert.equal(session.raw_text, "first\nsecond\nthird");
  assert.equal(session.session_id, "s1");
});

test("flat sentences keep kind and priority for the summarizer", () => {
  const store = new MissedStore("s1");
  store.addWindow(record(2000, 5000, "Due Friday.",
    [item("Due Friday.", 2000, 5000, "instruction_change", 3)]));
  store.addWindow(record(9000, 12000, "What did you get?",
    [item("What did you get?", 9000, 12000, "question_to_you", 4)]));

  const s = store.getSessionMissed().sentences;
  assert.deepEqual(s.map((x) => x.kind), ["instruction_change", "question_to_you"]);
  assert.deepEqual(s.map((x) => x.priority), [3, 4]);
});

test("ordinary_context is collapsed but never deleted", () => {
  const store = new MissedStore();
  store.addWindow(record(2000, 5000, "Elasticity measures responsiveness.",
    [item("Elasticity measures responsiveness.", 2000, 5000)]));
  const session = store.getSessionMissed();
  assert.equal(session.sentences[0].show_by_default, false);
  assert.match(session.raw_text, /Elasticity/);
});

test("an empty record is not stored", () => {
  const store = new MissedStore();
  assert.equal(store.addWindow(record(0, 3000, "")), null);
  assert.equal(store.addWindow(null), null);
  assert.equal(store.windowCount, 0);
});

test("overlapping windows merge without duplicating a sentence", () => {
  const store = new MissedStore();
  const wordsA = [
    { start_ms: 2000, end_ms: 2400, text: "The" },
    { start_ms: 2400, end_ms: 3000, text: "assignment" },
    { start_ms: 3000, end_ms: 3600, text: "moved." },
  ];
  const wordsB = [
    { start_ms: 3000, end_ms: 3600, text: "moved." },
    { start_ms: 3600, end_ms: 4200, text: "Read" },
    { start_ms: 4200, end_ms: 4800, text: "chapter." },
  ];
  store.addWindow(record(2000, 3600, "The assignment moved.",
    [item("The assignment moved.", 2000, 3600, "instruction_change", 3)], wordsA));
  store.addWindow(record(3000, 4800, "moved. Read chapter.",
    [item("moved. Read chapter.", 3000, 4800, "instruction_change", 3)], wordsB));

  const session = store.getSessionMissed();
  assert.equal(session.windows.length, 1);
  assert.equal(session.windows[0].raw_text, "The assignment moved. Read chapter.");
  assert.equal((session.windows[0].raw_text.match(/moved\./g) ?? []).length, 1);
});

test("non-overlapping windows stay separate", () => {
  const store = new MissedStore();
  store.addWindow(record(2000, 4000, "a", [item("a", 2000, 4000)]));
  store.addWindow(record(9000, 11000, "b", [item("b", 9000, 11000)]));
  assert.equal(store.windowCount, 2);
});

test("listeners fire once per window and cannot break recovery", () => {
  const store = new MissedStore();
  const seen = [];
  store.onMissedWindow(() => { throw new Error("consumer exploded"); });
  const off = store.onMissedWindow((rec, session) => {
    seen.push([rec.raw_text, session.sentences.length]);
  });

  store.addWindow(record(2000, 4000, "one", [item("one", 2000, 4000)]));
  off();
  store.addWindow(record(9000, 11000, "two", [item("two", 9000, 11000)]));

  assert.deepEqual(seen, [["one", 1]], "unsubscribed listener must stop firing");
  assert.equal(store.windowCount, 2, "a throwing listener must not lose the window");
});

test("merge keeps a classifier failure visible", () => {
  const merged = mergeWindows([
    { ...record(2000, 4000, "a", [item("a", 2000, 4000)]), classifier_ok: true },
    { ...record(3000, 5000, "b", [item("b", 3000, 5000)]), classifier_ok: false },
  ]);
  assert.equal(merged.classifier_ok, false);
});

test("reset clears the session", () => {
  const store = new MissedStore("s1");
  store.addWindow(record(2000, 4000, "a", [item("a", 2000, 4000)]));
  store.reset("s2", 123);
  assert.equal(store.windowCount, 0);
  assert.equal(store.getSessionMissed().session_id, "s2");
  assert.equal(store.getSessionMissed().started_at_ms, 123);
});
