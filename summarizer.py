"""
summarizer.py
Real-time-friendly summarizer using Qwen2.5-3B-Instruct (Q5_K_M) via Ollama.

Requirements (one-time, per machine):
    1. Install Ollama:  https://ollama.com/download   (and make sure it's running)
    2. ollama pull qwen2.5:3b-instruct-q5_K_M
    3. pip install ollama

Usage:
    import summarizer

    summarizer.warm_up()                 # once at app startup (avoids cold start)
    summary = summarizer.summarize(text) # per transcript chunk

Math in the output is delimited with $...$ (inline) and $$...$$ (display),
ready for MathJax/KaTeX.
"""

import re

import ollama

MODEL = "qwen2.5:3b-instruct-q5_K_M"

SYSTEM_PROMPT = (
    "You are a real-time note-taker for university lectures. "
    "You receive raw speech-to-text transcript segments that may contain filler words, "
    "false starts, and missing punctuation. "
    "Summarize the actual content in clear, concise prose. "
    "Preserve technical terms, definitions, formulas, and numbers exactly. "
    "Ignore filler, repetition, and off-topic chatter. "
    "Do not add information that is not in the transcript. "
    "Do not start with phrases like 'The speaker says' or 'This segment discusses'. "
    "Write all math as LaTeX wrapped in dollar signs: $...$ for inline math "
    "and $$...$$ for standalone equations. Never use \\( \\) or \\[ \\]."
)

# \( ... \)  ->  $ ... $        and        \[ ... \]  ->  $$ ... $$
_INLINE_RE = re.compile(r"\\\((.+?)\\\)", re.DOTALL)
_DISPLAY_RE = re.compile(r"\\\[(.+?)\\\]", re.DOTALL)


def _normalize_math(text: str) -> str:
    """Convert any \\( \\) / \\[ \\] delimiters the model emits into $ / $$."""
    text = _DISPLAY_RE.sub(lambda m: f"$${m.group(1).strip()}$$", text)
    text = _INLINE_RE.sub(lambda m: f"${m.group(1).strip()}$", text)
    return text


def _friendly_error(e: Exception, model: str) -> RuntimeError:
    """Turn raw Ollama errors into actionable messages."""
    if isinstance(e, ollama.ResponseError) and e.status_code == 404:
        return RuntimeError(
            f"Model '{model}' is not available locally. Run:\n    ollama pull {model}"
        )
    if isinstance(e, ConnectionError):
        return RuntimeError(
            "Could not connect to Ollama. Is the Ollama app/server running? "
            "(It listens on http://localhost:11434 by default; set OLLAMA_HOST to override.)"
        )
    return RuntimeError(f"Ollama error: {e}")


def summarize(
    text: str,
    max_words: int = 60,
    model: str = MODEL,
    temperature: float = 0.2,
) -> str:
    """
    Summarize a chunk of transcript text.

    Args:
        text:        The sentences to summarize (typically 30-90 s of speech).
        max_words:   Soft upper bound for the summary length (model may exceed slightly).
        model:       Ollama model tag.
        temperature: Lower = more deterministic. Keep low for summarization.

    Returns:
        The summary as a string with $-delimited LaTeX ("" if input is empty/whitespace).

    Raises:
        RuntimeError: if Ollama is unreachable or the model is not pulled.
    """
    text = text.strip()
    if not text:
        return ""

    user_prompt = (
        f"Summarize the following lecture transcript segment in at most {max_words} words.\n\n"
        f"Transcript:\n\"\"\"\n{text}\n\"\"\""
    )

    try:
        response = ollama.chat(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            options={
                "temperature": temperature,
                "num_predict": int(max_words * 2.5),  # token cap; words ≈ 1.3-1.5 tokens + margin
                "num_ctx": 4096,                       # context window; enough for ~2500 words in
            },
            keep_alive="15m",  # keep model loaded in memory between calls (important for real-time)
        )
    except (ollama.ResponseError, ConnectionError) as e:
        raise _friendly_error(e, model) from e

    return _normalize_math(response["message"]["content"].strip())


def warm_up(model: str = MODEL) -> None:
    """
    Load the model into memory. Call once at application startup.
    The first call to a cold model takes several seconds; subsequent calls are fast.
    The model stays loaded for 15 min after the last call.
    """
    try:
        ollama.chat(
            model=model,
            messages=[{"role": "user", "content": "ok"}],
            options={"num_predict": 1},
            keep_alive="15m",
        )
    except (ollama.ResponseError, ConnectionError) as e:
        raise _friendly_error(e, model) from e


if __name__ == "__main__":
    # Smoke test: is Ollama reachable, is the model present, how fast is a warm call?
    import time

    print(f"Model: {MODEL}")
    t0 = time.perf_counter()
    warm_up()
    print(f"Warm-up: {time.perf_counter() - t0:.1f}s")

    t0 = time.perf_counter()
    out = summarize("The derivative of e to the x is e to the x. Test sentence.", max_words=20)
    print(f"Warm call: {time.perf_counter() - t0:.1f}s")
    print(f"Output: {out}")
    print("OK")
