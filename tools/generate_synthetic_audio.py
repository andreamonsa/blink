#!/usr/bin/env python3
"""Generate the deterministic synthetic lecture (CLAUDE.md Part 9B).

Three sentences on one timeline:
  1. attended
  2. MISSED  -- the assignment deadline moves to Friday instead of Monday
  3. attended

Uses macOS `say` and the stdlib `wave` module, so no ffmpeg or espeak is
needed. Sentence boundaries are placed by sample count, which makes the away
window in the manifest exact rather than approximate.

Writes synthetic/synthetic_lecture.wav and synthetic/manifest.json.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import wave

SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2
VOICE = os.getenv("SYNTHETIC_VOICE", "Samantha")
RATE_WPM = os.getenv("SYNTHETIC_RATE", "170")

#: Silence inserted between sentences, in milliseconds.
GAP_MS = 700
#: Silence before the first and after the last sentence.
LEAD_MS = 500

SENTENCES = [
    ("attended", "Today we are reviewing pricing strategy and willingness to pay."),
    ("missed", "IMPORTANT CHANGE. The first assignment is now due on Friday, not Monday."),
    ("attended", "Now please look at the chart on slide twelve."),
]

#: A long lecture whose missed section spans several chunks, so the chunked
#: transcription path can be tested against real Whisper rather than only at
#: unit level. Roughly two and a half minutes.
LONG_SENTENCES = [
    ("attended", "Good morning everyone, welcome back to the second half of the course."),
    ("attended", "Last week we finished our discussion of consumer surplus."),
    ("missed", "IMPORTANT CHANGE. The first assignment is now due on Friday, not Monday."),
    ("missed", "Please submit it through the course website rather than by email."),
    ("missed", "We chose the second pricing model because it fits the observed data better."),
    ("missed", "Can you tell me why the demand curve shifts to the right in that case?"),
    ("missed", "Elasticity measures how quantity changes relative to a change in price."),
    ("missed", "For next week, read chapter six instead of chapter five."),
    ("missed", "The committee rejected the first proposal because the total cost was too high."),
    ("missed", "Remember that the midterm covers everything up to and including today."),
    ("attended", "Now please look at the chart on slide twelve."),
    ("attended", "That concludes the material for this session, see you on Thursday."),
]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "synthetic")


def silence(ms: int) -> bytes:
    return b"\x00" * (SAMPLE_WIDTH * int(SAMPLE_RATE * ms / 1000))


def say_to_pcm(text: str, tmpdir: str, index: int) -> bytes:
    """Render one sentence to raw 16 kHz mono PCM via macOS `say`."""
    path = os.path.join(tmpdir, f"s{index}.wav")
    subprocess.run(
        [
            "say", "-v", VOICE, "-r", RATE_WPM,
            "--data-format=LEI16@16000",
            "-o", path, text,
        ],
        check=True,
        capture_output=True,
    )
    with wave.open(path, "rb") as wav:
        if wav.getnchannels() != 1 or wav.getframerate() != SAMPLE_RATE:
            raise RuntimeError(
                f"unexpected say output: {wav.getnchannels()}ch @ {wav.getframerate()}Hz"
            )
        return wav.readframes(wav.getnframes())


def ms_of(pcm: bytes) -> float:
    return len(pcm) / SAMPLE_WIDTH / SAMPLE_RATE * 1000.0


def build(sentences, wav_name, manifest_name):
    """Render one lecture to a WAV plus a manifest with exact timings."""
    os.makedirs(OUT_DIR, exist_ok=True)
    track = bytearray()
    spans = []

    with tempfile.TemporaryDirectory() as tmpdir:
        track += silence(LEAD_MS)
        for index, (role, text) in enumerate(sentences):
            pcm = say_to_pcm(text, tmpdir, index)
            start_ms = ms_of(bytes(track))
            track += pcm
            end_ms = ms_of(bytes(track))
            spans.append(
                {"index": index, "role": role, "text": text,
                 "start_ms": round(start_ms), "end_ms": round(end_ms)}
            )
            track += silence(GAP_MS)
        track += silence(LEAD_MS)

    wav_path = os.path.join(OUT_DIR, wav_name)
    with wave.open(wav_path, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(SAMPLE_WIDTH)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(bytes(track))

    missed_spans = [s for s in spans if s["role"] == "missed"]
    # The away window brackets every missed sentence inside the surrounding
    # silences, so the expected result is unambiguous.
    away_start = missed_spans[0]["start_ms"] - GAP_MS // 2
    away_end = missed_spans[-1]["end_ms"] + GAP_MS // 2

    def words_of(role):
        out = set()
        for span in spans:
            if span["role"] != role:
                continue
            for token in span["text"].lower().replace(".", "").replace(",", "").split():
                if len(token) >= 5:
                    out.add(token)
        return out

    # Words that appear only in attended sentences are the leak canaries.
    attended_only = sorted(words_of("attended") - words_of("missed"))

    manifest = {
        "audio": os.path.relpath(wav_path, ROOT),
        "sample_rate": SAMPLE_RATE,
        "voice": VOICE,
        "rate_wpm": int(RATE_WPM),
        "duration_ms": round(ms_of(bytes(track))),
        "sentences": spans,
        "away_window": {"start_ms": away_start, "end_ms": away_end},
        "expect_contains": ["assignment", "Friday", "Monday"],
        "expect_absent": attended_only,
    }

    manifest_path = os.path.join(OUT_DIR, manifest_name)
    with open(manifest_path, "w") as fh:
        json.dump(manifest, fh, indent=2)

    print(f"wrote {wav_path} ({manifest['duration_ms']} ms)")
    for span in spans:
        print(f"  [{span['start_ms']:>6} - {span['end_ms']:>6}] {span['role']:<8} {span['text']}")
    print(f"away window: [{away_start}, {away_end}] "
          f"({away_end - away_start} ms)")
    print(f"wrote {manifest_path}")
    return manifest


def main() -> int:
    if not shutil.which("say"):
        print("error: macOS `say` not found; this generator is macOS only", file=sys.stderr)
        return 1

    build(SENTENCES, "synthetic_lecture.wav", "manifest.json")
    print()
    build(LONG_SENTENCES, "long_lecture.wav", "long_manifest.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
