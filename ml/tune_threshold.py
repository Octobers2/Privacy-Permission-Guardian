"""Chooses the flag threshold on P(other): a sentence is flagged when P(other) < threshold (see calibrate.decide).

The validation split is small (4 arbitration sentences), so a threshold picked by maximising one F1 number on it swings
wildly; that is why the old 'other' bias (-3 .. +2.75 between runs) never shipped. Three things keep this one sane:
  * the default objective, "balanced", is the mean of macro-F1 (the headline number) and the flag-or-not F1 that pools
    all eight unfair classes (about 80 positive sentences in val instead of 4-22 per class), so neither a single rare
    class nor "flag everything" can win on its own;
  * each candidate is scored by its mean over bootstrap resamples of val, and the centre of the best plateau is taken;
  * the threshold is only kept if it beats plain argmax on that same smoothed score by --min-gain; otherwise tune()
    returns threshold None and the model ships without one (argmax, as before).

Library: tune(probs, y, other_id) -> dict. CLI (on validation logits saved by eval_letter.py):
    python3 tune_threshold.py reports/<name>.val_logits.npy --temperature T [--objective balanced|macro_f1|unfair_f1|recall:0.9]
`recall:0.9` is the product choice "catch at least 90% of unfair sentences on val, with as few false alarms as that allows".

Checked on the shipped models' saved test logits (tune on a random half, score the other half, 20 times; a check of the
method, not a reportable result): an F1-tuned threshold changes held-out macro-F1 by about 0 (-0.002 for 0.8B, -0.004
for 4B; even the best threshold in hindsight adds only ~0.01), so argmax is already near optimal and write_meta.py
ships no threshold unless asked. The recall dial does what it says: aiming at 0.90 gave 0.90 on the unseen half, at a
cost of false alarms on 10% (0.8B) / 6% (4B) of fair sentences, against 2.6% / 3.0% for argmax (recall 0.82 / 0.84)."""
import argparse, json, pathlib
import numpy as np
from calibrate import decide, softmax
from metrics import confusion, prf

GRID = np.round(np.arange(0.10, 0.995, 0.01), 2)

def _scores(probs, y, other_id, t):
    pred = decide(probs, other_id, t); k = probs.shape[1]
    _, _, f1 = prf(confusion(y, pred, k)); present = np.bincount(y, minlength=k) > 0
    bt, bp = y != other_id, pred != other_id
    tp, fp, fn = (bt & bp).sum(), (~bt & bp).sum(), (bt & ~bp).sum()
    s = dict(macro_f1=float(f1[present].mean()), unfair_f1=float(2 * tp / max(2 * tp + fp + fn, 1)),
             unfair_recall=float(tp / max(tp + fn, 1)), unfair_precision=float(tp / max(tp + fp, 1)))
    s["balanced"] = (s["macro_f1"] + s["unfair_f1"]) / 2
    return s

def tune(probs, y, other_id, objective="balanced", boots=300, seed=0, min_gain=0.005):
    """Returns {"threshold" (None = keep argmax), "objective", "val": full-val scores of the chosen rule, "argmax_val": of argmax}."""
    probs, y = np.asarray(probs), np.asarray(y)
    base = _scores(probs, y, other_id, None)
    if objective.startswith("recall:"):
        # the lowest threshold (fewest flags, so fewest false alarms) that still catches the wanted share of unfair sentences
        want = float(objective.split(":")[1])
        ok = [t for t in GRID if _scores(probs, y, other_id, t)["unfair_recall"] >= want]
        best = float(min(ok)) if ok else float(GRID[-1])
        return dict(threshold=best, objective=objective, val=_scores(probs, y, other_id, best), argmax_val=base)
    rng = np.random.default_rng(seed); samples = [rng.integers(0, len(y), len(y)) for _ in range(boots)]
    smooth = lambda t: float(np.mean([_scores(probs[s], y[s], other_id, t)[objective] for s in samples]))
    mean = {t: smooth(t) for t in GRID}
    top_t = max(GRID, key=lambda t: mean[t]); top = mean[top_t]
    # the contiguous run of thresholds within 0.002 of the best, around the best one; its centre is the safest choice
    i = j = int(np.where(GRID == top_t)[0][0])
    while i > 0 and mean[GRID[i - 1]] >= top - 0.002: i -= 1
    while j < len(GRID) - 1 and mean[GRID[j + 1]] >= top - 0.002: j += 1
    best = float(GRID[(i + j) // 2]); argmax_smooth = smooth(None)
    keep = mean[best] >= argmax_smooth + min_gain
    return dict(threshold=best if keep else None, objective=objective, val=_scores(probs, y, other_id, best if keep else None), argmax_val=base,
                smoothed=dict(best=mean[best], argmax=argmax_smooth, candidate=best, kept=bool(keep)))

if __name__ == "__main__":
    from prompt import NAMES
    ap = argparse.ArgumentParser(); ap.add_argument("logits"); ap.add_argument("--temperature", type=float, required=True)
    ap.add_argument("--val-file", default="val"); ap.add_argument("--objective", default="balanced"); a = ap.parse_args()
    H = pathlib.Path(__file__).parent
    y = np.array([NAMES.index(json.loads(l)["label_name"]) for l in (H / "data" / f"{a.val_file}.jsonl").open()])
    print(json.dumps(tune(softmax(np.load(a.logits) / a.temperature), y, NAMES.index("other"), a.objective), indent=1))
