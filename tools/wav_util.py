"""Small WAV helpers shared by the tools and the audio-backed tests."""

from __future__ import annotations

import os
import tempfile
import wave


def slice_wav(src: str, start_ms: float, end_ms: float) -> str:
    """Cut [start_ms, end_ms) out of a mono PCM wav into a new temp file."""
    with wave.open(src, "rb") as wav:
        rate, width, channels = wav.getframerate(), wav.getsampwidth(), wav.getnchannels()
        total = wav.getnframes()
        first = max(0, int(start_ms * rate / 1000))
        last = min(total, int(end_ms * rate / 1000))
        wav.setpos(min(first, total))
        frames = wav.readframes(max(0, last - first))

    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    with wave.open(path, "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(width)
        out.setframerate(rate)
        out.writeframes(frames)
    return path


def write_silence(seconds: float, rate: int = 16000) -> str:
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    with wave.open(path, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(b"\x00\x00" * int(rate * seconds))
    return path
