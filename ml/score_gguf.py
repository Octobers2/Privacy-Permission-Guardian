# /// script
# dependencies = ["numpy", "scipy"]
# ///
"""Score letter logprobs that came out of a GGUF model (from spike/wllama/bulk.ts) the way eval_letter.py scores PyTorch logits.
Run with the kev venv:  vendor/kev/.venv/bin/python score_gguf.py --val q.val.json --test q.test.json --name <report-name> [--ref reports/<ref>.test_logits.npy]

Each json file is a list of rows, one per passage, of 9 logprobs (letters A-I) or null where the letter was outside the returned top-N.
A missing letter is set just below the lowest logprob returned for that row: it ranked below every returned token, so its probability is negligible."""
import argparse, json, pathlib, numpy as np
from prompt import NAMES
from metrics import summarize
from calibrate import fit_temperature, softmax, apply_other_bias

ap = argparse.ArgumentParser()
ap.add_argument("--val", required=True); ap.add_argument("--test", required=True); ap.add_argument("--name", required=True)
ap.add_argument("--ref", help="PyTorch test logits (.npy) to compare against")
ap.add_argument("--top-n", type=int, default=100, help="N used when the rows were produced; rows with no returned letters get this floor")
a = ap.parse_args()
H = pathlib.Path(__file__).parent
load = lambda n: [json.loads(l) for l in (H / "data" / f"{n}.jsonl").open()]


def logits(path, n):
    rows = json.load(open(path))[:n]
    out = np.full((len(rows), 9), np.nan)
    missing = 0
    for i, r in enumerate(rows):
        seen = [x for x in r if x is not None]
        floor = (min(seen) if seen else -20.0) - 1.0
        for j, x in enumerate(r):
            out[i, j] = floor if x is None else x
            missing += x is None
    return out, missing / (9 * len(rows))


test, val = load("test"), load("val")
lt, mt = logits(a.test, len(test)); lv, mv = logits(a.val, len(val))
yt = np.array([NAMES.index(r["label_name"]) for r in test[: len(lt)]]); yv = np.array([NAMES.index(r["label_name"]) for r in val[: len(lv)]])
other = NAMES.index("other")
T = fit_temperature(lv, yv)
best = max(np.arange(-3, 3.01, 0.25), key=lambda b: summarize(softmax(apply_other_bias(lv, other, b) / T), yv, other, boots=1)["macro_f1"])
res = {"source": a.test, "temperature": T, "other_bias": float(best), "prompt": "letters-v1", "missing_letter_fraction": {"val": mv, "test": mt}}
for tag, b in (("raw", 0.0), ("T", 0.0), ("T+bias", best)):
    t = 1.0 if tag == "raw" else T
    res[tag] = summarize(softmax(apply_other_bias(lt, other, b) / t), yt, other)
    r = res[tag]; print(f"{tag:7s} macroF1={r['macro_f1']:.3f} {np.round(r['ci95']['macro_f1'],3)} unfairF1={r['unfair_f1']:.3f} acc={r['acc']:.3f} ECE={r['ece']:.3f} Brier={r['brier']:.3f}")
if a.ref:
    ref = np.load(a.ref)[: len(lt)]
    agree = float((ref.argmax(1) == lt.argmax(1)).mean())
    res["argmax_agreement_vs_ref"] = agree
    print(f"argmax agreement with {a.ref}: {agree:.4f} on {len(lt)} passages")
print(f"letters missing from the returned top-N: val {mv:.3%}, test {mt:.3%}")
(H / "reports" / f"{a.name}.json").write_text(json.dumps(res, indent=1))
