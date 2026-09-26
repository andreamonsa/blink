"""Real 12-case Laya benchmark on the cached model (CLAUDE.md Part 7).

Run with the real checkpoint -- no mocks:
    .venv/bin/python -m unittest tests.test_laya_classifier_real -v

Prints per-case expected vs predicted, accuracy, confusion counts, and
cold-load / warm-single / warm-batch latency measured on THIS machine.

Hackathon acceptance (asserted below):
  1. "The assignment is now due Friday instead of Monday." -> instruction_change
  2. at least one question case -> question_to_you
  3. the classifier never blocks returning raw missed text
"""

from __future__ import annotations

import time
import unittest
from collections import Counter

from backend import classifier, config

CASES = [
    # A: question_to_you
    ("Can you tell me why the demand curve shifts to the right?", "question_to_you"),
    ("What answer did you get for question four?", "question_to_you"),
    ("Could you explain the assumption you used there?", "question_to_you"),
    # B: instruction_change
    ("The assignment is now due Friday instead of Monday.", "instruction_change"),
    ("Please submit the report through Canvas, not by email.", "instruction_change"),
    ("For next week, read chapter six instead of chapter five.", "instruction_change"),
    # C: decision_reason
    ("We will use the second model because it fits the observed data better.", "decision_reason"),
    ("The committee chose option B because it has the lowest total cost.", "decision_reason"),
    ("We reject the first hypothesis because the evidence is inconsistent with it.", "decision_reason"),
    # D: ordinary_context
    ("Elasticity measures how quantity changes relative to a change in price.", "ordinary_context"),
    ("This graph has price on the vertical axis and quantity on the horizontal axis.", "ordinary_context"),
    ("Now we are going to continue with the next example.", "ordinary_context"),
]

DEMO_SENTENCE = "The assignment is now due Friday instead of Monday."

_report: dict = {}


@unittest.skipUnless(config.LAYA_ENABLED, "LAYA_ENABLED=0")
class LayaBenchmarkTest(unittest.TestCase):
    predictions: list = []

    @classmethod
    def setUpClass(cls):
        t0 = time.time()
        agent = classifier.get_agent()
        _report["cold_load_s"] = time.time() - t0
        if agent is None:
            raise unittest.SkipTest(f"laya unavailable: {classifier.status()['error']}")
        _report["device"] = str(getattr(agent, "device", "?"))

        _report["warmup_s"] = classifier.warmup()

        # Warm single-item latency, averaged over the 12 cases.
        singles = []
        cls.predictions = []
        for text, expected in CASES:
            t = time.time()
            items, ok = classifier.classify_missed_fragments([text])
            singles.append(time.time() - t)
            cls.predictions.append((text, expected, items[0], ok))
        _report["warm_single_ms"] = sum(singles) / len(singles) * 1000
        _report["warm_single_min_ms"] = min(singles) * 1000
        _report["warm_single_max_ms"] = max(singles) * 1000

        # Warm batch latency for a realistic 4-fragment away window. The first
        # call at a new batch shape pays a one-off MPS graph cost, so warm that
        # shape first and then measure -- otherwise the number is meaningless.
        batch = [c[0] for c in CASES[:4]]
        classifier.classify_missed_fragments(batch)
        runs = []
        for _ in range(3):
            t = time.time()
            classifier.classify_missed_fragments(batch)
            runs.append(time.time() - t)
        _report["warm_batch4_ms"] = min(runs) * 1000
        _report["warm_batch4_per_item_ms"] = _report["warm_batch4_ms"] / 4

    @classmethod
    def tearDownClass(cls):
        correct = sum(1 for _t, exp, item, _ok in cls.predictions if item["kind"] == exp)
        total = len(cls.predictions)

        print("\n" + "=" * 78)
        print("LAYA 12-CASE BENCHMARK  --  measured on this machine")
        print("=" * 78)
        print(f"checkpoint : {config.LAYA_MODEL} / {config.LAYA_SUBFOLDER}")
        print(f"device     : {_report.get('device')}")
        print(f"cold load  : {_report.get('cold_load_s', 0):.2f} s")
        print(f"warmup pass: {(_report.get('warmup_s') or 0):.3f} s")
        print(f"warm single: {_report.get('warm_single_ms', 0):.1f} ms avg "
              f"({_report.get('warm_single_min_ms', 0):.1f}-"
              f"{_report.get('warm_single_max_ms', 0):.1f} ms)")
        print(f"warm batch : {_report.get('warm_batch4_ms', 0):.1f} ms for 4 fragments "
              f"({_report.get('warm_batch4_per_item_ms', 0):.1f} ms/fragment)")
        print("-" * 78)
        print(f"{'expected':<20}{'predicted':<20}{'conf':>6}  text")
        print("-" * 78)
        for text, expected, item, _ok in cls.predictions:
            mark = " " if item["kind"] == expected else "X"
            conf = item.get("confidence")
            print(f"{mark}{expected:<19}{item['kind']:<20}"
                  f"{(conf if conf is not None else 0):>6.2f}  {text[:38]}")
        print("-" * 78)
        print(f"accuracy: {correct}/{total} = {correct / total:.1%}")

        confusion = Counter(
            (exp, item["kind"]) for _t, exp, item, _ok in cls.predictions
            if item["kind"] != exp
        )
        if confusion:
            print("confusions (expected -> predicted):")
            for (exp, got), n in confusion.most_common():
                print(f"  {exp} -> {got}: {n}")
        else:
            print("confusions: none")
        print("=" * 78 + "\n")

    # --- prompt budget: laya truncates silently, so check it fits ---------
    def test_criteria_fit_the_48_token_cap(self):
        agent = classifier.get_agent()
        tok = agent.tok
        for key, text in classifier.LAYA_QUESTIONS["missed_kind"]["criteria"].items():
            n = len(tok(text, add_special_tokens=False)["input_ids"])
            self.assertLessEqual(
                n, 48, f"criterion {key} is {n} tokens and would be truncated"
            )

    def test_instructions_fit_the_head_budget(self):
        agent = classifier.get_agent()
        tok = agent.tok
        crit = classifier.LAYA_QUESTIONS["missed_kind"]["criteria"]
        opt_tokens = sum(
            len(tok(f"{k}: {v}", add_special_tokens=False)["input_ids"])
            for k, v in crit.items()
        )
        head_max = agent.cfg.get("head_max_len", 192)
        instr = classifier.LAYA_QUESTIONS["missed_kind"]["instructions"]
        instr_tokens = len(tok(instr, add_special_tokens=False)["input_ids"])
        print(f"\n  head budget: options={opt_tokens} + instructions={instr_tokens} "
              f"<= head_max_len={head_max}")
        self.assertLessEqual(opt_tokens + instr_tokens, head_max)

    # --- hackathon acceptance criteria ------------------------------------
    def test_demo_sentence_is_instruction_change(self):
        items, ok = classifier.classify_missed_fragments([DEMO_SENTENCE])
        self.assertTrue(ok)
        self.assertEqual(
            items[0]["kind"], "instruction_change",
            f"demo sentence misclassified as {items[0]['kind']} "
            f"(probs={items[0].get('probabilities')})",
        )
        self.assertTrue(items[0]["show_by_default"])
        self.assertEqual(items[0]["priority"], 3)

    def test_at_least_one_question_is_question_to_you(self):
        questions = [t for t, e in CASES if e == "question_to_you"]
        items, _ok = classifier.classify_missed_fragments(questions)
        kinds = [i["kind"] for i in items]
        self.assertIn("question_to_you", kinds, f"no question detected: {kinds}")

    def test_batch_and_single_agree(self):
        texts = [t for t, _ in CASES[:5]]
        batched, _ = classifier.classify_missed_fragments(texts)
        for text, item in zip(texts, batched):
            single, _ = classifier.classify_missed_fragments([text])
            self.assertEqual(item["kind"], single[0]["kind"], f"batch/single differ: {text!r}")

    def test_every_input_gets_an_item_back(self):
        """No fragment may be silently dropped, whatever the model says."""
        texts = [t for t, _ in CASES]
        items, _ok = classifier.classify_missed_fragments(texts)
        self.assertEqual(len(items), len(texts))
        self.assertEqual([i["text"] for i in items], texts)

    def test_ordinary_context_is_collapsed_not_deleted(self):
        items, _ok = classifier.classify_missed_fragments(
            ["Now we are going to continue with the next example."]
        )
        self.assertEqual(items[0]["show_by_default"], items[0]["kind"] != "ordinary_context")
        self.assertTrue(items[0]["text"])  # text always survives

    def test_accuracy_is_reported_and_not_catastrophic(self):
        correct = sum(1 for _t, exp, item, _ok in self.predictions if item["kind"] == exp)
        # Not a quality bar -- a smoke test that the model is actually deciding
        # rather than emitting one constant label.
        distinct = {item["kind"] for _t, _e, item, _ok in self.predictions}
        self.assertGreater(len(distinct), 1, "classifier returned a single label for everything")
        self.assertGreater(correct, 0)


if __name__ == "__main__":
    unittest.main()
