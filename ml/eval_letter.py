# /// script
# dependencies = ["numpy", "scipy"]
# ///
"""Letter-format eval. Run with the kev venv:  vendor/kev/.venv/bin/python eval_letter.py --adapter kev|<dir> --name <report-name>
Temperature, the optional 'other' bias and the flag threshold are all fit on val only, then applied to test.

  --prompt letters-v2   evaluate a model trained on the v2 prompt (definitions + previous sentence)
  --no-context          v2 with every previous sentence blanked (to measure what the context adds)
  --objective           what the flag threshold optimises on val: balanced (default), macro_f1, unfair_f1, or recall:0.9
                        (see tune_threshold.py; with 'balanced' etc. no threshold is kept unless it beats argmax on val)

Writes reports/<name>.json, <name>.test_logits.npy and <name>.val_logits.npy (the last lets tune_threshold.py re-tune
without the GPU). The report's "T+threshold" block is what the extension does when the bundle ships a threshold."""
import argparse, json, pathlib, numpy as np
from prompt import NAMES, PROMPT_VERSION
from metrics import summarize
from calibrate import fit_temperature, softmax, apply_other_bias, decide
from tune_threshold import tune
import letter

ap = argparse.ArgumentParser()
ap.add_argument("--adapter", default="kev"); ap.add_argument("--name", required=True); ap.add_argument("--test-file", default="test", help="data/<name>.jsonl to score instead of the benchmark test set (same labels)")
ap.add_argument("--base", default=letter.BASE, help="HF dir/id of the backbone (use with --adapter none for merged/quantized checkpoints)")
ap.add_argument("--prompt", default=PROMPT_VERSION, choices=["letters-v1", "letters-v2"]); ap.add_argument("--no-context", action="store_true")
ap.add_argument("--objective", default="balanced")
a = ap.parse_args()
H = pathlib.Path(__file__).parent
load = lambda n: [json.loads(l) for l in (H / "data" / f"{n}.jsonl").open()]
val, test = load("val"), load(a.test_file)
yv = np.array([NAMES.index(r["label_name"]) for r in val]); yt = np.array([NAMES.index(r["label_name"]) for r in test])

m = letter.LetterModel(None if a.adapter == "none" else letter.KEV if a.adapter == "kev" else a.adapter, base=a.base)
ctx = not a.no_context
lv = letter.score_prompts(m, letter.tos_prompts(val, a.prompt, ctx)).numpy(); lt = letter.score_prompts(m, letter.tos_prompts(test, a.prompt, ctx)).numpy()
other = NAMES.index("other")
T = fit_temperature(lv, yv)
# bias on 'other' chosen on val for macro-F1 (noisy: val has 4-22 examples per rare class); kept for comparison with old reports
best = max(np.arange(-3, 3.01, 0.25), key=lambda b: summarize(softmax(apply_other_bias(lv, other, b) / T), yv, other, boots=1)["macro_f1"])
thr = tune(softmax(lv / T), yv, other, a.objective)
res = {"adapter": a.adapter, "temperature": T, "other_bias": float(best), "other_threshold": thr["threshold"], "threshold_tuning": thr,
       "prompt": a.prompt, "context": ctx if a.prompt != PROMPT_VERSION else None}

def thresholded(probs, t):
    """summarize() scores argmax, so hand it one-hot rows of the thresholded decision (its ECE/Brier then mean nothing)."""
    return np.eye(probs.shape[1])[decide(probs, other, t)]

for tag, b in (("raw", 0.0), ("T", 0.0), ("T+bias", best)):
    t = 1.0 if tag == "raw" else T
    res[tag] = summarize(softmax(apply_other_bias(lt, other, b) / t), yt, other)
res["T+threshold"] = summarize(thresholded(softmax(lt / T), thr["threshold"]), yt, other)
for tag in ("raw", "T", "T+bias", "T+threshold"):
    r = res[tag]
    extra = f" ECE={r['ece']:.3f} Brier={r['brier']:.3f}" if tag != "T+threshold" else (f"  (threshold {thr['threshold']:.2f} on P(other), objective {a.objective})" if thr["threshold"] is not None else "  (no threshold kept: it did not beat argmax on val; same as T)")
    print(f"{tag:11s} macroF1={r['macro_f1']:.3f} {np.round(r['ci95']['macro_f1'],3)} unfairF1={r['unfair_f1']:.3f} acc={r['acc']:.3f}{extra}")
for tag in ("T+bias", "T+threshold"):
    for pc in res[tag]["per_class"]: pc["name"] = NAMES[pc["id"]]
for pc in res["T+threshold"]["per_class"]: print(f"  {pc['name']:24s} P={pc['precision']:.2f} R={pc['recall']:.2f} F1={pc['f1']:.2f} n={pc['support']}")
(H / "reports" / f"{a.name}.json").write_text(json.dumps(res, indent=1))
np.save(H / "reports" / f"{a.name}.test_logits.npy", lt); np.save(H / "reports" / f"{a.name}.val_logits.npy", lv)
