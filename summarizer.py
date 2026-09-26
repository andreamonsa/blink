"""summarizer.py — Qwen2.5-3B via Ollama. Emits \( \) / \[ \] math for KaTeX."""
import os
import re

import ollama

MODEL = os.environ.get("SUMMARIZER_MODEL", "qwen2.5:3b-instruct-q5_K_M")
NUM_CTX = 4096
KEEP_ALIVE = "1h"

SYSTEM_PROMPT = (
    "You are a real-time note-taker for university lectures. "
    "You receive raw speech-to-text transcript segments that may contain filler words, "
    "false starts, and missing punctuation. "
    "Summarize the actual content in clear, concise prose. "
    "Preserve technical terms, definitions, formulas, and numbers exactly. "
    "Always retain dates, quantities, and named people/places exactly as stated. "
    "Ignore filler, repetition, and off-topic chatter. "
    "Do not add information that is not in the transcript. "
    "Do not start with phrases like 'The speaker says' or 'This segment discusses'. "
    "Write all math as LaTeX: \\( ... \\) for inline math and \\[ ... \\] for "
    "standalone equations. Never use dollar signs to delimit math."
)

_DISPLAY_RE = re.compile(r"\$\$(.+?)\$\$", re.DOTALL)
_INLINE_RE = re.compile(r"\$(?=\S)([^$\n]+?)(?<=\S)\$")


def _normalize_math(text: str) -> str:
    text = _DISPLAY_RE.sub(lambda m: rf"\[{m.group(1).strip()}\]", text)
    return _INLINE_RE.sub(lambda m: rf"\({m.group(1).strip()}\)", text)


def _friendly_error(e: Exception, model: str) -> RuntimeError:
    if isinstance(e, ollama.ResponseError) and e.status_code == 404:
        return RuntimeError(f"Model '{model}' not pulled. Run: ollama pull {model}")
    if isinstance(e, ConnectionError):
        return RuntimeError("Could not connect to Ollama (is it running on :11434?)")
    return RuntimeError(f"Ollama error: {e}")


def summarize(text: str, max_words: int = 60, model: str = MODEL, temperature: float = 0.2) -> str:
    text = text.strip()
    if not text:
        return ""
    in_words = len(text.split())
    if in_words <= 12:
        return _normalize_math(text)
    budget = max(15, min(max_words, in_words * 2 // 3))
    try:
        r = ollama.chat(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"Summarize the following lecture transcript segment "
                                            f"in at most {budget} words.\n\nTranscript:\n\"\"\"\n{text}\n\"\"\""},
            ],
            options={"temperature": temperature, "num_predict": int(budget * 2.5), "num_ctx": NUM_CTX},
            keep_alive=KEEP_ALIVE,
        )
    except (ollama.ResponseError, ConnectionError) as e:
        raise _friendly_error(e, model) from e
    return _normalize_math(r["message"]["content"].strip())


def warm_up(model: str = MODEL) -> None:
    try:
        ollama.chat(model=model, messages=[{"role": "user", "content": "ok"}],
                    options={"num_predict": 1, "num_ctx": NUM_CTX}, keep_alive=KEEP_ALIVE)
    except (ollama.ResponseError, ConnectionError) as e:
        raise _friendly_error(e, model) from e


if __name__ == "__main__":
    warm_up()
    print(summarize("okay so the derivative of e to the two x is two e to the two x by the chain rule "
                    "and remember the problem set is now due Friday at nine not Monday", max_words=30))
