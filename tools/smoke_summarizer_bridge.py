import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend.schemas import ClassifiedMissedItem, MissedWindowRecord
from backend.summarizer_bridge import summarize_windows, warm_up, status

print("status:", status()); print("warm-up:", warm_up())
text = ("IMPORTANT CHANGE. The first assignment is now due on Friday, not Monday. "
        "Please submit it through the course website rather than by email. "
        "Elasticity measures how quantity changes relative to a change in price.")
w = MissedWindowRecord(start_ms=0, end_ms=15000, raw_text=text, items=[ClassifiedMissedItem(
    start_ms=0, end_ms=6000, priority=3, kind="instruction_change",
    text="The first assignment is now due on Friday, not Monday.")])
t0 = time.perf_counter(); out = summarize_windows([w], max_words=60)
print(f"{time.perf_counter()-t0:.1f}s ->", out)
assert out["summarizer_ok"], out["error"]; assert "Friday" in out["summary"]; print("OK")
