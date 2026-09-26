"""
Gaze panel detector — train a personal "am I looking at the top-right panel?" classifier.

    python gaze.py collect     # record labelled examples from your webcam
    python gaze.py train       # train + evaluate a classifier, save gaze_model.pkl
    python gaze.py run         # live detection; sends events to the web page over WebSocket

Setup (once):
    pip install mediapipe websockets numpy
    (mediapipe brings its own OpenCV; don't also install opencv-python, the two clash)

How it works
------------
MediaPipe Face Landmarker gives, per video frame:
  * 478 face landmarks (including the irises)
  * "blendshapes" such as eyeLookUpLeft / eyeLookOutRight (0-1 scores)
  * a head-pose matrix
We turn those into ~24 numbers per frame (where the irises sit inside the eyes,
eye-look scores, head yaw/pitch/roll and position) and train a small classifier:
label 1 = looking at the panel, label 0 = anything else.
"""

import argparse
import asyncio
import csv
import json
import math
import os
import sys
import time
import urllib.request

import numpy as np

MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/face_landmarker/"
             "face_landmarker/float16/1/face_landmarker.task")
LANDMARKER_PATH = "face_landmarker.task"
DATA_PATH = "gaze_data.csv"
MODEL_PATH = "gaze_model.pkl"

# ---------------------------------------------------------------- landmarks
# MediaPipe 478-point face mesh indices
EYES = {
    # name: (outer corner, inner corner, upper lid, lower lid, iris centre)
    "r": (33, 133, 159, 145, 468),
    "l": (263, 362, 386, 374, 473),
}
BLENDSHAPES = [
    "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight",
    "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
    "eyeBlinkLeft", "eyeBlinkRight", "eyeSquintLeft", "eyeSquintRight",
]
FEATURES = (
    [f"{e}_{k}" for e in EYES for k in ("iris_u", "iris_v", "open")]
    + BLENDSHAPES
    + ["yaw", "pitch", "roll", "tx", "ty", "tz"]
)


def ensure_landmarker_model():
    if not os.path.exists(LANDMARKER_PATH):
        print(f"Downloading face model to {LANDMARKER_PATH} ...")
        urllib.request.urlretrieve(MODEL_URL, LANDMARKER_PATH)


def make_landmarker():
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision
    ensure_landmarker_model()
    opts = vision.FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=LANDMARKER_PATH),
        running_mode=vision.RunningMode.VIDEO,
        num_faces=1,
        output_face_blendshapes=True,
        output_facial_transformation_matrixes=True,
    )
    return mp, vision.FaceLandmarker.create_from_options(opts)


def extract_features(result):
    """MediaPipe result -> feature vector (np.array) or None if no face."""
    if not result.face_landmarks:
        return None
    lm = result.face_landmarks[0]
    P = lambda i: np.array([lm[i].x, lm[i].y])

    feats = []
    for outer, inner, up, low, iris in EYES.values():
        o, n, c = P(outer), P(inner), P(iris)
        axis = o - n
        width = np.linalg.norm(axis) + 1e-9
        u = np.dot(c - n, axis) / width**2          # 0 = inner corner, 1 = outer corner
        perp = np.array([-axis[1], axis[0]]) / width
        v = np.dot(c - (n + o) / 2, perp) / width   # vertical iris offset, eye-width units
        opening = np.linalg.norm(P(up) - P(low)) / width
        feats += [u, v, opening]

    scores = {c.category_name: c.score for c in result.face_blendshapes[0]} if result.face_blendshapes else {}
    feats += [scores.get(name, 0.0) for name in BLENDSHAPES]

    if result.facial_transformation_matrixes:
        M = np.asarray(result.facial_transformation_matrixes[0])
        R = M[:3, :3]
        pitch = math.degrees(math.atan2(R[2, 1], R[2, 2]))
        yaw = math.degrees(math.asin(max(-1.0, min(1.0, -R[2, 0]))))
        roll = math.degrees(math.atan2(R[1, 0], R[0, 0]))
        tx, ty, tz = M[:3, 3]
    else:
        pitch = yaw = roll = tx = ty = tz = 0.0
    feats += [yaw, pitch, roll, tx, ty, tz]
    return np.array(feats, dtype=float)


class Camera:
    def __init__(self, source=0, width=640, height=480):
        import cv2
        self.cv2 = cv2
        src = int(source) if str(source).isdigit() else source
        self.cap = cv2.VideoCapture(src)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        if not self.cap.isOpened():
            sys.exit(f"Could not open camera {source!r}. Try --camera 1, or check camera permissions.")
        self.mp, self.landmarker = make_landmarker()
        self.t0 = time.monotonic()
        self.last_ts = -1

    def read(self):
        """Returns (frame_bgr, features or None). frame is None when the stream ends."""
        ok, frame = self.cap.read()
        if not ok:
            return None, None
        frame = self.cv2.flip(frame, 1)  # mirror, feels natural in the preview
        rgb = self.cv2.cvtColor(frame, self.cv2.COLOR_BGR2RGB)
        img = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=rgb)
        ts = int((time.monotonic() - self.t0) * 1000)
        ts = max(ts, self.last_ts + 1)   # timestamps must strictly increase
        self.last_ts = ts
        result = self.landmarker.detect_for_video(img, ts)
        return frame, extract_features(result)

    def close(self):
        self.cap.release()
        self.cv2.destroyAllWindows()


def put(frame, text, y, color=(255, 255, 255), scale=0.6):
    import cv2
    cv2.putText(frame, text, (12, y), cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), 4, cv2.LINE_AA)
    cv2.putText(frame, text, (12, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 1, cv2.LINE_AA)


# ---------------------------------------------------------------- collect
def cmd_collect(args):
    """
    Press P -> 2s countdown, then 5s of 'looking at panel' frames.
    Press A -> same for 'away'. Do many short takes, varying head position.
    """
    import cv2
    cam = Camera(args.camera)
    new_file = not os.path.exists(DATA_PATH)
    f = open(DATA_PATH, "a", newline="")
    w = csv.writer(f)
    if new_file:
        w.writerow(["session", "take", "label", "t"] + FEATURES)

    session = time.strftime("%Y%m%d-%H%M%S")
    take = 0
    counts = {0: 0, 1: 0}
    takes = {0: 0, 1: 0}
    if not new_file:  # show totals already on disk
        with open(DATA_PATH) as rf:
            for row in csv.DictReader(rf):
                counts[int(row["label"])] += 1
    state, label, phase_end = "idle", None, 0.0
    away_tips = ["the lecturer (stand-in person)", "the slides / board", "your notes / keyboard",
                 "middle of your screen", "just LEFT of the panel", "just BELOW the panel",
                 "top-left of your screen", "your phone"]

    win = "collect (P = panel, A = away, Q = quit)"
    cv2.namedWindow(win)
    cv2.moveWindow(win, 20, 400)   # keep the preview away from the top-right panel
    print(__doc__.split("How it works")[0])
    print("Keep the web page (or anything) in the TOP-RIGHT of your screen as the panel target.")

    while True:
        frame, feats = cam.read()
        if frame is None:
            break
        now = time.monotonic()

        if state == "countdown" and now >= phase_end:
            state, phase_end = "recording", now + args.seconds
            print("\a", end="", flush=True)
        elif state == "recording" and now >= phase_end:
            state = "idle"
            takes[label] += 1
            print(f"  take done. frames: panel={counts[1]} away={counts[0]}")

        if state == "recording" and feats is not None:
            w.writerow([session, f"{session}-{take}", label, round(now, 3)] + [round(x, 5) for x in feats])
            counts[label] += 1

        # overlay
        if feats is None:
            put(frame, "NO FACE", 30, (0, 0, 255), 0.8)
        if state == "idle":
            put(frame, "P = record PANEL   A = record AWAY   Q = quit", 30)
            nxt = away_tips[takes[0] % len(away_tips)]
            put(frame, f"next AWAY idea: {nxt}", 58, (180, 220, 255))
        elif state == "countdown":
            what = "PANEL (top-right)" if label == 1 else "AWAY"
            put(frame, f"get ready: look at {what}  {phase_end - now:.1f}", 30, (0, 255, 255), 0.7)
        else:
            what = "PANEL" if label == 1 else "AWAY"
            put(frame, f"RECORDING {what}  {phase_end - now:.1f}s", 30, (0, 0, 255), 0.8)
        put(frame, f"frames  panel={counts[1]}  away={counts[0]}   takes this session  panel={takes[1]}  away={takes[0]}",
            frame.shape[0] - 14, (200, 200, 200), 0.45)
        cv2.imshow(win, frame)

        k = cv2.waitKey(1) & 0xFF
        if k == ord("q"):
            break
        if state == "idle" and k in (ord("p"), ord("a")):
            label = 1 if k == ord("p") else 0
            take += 1
            state, phase_end = "countdown", now + 2.0

    f.close()
    cam.close()
    print(f"Saved to {DATA_PATH}. Totals: panel={counts[1]} away={counts[0]}")


# ---------------------------------------------------------------- train
# Pure-numpy models (no scikit-learn / pandas: their DLLs can be blocked by
# Windows Smart App Control or school/work device policies).

def _sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))


class NumpyClassifier:
    """kind='logistic' : L2-regularised logistic regression
       kind='mlp'      : 1 hidden layer (tanh) neural net
       Both standardise inputs and weight classes equally. Trained with Adam, full batch."""

    def __init__(self, kind="logistic", hidden=16, l2=1e-3, steps=1500, lr=0.03, seed=0):
        self.kind, self.hidden, self.l2, self.steps, self.lr, self.seed = kind, hidden, l2, steps, lr, seed

    def _forward(self, Xs):
        if self.kind == "logistic":
            return _sigmoid(Xs @ self.W1 + self.b1).ravel(), None
        H = np.tanh(Xs @ self.W1 + self.b1)
        return _sigmoid(H @ self.W2 + self.b2).ravel(), H

    def fit(self, X, y):
        rng = np.random.default_rng(self.seed)
        self.mu, self.sd = X.mean(0), X.std(0) + 1e-6
        Xs = (X - self.mu) / self.sd
        n, d = Xs.shape
        # class weights so both classes count equally
        w = np.where(y == 1, 0.5 / max(y.mean(), 1e-9), 0.5 / max(1 - y.mean(), 1e-9)) / n
        if self.kind == "logistic":
            self.W1, self.b1 = np.zeros((d, 1)), np.zeros(1)
            params = ["W1", "b1"]
        else:
            self.W1 = rng.normal(0, 1 / np.sqrt(d), (d, self.hidden)); self.b1 = np.zeros(self.hidden)
            self.W2 = rng.normal(0, 1 / np.sqrt(self.hidden), (self.hidden, 1)); self.b2 = np.zeros(1)
            params = ["W1", "b1", "W2", "b2"]
        m = {p: np.zeros_like(getattr(self, p)) for p in params}
        v = {p: np.zeros_like(getattr(self, p)) for p in params}
        for t in range(1, self.steps + 1):
            p_hat, H = self._forward(Xs)
            g = ((p_hat - y) * w)[:, None]             # dLoss/dlogit
            if self.kind == "logistic":
                grads = {"W1": Xs.T @ g + self.l2 * self.W1, "b1": g.sum(0)}
            else:
                dH = (g @ self.W2.T) * (1 - H**2)
                grads = {"W2": H.T @ g + self.l2 * self.W2, "b2": g.sum(0),
                         "W1": Xs.T @ dH + self.l2 * self.W1, "b1": dH.sum(0)}
            for p in params:
                m[p] = 0.9 * m[p] + 0.1 * grads[p]
                v[p] = 0.999 * v[p] + 0.001 * grads[p] ** 2
                mh, vh = m[p] / (1 - 0.9**t), v[p] / (1 - 0.999**t)
                setattr(self, p, getattr(self, p) - self.lr * mh / (np.sqrt(vh) + 1e-8))
        return self

    def predict_proba(self, X):
        p, _ = self._forward((np.atleast_2d(X) - self.mu) / self.sd)
        return np.column_stack([1 - p, p])


def load_data():
    with open(DATA_PATH, newline="") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        sys.exit(f"{DATA_PATH} is empty. Run `collect` first.")
    X = np.array([[float(r[c]) for c in FEATURES] for r in rows])
    y = np.array([int(r["label"]) for r in rows])
    groups = np.array([r["take"] for r in rows])
    t = np.array([float(r["t"]) for r in rows])
    return X, y, groups, t


def grouped_folds(y, groups, k):
    """Split whole takes into k folds, keeping both classes in every fold."""
    folds = [[] for _ in range(k)]
    for lab in (0, 1):
        takes = sorted(set(groups[y == lab]))
        np.random.default_rng(0).shuffle(takes)
        for i, tk in enumerate(takes):
            folds[i % k].append(tk)
    return [np.isin(groups, f) for f in folds]


def cmd_train(args):
    import pickle
    X, y, groups, ts = load_data()
    n_takes = {lab: len(set(groups[y == lab])) for lab in (0, 1)}
    print(f"{len(y)} frames | panel: {(y==1).sum()} frames / {n_takes[1]} takes | "
          f"away: {(y==0).sum()} frames / {n_takes[0]} takes")
    if min(n_takes.values()) < 3:
        sys.exit("Need at least 3 takes of each class (more like 8+). Run `collect` again.")

    # Cross-validate by TAKE, not by frame: neighbouring frames are near-identical,
    # so a random split would leak and give fake ~100% accuracy.
    folds = grouped_folds(y, groups, min(5, min(n_takes.values())))
    candidates = {
        "logistic": lambda: NumpyClassifier("logistic"),
        "neural_net": lambda: NumpyClassifier("mlp", hidden=16, l2=1e-2),
    }
    best, best_score = None, -1
    for name, make in candidates.items():
        pred = np.zeros_like(y)
        for test in folds:
            mdl = make().fit(X[~test], y[~test])
            pred[test] = (mdl.predict_proba(X[test])[:, 1] >= 0.5).astype(int)
        tp = ((pred == 1) & (y == 1)).sum(); fn = ((pred == 0) & (y == 1)).sum()
        tn = ((pred == 0) & (y == 0)).sum(); fp = ((pred == 1) & (y == 0)).sum()
        score = 0.5 * (tp / (tp + fn) + tn / (tn + fp))
        print(f"  {name:11s} balanced acc {score:.3f} | false 'panel' {fp/(fp+tn):.1%} of away frames | "
              f"missed panel {fn/(fn+tp):.1%} of panel frames")
        if score > best_score:
            best, best_score = name, score

    # Per-take breakdown (held-out predictions from the best model), so you can see
    # WHICH kinds of 'away' look get mistaken for the panel.
    pred_p = np.zeros(len(y))
    for test in folds:
        pred_p[test] = candidates[best]().fit(X[~test], y[~test]).predict_proba(X[test])[:, 1]
    away_tips = ["lecturer", "slides/board", "notes/keyboard", "middle of screen",
                 "just LEFT of panel", "just BELOW panel", "top-left of screen", "phone"]
    take_order = list(dict.fromkeys(groups))            # takes in recording order
    away_idx = {}                                       # away-take index within its session
    for tk in take_order:
        if y[groups == tk][0] == 0:
            sess = tk.rsplit("-", 1)[0]
            away_idx[tk] = sum(1 for t in away_idx if t.rsplit("-", 1)[0] == sess)
    print(f"\nPer take ({best}, held out) — % of frames predicted PANEL:")
    by_tip = {}
    for tk in take_order:
        mask = groups == tk
        lab, pct = y[mask][0], (pred_p[mask] >= 0.5).mean()
        if lab == 1:
            print(f"  PANEL {tk:26s} {pct:6.0%}   {'<- often missed' if pct < 0.5 else ''}")
        else:
            tip = away_tips[away_idx[tk] % len(away_tips)]
            by_tip.setdefault(tip, []).append(pct)
            print(f"  away  {tk:26s} {pct:6.0%}   ({tip}) {'<- confused with panel' if pct > 0.5 else ''}")
    print("\nAway looks, averaged (want these near 0%):")
    for tip, v in sorted(by_tip.items(), key=lambda kv: -np.mean(kv[1])):
        print(f"  {tip:20s} {np.mean(v):5.0%} predicted panel  ({len(v)} takes)")
    print("(Labels assume you followed the on-screen AWAY suggestion for each take.)")

    # ---- Calibration: temperature-scale the held-out logits so that
    #      "p = 0.9" really means ~9:1 odds. Needed for the evidence test.
    logit = np.log(np.clip(pred_p, 1e-6, 1 - 1e-6) / np.clip(1 - pred_p, 1e-6, 1))
    wts = np.where(y == 1, 0.5 / y.mean(), 0.5 / (1 - y.mean()))
    def wloss(T):
        q = _sigmoid(logit / T)
        return -np.mean(wts * (y * np.log(q + 1e-9) + (1 - y) * np.log(1 - q + 1e-9)))
    Ts = np.exp(np.linspace(np.log(0.25), np.log(8), 60))
    T = float(Ts[np.argmin([wloss(T) for T in Ts])])
    print(f"\nCalibration temperature T = {T:.2f}  (>1 means the model was over-confident)")

    # ---- Simulate the evidence detector on each held-out take, in recorded order.
    print(f"\nSimulated signal (false_alarm={args.false_alarm}, miss={args.miss}, scale={args.scale}):")
    false_alarms, latencies, missed = [], [], 0
    for tk in take_order:
        mask = groups == tk
        det = EvidenceDetector(args.false_alarm, args.miss, args.leave_false_alarm, args.scale, args.clip, T)
        fired_at = None
        for p, tt in zip(pred_p[mask], ts[mask]):
            if det.update(float(p)) == "panel":
                fired_at = tt - ts[mask][0]
                break
        if y[mask][0] == 0:
            false_alarms.append(fired_at is not None)
        elif fired_at is None:
            missed += 1
        else:
            latencies.append(fired_at)
    n_away, n_panel = len(false_alarms), n_takes[1]
    print(f"  AWAY takes that wrongly fired 'panel': {sum(false_alarms)}/{n_away}")
    print(f"  PANEL takes detected: {n_panel - missed}/{n_panel}"
          + (f", median delay {np.median(latencies):.2f}s (max {max(latencies):.2f}s)" if latencies else ""))
    if sum(false_alarms) > 0:
        print("  -> too many false signals: try  --false-alarm 0.001  or  --scale 0.2  (slower but stricter)")
    elif latencies and np.median(latencies) > 1.5:
        print("  -> reliable but slow: try  --false-alarm 0.05  or  --scale 0.5")
    print("  Use the same flags with `run`, e.g.  py gaze.py run --false-alarm 0.001")

    model = candidates[best]().fit(X, y)
    with open(MODEL_PATH, "wb") as f:
        pickle.dump({"model": model, "features": FEATURES, "name": best, "cv_bal_acc": best_score,
                     "temperature": T}, f)
    print(f"\nSaved {best} -> {MODEL_PATH} (per-frame CV balanced accuracy {best_score:.3f}).")
    print("Per-frame errors get accumulated into evidence in `run`, so the simulation above matters more than this number.")
    if best_score < 0.8:
        print("Tip: add more varied AWAY takes, especially just outside the panel and looking up at the lecturer.")


# ---------------------------------------------------------------- run
class EvidenceDetector:
    """
    Sequential test (Wald SPRT with a floor at 0, i.e. Page's CUSUM) on the
    classifier's per-frame log-likelihood ratio  log P(frame|panel) / P(frame|away).

      * The classifier is trained with balanced classes, so its calibrated logit
        IS that log-likelihood ratio.
      * While 'away' we add up evidence FOR panel. Evidence for 'away' pulls the
        sum down but never below 0, so ten minutes of looking away doesn't have
        to be "paid back" before a real glance can register.
      * Signal 'panel' when the sum reaches  h = log((1 - miss) / false_alarm)
        (Wald's threshold). Leaving works the same way in reverse.

    Caveat: webcam frames are strongly correlated, not independent, so summing
    raw per-frame evidence would overstate it. `scale` < 1 discounts each frame
    (0.3 ~ "about 3 frames count as one independent look"), and `clip` stops a
    single over-confident frame from deciding on its own. So the error rates
    are approximate. Check them with the simulation that `train` prints.
    """

    def __init__(self, false_alarm=0.01, miss=0.05, leave_false_alarm=0.05,
                 scale=0.3, clip=3.0, temperature=1.0):
        self.h_enter = math.log((1 - miss) / false_alarm)
        self.h_leave = math.log((1 - miss) / leave_false_alarm)
        self.scale, self.clip, self.T = scale, clip, temperature
        self.S, self.state = 0.0, "away"

    def frame_llr(self, prob):
        if prob is None:                       # no face -> firm evidence for away
            return -self.clip * self.scale
        p = min(max(prob, 1e-6), 1 - 1e-6)
        llr = math.log(p / (1 - p)) / self.T
        return self.scale * max(-self.clip, min(self.clip, llr))

    @property
    def threshold(self):
        return self.h_enter if self.state == "away" else self.h_leave

    def update(self, prob):
        """prob = P(panel) this frame, or None if no face. Returns the new state if it changed."""
        llr = self.frame_llr(prob)
        self.S = max(0.0, self.S + (llr if self.state == "away" else -llr))
        if self.S >= self.threshold:
            self.state = "panel" if self.state == "away" else "away"
            evidence, self.S = self.S, 0.0
            self.last_evidence = evidence
            return self.state
        return None


class TerminalSignal:
    """Prints the PANEL / NOT PANEL signal in the terminal:
       * a live status line, redrawn in place ~10x per second
       * a permanent line every time the signal changes"""

    GREEN, YELLOW, GREY, BOLD, RESET = "\033[92m", "\033[93m", "\033[90m", "\033[1m", "\033[0m"

    def __init__(self):
        if os.name == "nt":
            os.system("")           # turns on colour codes in Windows terminals
        self.last_draw = 0.0

    def label(self, state):
        return (f"{self.GREEN}{self.BOLD}  PANEL  {self.RESET}" if state == "panel"
                else f"{self.YELLOW}{self.BOLD}NOT PANEL{self.RESET}")

    def status(self, det, prob):
        now = time.monotonic()
        if now - self.last_draw < 0.1:
            return
        self.last_draw = now
        frac = min(1.0, det.S / det.threshold)
        bar = "#" * int(frac * 20) + "-" * (20 - int(frac * 20))
        towards = "panel" if det.state == "away" else "not panel"
        p = " no face" if prob is None else f"p={prob:.2f}"
        line = (f"\r{self.label(det.state)}  {p}  evidence toward {towards:9s} "
                f"[{bar}] {det.S:4.1f}/{det.threshold:.1f}   ")
        sys.stdout.write(line)
        sys.stdout.flush()

    def change(self, state, evidence, t_ms, since_ms=None):
        stamp = time.strftime("%H:%M:%S")
        extra = f"  (recap covers last {(t_ms - since_ms) / 1000:.0f}s)" if since_ms else ""
        sys.stdout.write(f"\r{' ' * 100}\r{stamp}  >>> {self.label(state)}  "
                         f"{self.GREY}evidence {evidence:.1f} nats, ~{math.exp(evidence):.0f}:1{extra}{self.RESET}\n")
        sys.stdout.flush()
        self.last_draw = 0.0


async def run_async(args):
    import pickle
    if not os.path.exists(MODEL_PATH):
        sys.exit(f"No {MODEL_PATH} yet. Run `collect` then `train` first.")
    with open(MODEL_PATH, "rb") as f:
        bundle = pickle.load(f)
    model = bundle["model"]
    if bundle["features"] != FEATURES:
        sys.exit("Model was trained with different features. Re-run `train`.")
    print(f"Loaded {bundle['name']} (CV balanced acc {bundle['cv_bal_acc']:.3f})")

    clients = set()
    last_left_panel = int(time.time() * 1000)

    async def broadcast(msg):
        data = json.dumps(msg)
        for ws in list(clients):
            try:
                await ws.send(data)
            except Exception:
                clients.discard(ws)

    async def handler(ws):
        clients.add(ws)
        await ws.send(json.dumps({"type": "zone", "zone": sm.state, "t": int(time.time() * 1000), "since": last_left_panel}))
        try:
            async for _ in ws:
                pass
        finally:
            clients.discard(ws)

    T = bundle.get("temperature", 1.0)
    sm = EvidenceDetector(args.false_alarm, args.miss, args.leave_false_alarm, args.scale, args.clip, T)
    print(f"Signal when evidence >= {sm.h_enter:.2f} nats (likelihood ratio {math.exp(sm.h_enter):.0f}:1), "
          f"false_alarm={args.false_alarm}, miss={args.miss}, temperature={T:.2f}")
    cam = Camera(args.camera)
    import cv2
    from websockets.asyncio.server import serve

    term = TerminalSignal()
    async with serve(handler, "localhost", args.port):
        print(f"WebSocket on ws://localhost:{args.port}  — open index.html?source=python")
        print("Press Q in the preview window (or Ctrl+C here) to stop.\n")
        frames, fps_t, fps = 0, time.monotonic(), 0.0
        while True:
            frame, feats = await asyncio.to_thread(cam.read)
            if frame is None:
                break
            prob = None if feats is None else float(model.predict_proba(feats.reshape(1, -1))[0, 1])
            now_ms = int(time.time() * 1000)
            changed = sm.update(prob)
            if changed:
                msg = {"type": "zone", "zone": changed, "t": now_ms,
                       "evidence_nats": round(sm.last_evidence, 2),
                       "likelihood_ratio": round(math.exp(sm.last_evidence), 1)}
                if changed == "panel":
                    msg["since"] = last_left_panel   # summarise transcript from `since` to `t`
                else:
                    last_left_panel = now_ms
                await broadcast(msg)
                term.change(changed, sm.last_evidence, now_ms, msg.get("since"))
            term.status(sm, prob)

            frames += 1
            if time.monotonic() - fps_t >= 1:
                fps, frames, fps_t = frames / (time.monotonic() - fps_t), 0, time.monotonic()
            if not args.no_preview:
                col = (0, 200, 0) if sm.state == "panel" else (0, 165, 255)
                put(frame, f"{sm.state.upper()}", 34, col, 1.0)
                target = "panel" if sm.state == "away" else "away"
                put(frame, f"p(panel)={'-' if prob is None else f'{prob:.2f}'}  evidence for {target}: "
                           f"{sm.S:.1f}/{sm.threshold:.1f}  {fps:.0f} fps  clients={len(clients)}", 62, scale=0.5)
                full = frame.shape[1] - 24
                cv2.rectangle(frame, (12, 72), (12 + full, 84), (80, 80, 80), 1)
                bar = int(min(1.0, sm.S / sm.threshold) * full)
                cv2.rectangle(frame, (12, 72), (12 + bar, 84), (0, 200, 0) if target == "panel" else (0, 165, 255), -1)
                cv2.imshow("gaze run (Q = quit)", frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
            else:
                await asyncio.sleep(0)
    cam.close()


def cmd_run(args):
    try:
        asyncio.run(run_async(args))
    except KeyboardInterrupt:
        pass


# ---------------------------------------------------------------- main
def add_detector_args(p):
    p.add_argument("--false-alarm", type=float, default=0.01,
                   help="target chance of signalling 'panel' when you're NOT looking at it (alpha)")
    p.add_argument("--miss", type=float, default=0.05,
                   help="target chance of failing to signal when you ARE looking (beta)")
    p.add_argument("--leave-false-alarm", type=float, default=0.05,
                   help="alpha for deciding you've looked away again (can be looser)")
    p.add_argument("--scale", type=float, default=0.3,
                   help="evidence per frame is multiplied by this (frames are correlated, not independent)")
    p.add_argument("--clip", type=float, default=3.0, help="max |log-likelihood ratio| from one frame")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("collect", help="record labelled webcam examples")
    c.add_argument("--camera", default="0", help="camera index or video file")
    c.add_argument("--seconds", type=float, default=5.0, help="length of each take")

    t = sub.add_parser("train", help="train and evaluate the classifier")
    add_detector_args(t)

    r = sub.add_parser("run", help="live detection + WebSocket events")
    r.add_argument("--camera", default="0")
    r.add_argument("--port", type=int, default=8765)
    add_detector_args(r)
    r.add_argument("--no-preview", action="store_true")

    if len(sys.argv) == 1:   # e.g. pressed Run in VS Code with no arguments
        choice = input("Which step? [c]ollect / [t]rain / [r]un: ").strip().lower()[:1]
        sys.argv.append({"c": "collect", "t": "train", "r": "run"}.get(choice, "collect"))
    args = ap.parse_args()
    {"collect": cmd_collect, "train": cmd_train, "run": cmd_run}[args.cmd](args)r