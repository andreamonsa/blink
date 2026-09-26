"""
test_summarizer.py
Run with:   python test_summarizer.py
   or:      pytest test_summarizer.py -v   (assertion tests only, no report)

Writes a JSON report to ./reports/summarizer_report_<timestamp>.json with
inputs, outputs, word counts, compression ratios and latencies side-by-side.
"""

import json
import shutil
import sys
import textwrap
import time
from datetime import datetime
from pathlib import Path

import ollama

from summarizer import MODEL, summarize, warm_up

REPORTS_DIR = Path("reports")


# ---------------------------------------------------------------------------
# Sample inputs
# ---------------------------------------------------------------------------

SAMPLES = [
    {
        "name": "clean_biology",
        "max_words": 40,
        "input": (
            "Photosynthesis is the process by which plants convert light energy into chemical energy. "
            "It takes place in the chloroplasts, primarily in the leaves. The overall reaction combines "
            "carbon dioxide and water to produce glucose and oxygen. Chlorophyll is the pigment that "
            "absorbs light, mostly in the blue and red wavelengths, which is why plants appear green. "
            "The process has two stages: the light-dependent reactions and the Calvin cycle."
        ),
    },
    {
        "name": "messy_asr_calculus",
        "max_words": 40,
        "input": (
            "okay so um where were we right so the the derivative of e to the x is just e to the x "
            "which is kind of the whole point of e um that's why it shows up everywhere so if you have "
            "e to the two x you use the chain rule and you get two e to the two x uh does that make "
            "sense yeah okay so the chain rule you just multiply by the derivative of the inside "
            "sorry can someone close the door thanks so the inside is two x derivative is two"
        ),
    },
    {
        "name": "long_history",
        "max_words": 50,
        "input": " ".join([
            "The French Revolution began in 1789 with the storming of the Bastille on July 14th.",
            "It was driven by a fiscal crisis, widespread hunger, and resentment toward the privileges "
            "of the aristocracy and clergy.",
            "The Estates-General was convened for the first time since 1614, and the Third Estate "
            "declared itself the National Assembly.",
            "In August 1789 the Assembly issued the Declaration of the Rights of Man and of the Citizen.",
            "The monarchy was abolished in 1792 and Louis XVI was executed in January 1793.",
            "The Reign of Terror followed under Robespierre, with roughly 17,000 official executions.",
            "It ended with Robespierre's own execution in July 1794, the Thermidorian Reaction.",
            "Napoleon Bonaparte seized power in 1799, effectively ending the revolutionary period.",
        ] * 3),
    },
    {
        "name": "messy_asr_cs",
        "max_words": 50,
        "input": (
            "right so uh a hash table okay the idea is you have a key and you want to find the value "
            "really fast like constant time on average so you take the key you run it through a hash "
            "function which gives you an integer and you mod that by the size of the array and that's "
            "your index um the problem is collisions two keys same index so you either do chaining "
            "where each slot is a linked list or open addressing where you probe for the next free slot "
            "uh yeah question in the back no we'll cover load factor next time so worst case is O of n "
            "if everything collides but average is O of 1"
        ),
    },
]

# handy aliases for the assertion tests
CLEAN_TEXT = SAMPLES[0]["input"]
MESSY_ASR_TEXT = SAMPLES[1]["input"]
LONG_TEXT = SAMPLES[2]["input"]


# ---------------------------------------------------------------------------
# Assertion tests (pytest-compatible)
# ---------------------------------------------------------------------------

def test_model_is_available():
    tags = [m["model"] for m in ollama.list()["models"]]
    assert any(MODEL in t for t in tags), (
        f"{MODEL} not found. Installed: {tags}\nRun: ollama pull {MODEL}"
    )


def test_empty_input_returns_empty():
    assert summarize("") == ""
    assert summarize("   \n\t ") == ""


def test_clean_text_basic():
    out = summarize(CLEAN_TEXT, max_words=40)
    assert isinstance(out, str) and out
    assert len(out.split()) < len(CLEAN_TEXT.split()), "summary should be shorter than input"
    assert "photosynthesis" in out.lower(), "key term should be preserved"


def test_messy_asr_text():
    out = summarize(MESSY_ASR_TEXT, max_words=40)
    assert out
    for filler in (" um ", " uh ", "close the door"):
        assert filler not in out.lower(), f"filler '{filler}' leaked into summary"
    assert "chain rule" in out.lower() or "e^" in out or "e to the" in out.lower()


def test_long_text_respects_word_budget():
    max_words = 50
    out = summarize(LONG_TEXT, max_words=max_words)
    n = len(out.split())
    assert 0 < n <= max_words * 1.6, f"expected ≤ {int(max_words * 1.6)} words, got {n}"


def test_latency_is_realtime_friendly():
    warm_up()
    t0 = time.perf_counter()
    summarize(CLEAN_TEXT, max_words=50)
    elapsed = time.perf_counter() - t0
    assert elapsed < 8.0, f"too slow for real-time: {elapsed:.2f}s"

def test_math_uses_dollar_delimiters():
    out = summarize(MESSY_ASR_TEXT, max_words=40)
    assert "\\(" not in out and "\\[" not in out, f"found non-$ delimiters: {out}"

TESTS = [
    test_model_is_available,
    test_empty_input_returns_empty,
    test_clean_text_basic,
    test_messy_asr_text,
    test_long_text_respects_word_budget,
    test_latency_is_realtime_friendly,
    test_math_uses_dollar_delimiters,
]


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

def run_assertion_tests() -> list[dict]:
    results = []
    for t in TESTS:
        name = t.__name__
        t0 = time.perf_counter()
        try:
            t()
            status, detail = "PASS", ""
        except AssertionError as e:
            status, detail = "FAIL", str(e)
        except Exception as e:
            status, detail = "ERROR", f"{type(e).__name__}: {e}"
        results.append({
            "test": name,
            "status": status,
            "detail": detail,
            "seconds": round(time.perf_counter() - t0, 2),
        })
        print(f"{status:<5} {name}" + (f"\n      {detail}" if detail else ""))
    return results


def run_samples() -> list[dict]:
    rows = []
    for s in SAMPLES:
        t0 = time.perf_counter()
        out = summarize(s["input"], max_words=s["max_words"])
        latency = time.perf_counter() - t0
        in_words = len(s["input"].split())
        out_words = len(out.split())
        rows.append({
            "name": s["name"],
            "max_words": s["max_words"],
            "input": s["input"],
            "output": out,
            "input_words": in_words,
            "output_words": out_words,
            "within_budget": out_words <= s["max_words"] * 1.6,
            "compression_ratio": round(in_words / out_words, 2) if out_words else None,
            "latency_seconds": round(latency, 2),
        })
    return rows


def print_side_by_side(rows: list[dict]) -> None:
    width = shutil.get_terminal_size((120, 40)).columns
    col = max(30, (width - 7) // 2)  # two columns + separator
    for r in rows:
        header = (
            f" {r['name']}  |  {r['input_words']}→{r['output_words']} words "
            f"(×{r['compression_ratio']})  |  {r['latency_seconds']}s "
        )
        print("\n" + header.center(width, "═"))
        print(f"{'INPUT':<{col}} │ {'SUMMARY'}")
        print(f"{'-' * col} │ {'-' * col}")
        left = textwrap.wrap(r["input"], col) or [""]
        right = textwrap.wrap(r["output"], col) or [""]
        for i in range(max(len(left), len(right))):
            l = left[i] if i < len(left) else ""
            rr = right[i] if i < len(right) else ""
            print(f"{l:<{col}} │ {rr}")


def write_report(test_results: list[dict], sample_rows: list[dict]) -> Path:
    REPORTS_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = REPORTS_DIR / f"summarizer_report_{stamp}.json"

    latencies = [r["latency_seconds"] for r in sample_rows]
    report = {
        "meta": {
            "model": MODEL,
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "python": sys.version.split()[0],
        },
        "summary": {
            "tests_passed": sum(r["status"] == "PASS" for r in test_results),
            "tests_total": len(test_results),
            "samples": len(sample_rows),
            "avg_latency_seconds": round(sum(latencies) / len(latencies), 2),
            "max_latency_seconds": max(latencies),
            "avg_compression_ratio": round(
                sum(r["compression_ratio"] for r in sample_rows if r["compression_ratio"])
                / len(sample_rows), 2
            ),
        },
        "tests": test_results,
        "samples": sample_rows,
    }
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def main() -> None:
    print(f"Model: {MODEL}\nWarming up...\n")
    warm_up()

    print("── Assertion tests ──")
    test_results = run_assertion_tests()

    print("\n── Samples ──")
    sample_rows = run_samples()
    print_side_by_side(sample_rows)

    path = write_report(test_results, sample_rows)
    passed = sum(r["status"] == "PASS" for r in test_results)
    print(f"\n{passed}/{len(test_results)} tests passed")
    print(f"Report written to: {path}")
    sys.exit(0 if passed == len(test_results) else 1)


if __name__ == "__main__":
    main()
