import json
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

PRIORITY_PROMPT = (
    "You extract must-not-miss items from a university lecture transcript. "
    'Return JSON only: {"priorities": [...]}, each item one short sentence in the transcript\'s own words. '
    "ONLY these three kinds qualify: "
    "(1) a question the professor asks the students; "
    "(2) a formula, theorem or definition the professor says to remember or memorize; "
    "(3) a date, deadline, exam or assignment detail, or a change of schedule. "
    "Filler, small talk, jokes, examples and ordinary explanation NEVER qualify. "
    'If nothing qualifies return {"priorities": []}. Write math as \\( ... \\).'
)

_DISPLAY_RE = re.compile(r"\$\$(.+?)\$\$", re.DOTALL)
_INLINE_RE = re.compile(r"\$(?=\S)([^$\n]+?)(?<=\S)\$")
_LEADIN_RE = re.compile(
    r"^(the|this)\s+(speaker|lecturer|professor|teacher|transcript|segment|text|lecture)\s+"
    r"\w+(\s+that)?[\s:,]+", re.I)


def _normalize_math(text: str) -> str:
    text = _DISPLAY_RE.sub(lambda m: rf"\[{m.group(1).strip()}\]", text)
    return _INLINE_RE.sub(lambda m: rf"\({m.group(1).strip()}\)", text)


def _strip_leadin(text: str) -> str:
    out = _LEADIN_RE.sub("", text, count=1)
    return out[:1].upper() + out[1:] if out else text


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
    return _strip_leadin(_normalize_math(r["message"]["content"].strip()))


def extract_priorities(text: str, model: str = MODEL, max_items: int = 5) -> list[str]:
    """Questions to students, formulas to memorize, dates/schedule changes. [] if none."""
    text = text.strip()
    if len(text.split()) < 4:
        return []
    try:
        r = ollama.chat(
            model=model,
            messages=[{"role": "system", "content": PRIORITY_PROMPT},
                      {"role": "user", "content": f"Transcript:\n\"\"\"\n{text}\n\"\"\""}],
            format="json",
            options={"temperature": 0, "num_predict": 300, "num_ctx": NUM_CTX},
            keep_alive=KEEP_ALIVE,
        )
        data = json.loads(r["message"]["content"])
    except (ollama.ResponseError, ConnectionError) as e:
        raise _friendly_error(e, model) from e
    except (json.JSONDecodeError, KeyError):
        return []
    items = data.get("priorities", []) if isinstance(data, dict) else data
    out: list[str] = []
    for it in items or []:
        if isinstance(it, dict):
            it = it.get("text") or it.get("item") or ""
        s = _normalize_math(str(it).strip())
        if len(s.split()) >= 3 and s not in out:
            out.append(s)
    return out[:max_items]


def warm_up(model: str = MODEL) -> None:
    try:
        ollama.chat(model=model, messages=[{"role": "user", "content": "ok"}],
                    options={"num_predict": 1, "num_ctx": NUM_CTX}, keep_alive=KEEP_ALIVE)
    except (ollama.ResponseError, ConnectionError) as e:
        raise _friendly_error(e, model) from e


if __name__ == "__main__":
    warm_up()
    demo = ("okay so the derivative of e to the two x is two e to the two x by the chain rule "
            "and remember the problem set is now due Friday at nine not Monday "
            "can anyone tell me what the inside function is for ln of three x plus one")
    print("SUMMARY:", summarize(demo, max_words=30))
    print("PRIORITIES:", extract_priorities(demo))
