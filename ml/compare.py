"""Is run B really better than run A? Paired bootstrap on the same test sentences.

The test set has 8 arbitration and 13 content-removal sentences, so the separate 95% intervals of two runs overlap even
when one is genuinely better. Resampling the same sentences for both runs cancels most of that noise.
run: python3 compare.py reports/<A>.json reports/<B>.json [--boots 2000]
Uses each report's temperature and its decision rule (threshold if the report kept one and --threshold is given)."""
import argparse, json, pathlib, numpy as np
from prompt import NAMES
from calibrate import softmax, decide
from metrics import confusion, prf

ap = argparse.ArgumentParser(); ap.add_argument("a"); ap.add_argument("b"); ap.add_argument("--boots", type=int, default=2000)
ap.add_argument("--threshold", action="store_true", help="use each report's other_threshold (when it has one)"); ap.add_argument("--test-file", default="test")
a = ap.parse_args()
H = pathlib.Path(__file__).parent; O = NAMES.index("other")
y = np.array([NAMES.index(json.loads(l)["label_name"]) for l in (H / "data" / f"{a.test_file}.jsonl").open()])

def preds(report):
    r = json.load(open(report)); lg = np.load(report.replace(".json", ".test_logits.npy"))
    assert len(lg) == len(y), f"{report}: {len(lg)} logits for {len(y)} test sentences"
    return decide(softmax(lg / r["temperature"]), O, r.get("other_threshold") if a.threshold else None)

def macro(yy, pp):
    _, _, f1 = prf(confusion(yy, pp, 9)); return f1[np.bincount(yy, minlength=9) > 0].mean()

pa, pb = preds(a.a), preds(a.b)
d0 = macro(y, pb) - macro(y, pa)
rng = np.random.default_rng(0); ds = []
for _ in range(a.boots):
    i = rng.integers(0, len(y), len(y)); ds.append(macro(y[i], pb[i]) - macro(y[i], pa[i]))
lo, hi = np.percentile(ds, [2.5, 97.5])
print(f"macro-F1  A {macro(y, pa):.3f}   B {macro(y, pb):.3f}   B - A = {d0:+.3f}  (95% CI {lo:+.3f} .. {hi:+.3f};  B better in {np.mean(np.array(ds) > 0)*100:.0f}% of resamples)")
print("  per class (F1 A -> B):", ", ".join(f"{NAMES[k][:12]} {fa:.2f}->{fb:.2f}" for k, fa, fb in zip(range(9), prf(confusion(y, pa, 9))[2], prf(confusion(y, pb, 9))[2]) if k != O))
print("  verdict:", "B is better" if lo > 0 else "A is better" if hi < 0 else "no clear difference")
