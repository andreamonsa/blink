/**
 * Frontend mirror of tests/test_missed_selector.py.
 * Run: node --test tests/js/
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_THRESHOLD_MS,
  InvalidAwayInterval,
  buildRawText,
  dedupeWords,
  fragmentMissedText,
  isValidAwayWindow,
  selectMissedWords,
  sortForCard,
} from "../../frontend/js/missed-selector.js";

const w = (text, start_ms, end_ms) => ({ text, start_ms, end_ms });

// Same fixture as the Python suite.
const LECTURE = [
  w("As", 0, 300), w("I", 300, 500), w("said", 500, 900), w("before,", 900, 1400),
  w("the", 2000, 2300), w("deadline", 2300, 2900), w("changed", 2900, 3400),
  w("to", 3400, 3600), w("Friday.", 3600, 4200),
  w("And", 5000, 5300), w("next", 5300, 5700), w("week", 5700, 6100),
  w("we", 6100, 6300), w("continue.", 6300, 7000),
];
const ATTENDED = ["As", "I", "said", "before,", "And", "next", "week", "we", "continue."];

const textFor = (a, b, t) => buildRawText(selectMissedWords(LECTURE, a, b, t));

test("away of 1999 ms stores nothing", () => {
  assert.deepEqual(selectMissedWords(LECTURE, 2000, 3999), []);
  assert.equal(textFor(2000, 3999), "");
});

test("away of exactly 2000 ms is valid", () => {
  assert.notDeepEqual(selectMissedWords(LECTURE, 2000, 4000), []);
  assert.ok(isValidAwayWindow(2000, 4000));
  assert.equal(DEFAULT_THRESHOLD_MS, 2000);
});

test("the first two seconds are included, not skipped", () => {
  assert.ok(textFor(2000, 4500).startsWith("the deadline"));
});

test("attended text before the away window is excluded", () => {
  const got = textFor(2000, 4500).split(" ");
  for (const token of ["As", "I", "said", "before,"]) assert.ok(!got.includes(token));
});

test("attended text after the return is excluded", () => {
  const got = textFor(2000, 4500).split(" ");
  for (const token of ["And", "next", "week", "we", "continue."]) assert.ok(!got.includes(token));
});

test("a sentence crossing the boundary is trimmed at word level", () => {
  assert.equal(textFor(2000, 4500), "the deadline changed to Friday.");
});

test("a word overlapping the start boundary is preserved", () => {
  const got = textFor(2500, 4500);
  assert.ok(got.startsWith("deadline"));
  assert.ok(!got.split(" ").includes("the"));
});

test("a word overlapping the end boundary is preserved", () => {
  assert.ok(textFor(1500, 3800).endsWith("Friday."));
});

test("a word touching a boundary exactly is excluded", () => {
  const got = textFor(1400, 3400).split(" ");
  assert.ok(!got.includes("before,"), "word ending exactly at away_start was attended");
  assert.ok(!got.includes("to"), "word starting exactly at away_end was not yet missed");
  assert.ok(got.includes("changed"), "a word merely overlapping the end is kept");
});

test("multiple away windows remain separate", () => {
  assert.equal(textFor(0, 2300), "As I said before, the");
  assert.equal(textFor(5000, 7000), "And next week we continue.");
});

test("a short glance between two valid windows adds nothing", () => {
  assert.deepEqual(selectMissedWords(LECTURE, 4200, 5100), []);
});

test("silence returns empty", () => {
  assert.deepEqual(selectMissedWords([], 0, 10000), []);
  assert.equal(buildRawText([]), "");
  assert.deepEqual(selectMissedWords(LECTURE, 7500, 10500), []);
});

test("an inverted interval throws", () => {
  assert.throws(() => selectMissedWords(LECTURE, 5000, 4000), InvalidAwayInterval);
});

test("a zero-length interval is not valid", () => {
  assert.deepEqual(selectMissedWords(LECTURE, 3000, 3000), []);
  assert.ok(!isValidAwayWindow(3000, 3000));
});

test("a transcription pad never leaks into the selection", () => {
  const awayStart = 2000, awayEnd = 4500;
  const padded = LECTURE.filter((x) => x.end_ms > 1250 && x.start_ms < 5250);
  const unpadded = LECTURE.filter((x) => x.end_ms > awayStart && x.start_ms < awayEnd);
  assert.ok(padded.length > unpadded.length);

  const fromPadded = buildRawText(selectMissedWords(padded, awayStart, awayEnd));
  assert.equal(fromPadded, buildRawText(selectMissedWords(unpadded, awayStart, awayEnd)));
  assert.equal(fromPadded, "the deadline changed to Friday.");
  for (const token of ATTENDED) assert.ok(!fromPadded.split(" ").includes(token));
});

test("overlapping clips do not duplicate words", () => {
  const overlap = [...LECTURE.slice(4, 9), ...LECTURE.slice(6, 11)];
  assert.equal(buildRawText(dedupeWords(overlap)), "the deadline changed to Friday. And next");
});

test("dedupe sorts by timeline", () => {
  assert.equal(buildRawText(dedupeWords([LECTURE[8], LECTURE[4], LECTURE[6]])), "the changed Friday.");
});

test("fragments split on sentence punctuation", () => {
  const missed = [
    w("IMPORTANT", 0, 600), w("CHANGE.", 600, 1200), w("The", 1200, 1400),
    w("assignment", 1400, 2000), w("is", 2000, 2200), w("due", 2200, 2500),
    w("Friday.", 2500, 3100),
  ];
  const frags = fragmentMissedText(missed);
  assert.deepEqual(frags.map((f) => f.text), ["IMPORTANT CHANGE.", "The assignment is due Friday."]);
  assert.equal(frags[0].start_ms, 0);
  assert.equal(frags[1].end_ms, 3100);
});

test("a trailing partial sentence is kept", () => {
  const frags = fragmentMissedText(selectMissedWords(LECTURE, 1500, 3500));
  assert.deepEqual(frags.map((f) => f.text), ["the deadline changed to"]);
});

test("punctuation-only fragments are dropped", () => {
  assert.deepEqual(fragmentMissedText([w(".", 0, 100)]), []);
  assert.deepEqual(fragmentMissedText([]), []);
});

test("? and ! also split", () => {
  const missed = [w("Ready?", 0, 500), w("Go!", 500, 900), w("Now", 900, 1200), w("begin.", 1200, 1700)];
  assert.deepEqual(fragmentMissedText(missed).map((f) => f.text), ["Ready?", "Go!", "Now begin."]);
});

test("a long punctuation-free run is chunked", () => {
  const missed = Array.from({ length: 10 }, (_, i) => w(`w${i}`, i * 100, i * 100 + 90));
  assert.deepEqual(
    fragmentMissedText(missed, 4).map((f) => f.text),
    ["w0 w1 w2 w3", "w4 w5 w6 w7", "w8 w9"]
  );
});

test("card order is priority desc then start asc", () => {
  const items = [
    { priority: 1, start_ms: 100, text: "d" },
    { priority: 4, start_ms: 900, text: "a" },
    { priority: 3, start_ms: 500, text: "b" },
    { priority: 3, start_ms: 200, text: "c" },
  ];
  assert.deepEqual(sortForCard(items).map((i) => i.text), ["a", "c", "b", "d"]);
});
