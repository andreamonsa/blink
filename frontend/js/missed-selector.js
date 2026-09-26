/**
 * Client-side mirror of backend/missed_selector.py.
 *
 * The backend already filters, but this runs again on whatever comes back
 * before anything is stored or shown. The invariant -- that attended lecture
 * text never becomes durable -- is the one thing in this product that must not
 * depend on a single implementation being correct.
 */

/** An away interval shorter than this is not a missed event at all. */
export const DEFAULT_THRESHOLD_MS = 2000;

const SENTENCE_END = [".", "?", "!"];
const HAS_ALNUM = /[\p{L}\p{N}]/u;

export class InvalidAwayInterval extends Error {}

/**
 * Keep only words overlapping a valid away interval.
 * A word survives when word.end_ms > awayStartMs AND word.start_ms < awayEndMs.
 */
export function selectMissedWords(words, awayStartMs, awayEndMs, thresholdMs = DEFAULT_THRESHOLD_MS) {
  if (awayEndMs < awayStartMs) {
    throw new InvalidAwayInterval(
      `away_end_ms (${awayEndMs}) precedes away_start_ms (${awayStartMs})`
    );
  }
  if (awayEndMs - awayStartMs < thresholdMs) return [];

  return (words ?? []).filter(
    (word) => word.end_ms > awayStartMs && word.start_ms < awayEndMs
  );
}

export function isValidAwayWindow(awayStartMs, awayEndMs, thresholdMs = DEFAULT_THRESHOLD_MS) {
  return awayEndMs >= awayStartMs && awayEndMs - awayStartMs >= thresholdMs;
}

/** Rebuild the exact missed text. This is what must never be lost. */
export function buildRawText(words) {
  return (words ?? [])
    .map((w) => (w.text ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

/** Drop words repeated by overlapping clips, keeping timeline order. */
export function dedupeWords(words) {
  const seen = new Set();
  return [...(words ?? [])]
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms)
    .filter((w) => {
      const key = `${w.start_ms}|${w.end_ms}|${(w.text ?? "").trim()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Group missed words into a few readable fragments.
 * Splits only after sentence-final punctuation; keeps leading and trailing
 * partial sentences, since a gaze boundary usually falls mid-sentence.
 */
export function fragmentMissedText(words, maxWordsPerFragment = null) {
  const fragments = [];
  let current = [];

  const flush = () => {
    if (current.length === 0) return;
    const text = buildRawText(current);
    if (HAS_ALNUM.test(text)) {
      fragments.push({
        start_ms: current[0].start_ms,
        end_ms: current[current.length - 1].end_ms,
        text,
      });
    }
    current = [];
  };

  for (const word of words ?? []) {
    const stripped = (word.text ?? "").trim();
    if (!stripped) continue;
    current.push(word);
    const endsSentence = SENTENCE_END.some((p) => stripped.endsWith(p));
    const tooLong = maxWordsPerFragment !== null && current.length >= maxWordsPerFragment;
    if (endsSentence || tooLong) flush();
  }
  flush();
  return fragments;
}

/** Compact-card order: priority DESC, then start_ms ASC. */
export function sortForCard(items) {
  return [...(items ?? [])].sort(
    (a, b) => (b.priority ?? 1) - (a.priority ?? 1) || a.start_ms - b.start_ms
  );
}
