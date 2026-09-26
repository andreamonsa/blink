"""
summarizer.py
Real-time-friendly summarizer using Qwen2.5-3B-Instruct (Q5_K_M) via Ollama.

Usage:
    from summarizer import summarize
    summary = summarize("... transcript chunk ...")
"""

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
    "Do not start with phrases like 'The speaker says' or 'This segment discusses'."
)


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
        max_words:   Soft upper bound for the summary length.
        model:       Ollama model tag.
        temperature: Lower = more deterministic. Keep low for summarization.

    Returns:
        The summary as a plain string ("" if input is empty/whitespace).
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
    except ollama.ResponseError as e:
        if "not found" in str(e).lower():
            raise RuntimeError(
                f"Model '{model}' is not available locally. Run:\n"
                f"    ollama pull {model}"
            ) from e
        raise
    except ConnectionError as e:
        raise RuntimeError(
            "Could not connect to Ollama. Is the Ollama app/server running? "
            "(It listens on http://localhost:11434)"
        ) from e

    return response["message"]["content"].strip()


def warm_up(model: str = MODEL) -> None:
    """
    Load the model into memory before the lecture starts.
    The first call to a cold model takes several seconds; subsequent calls are fast.
    """
    ollama.chat(
        model=model,
        messages=[{"role": "user", "content": "ok"}],
        options={"num_predict": 1},
        keep_alive="15m",
    )


if __name__ == "__main__":
    print("Warming up model...")
    warm_up()
    print("\n--- SUMMARY ---")
