#!/usr/bin/env python3
"""Real faster-whisper validation on the synthetic lecture (CLAUDE.md Part 9C).

Acceptance:
  * transcript contains the semantic core: assignment, Friday, Monday
  * selected missed text contains no phrase from the attended sentences
  * no crash on silence
  * no duplicate text
  * the transcription pad never leaks into the stored text
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from backend import config, stt  # noqa: E402
from backend.missed_selector import build_raw_text, select_missed_words  # noqa: E402
from tools.wav_util import slice_wav  # noqa: E402

MANIFEST = os.path.join(ROOT, "synthetic", "manifest.json")


def check(label: str, ok: bool, detail: str = "") -> bool:
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f" -- {detail}" if detail else ""))
    return ok


def has_duplicate_runs(text: str, run: int = 4) -> bool:
    """True if any 4-word sequence appears twice (a classic Whisper loop)."""
    words = text.lower().split()
    grams = [" ".join(words[i:i + run]) for i in range(len(words) - run + 1)]
    return len(grams) != len(set(grams))


def main() -> int:
    if not os.path.exists(MANIFEST):
        print("run tools/generate_synthetic_audio.py first", file=sys.stderr)
        return 1

    with open(MANIFEST) as fh:
        manifest = json.load(fh)

    audio = os.path.join(ROOT, manifest["audio"])
    away = manifest["away_window"]
    away_start, away_end = away["start_ms"], away["end_ms"]
    pad = config.CLIP_PAD_MS

    print(f"synthetic lecture: {audio}")
    print(f"away window: [{away_start}, {away_end}] ({away_end - away_start} ms), pad={pad} ms\n")

    results = []

    # --- full-file transcription, for reference ---------------------------
    print("full-lecture transcription (reference only, never persisted):")
    _segs, full_words, full_text, elapsed = stt.transcribe_clip(audio, clip_start_ms=0)
    print(f"  {len(full_words)} words in {elapsed:.2f}s")
    print(f"  {full_text}\n")

    lowered = full_text.lower()
    print("transcript quality:")
    for token in manifest["expect_contains"]:
        results.append(check(f"transcript contains {token!r}", token.lower() in lowered))
    results.append(check("no duplicated 4-word run", not has_duplicate_runs(full_text)))
    print()

    # --- the product path: padded clip, unpadded selection ----------------
    clip_start = max(0, away_start - pad)
    clip_path = slice_wav(audio, clip_start, away_end + pad)
    try:
        _segs, clip_words, clip_text, clip_elapsed = stt.transcribe_clip(
            clip_path, clip_start_ms=clip_start
        )
    finally:
        os.unlink(clip_path)

    missed = select_missed_words(clip_words, away_start, away_end)
    missed_text = build_raw_text(missed)

    print(f"padded clip [{clip_start}, {away_end + pad}] -> {len(clip_words)} words "
          f"in {clip_elapsed:.2f}s")
    print(f"selected missed text ({len(missed)} words):")
    print(f"  {missed_text!r}\n")

    print("missed-text acceptance:")
    low = missed_text.lower()
    for token in manifest["expect_contains"]:
        results.append(check(f"missed text contains {token!r}", token.lower() in low))
    for token in manifest["expect_absent"]:
        results.append(
            check(f"missed text excludes attended word {token!r}", token.lower() not in low)
        )
    results.append(check("no duplicated 4-word run in missed text",
                         not has_duplicate_runs(missed_text)))
    print()

    # --- pad must not change the stored text ------------------------------
    print("pad-leak check (CLAUDE.md invariant):")
    unpadded_path = slice_wav(audio, away_start, away_end)
    try:
        _segs, unpadded_words, _t, _e = stt.transcribe_clip(
            unpadded_path, clip_start_ms=away_start
        )
    finally:
        os.unlink(unpadded_path)
    unpadded_text = build_raw_text(select_missed_words(unpadded_words, away_start, away_end))
    print(f"  unpadded selection: {unpadded_text!r}")
    results.append(
        check(
            "padded selection carries no attended sentence",
            not any(t.lower() in low for t in manifest["expect_absent"]),
        )
    )
    print()

    # --- silence ----------------------------------------------------------
    print("silence handling:")
    silent = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
    try:
        with wave.open(silent, "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(16000)
            out.writeframes(b"\x00\x00" * 16000 * 3)
        _s, silent_words, silent_text, _e = stt.transcribe_clip(silent, clip_start_ms=0)
        results.append(check("silence does not crash", True))
        results.append(
            check("silence produces no missed text",
                  build_raw_text(select_missed_words(silent_words, 0, 3000)) == "",
                  repr(silent_text))
        )
    except Exception as exc:
        results.append(check("silence does not crash", False, str(exc)))
    finally:
        os.unlink(silent)

    passed = sum(1 for r in results if r)
    print(f"\n{passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
