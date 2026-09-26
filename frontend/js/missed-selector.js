/**
 * Client-side mirror of backend/missed_selector.py.
 */

export const DEFAULT_THRESHOLD_MS = 2000;

const SENTENCE_END = [".", "?", "!"];
const HAS_ALNUM = /[\p{L}\p{N}]/u;

export class InvalidAwayInterval extends Error {}

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

export function buildRawText(words) {
  return (words ?? [])
    .map((w) => (w.text ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

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

export function sortForCard(items) {
  return [...(items ?? [])].sort(
    (a, b) => (b.priority ?? 1) - (a.priority ?? 1) || a.start_ms - b.start_ms
  );
}
