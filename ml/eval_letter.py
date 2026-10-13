# /// script
# dependencies = ["numpy", "scipy"]
# ///
"""Letter-format eval. Run with the kev venv:  vendor/kev/.venv/bin/python eval_letter.py --adapter kev|<dir> --name <report-name>
Temperature (and the optional 'other' bias) are fit on val only, then applied to test."""
import argparse, json, pathlib, numpy as np, torch
from prompt import NAMES
from metrics import summarize
from calibrate import fit_temperature, softmax, apply_other_bias
import letter

ap = argparse.ArgumentParser()
ap.add_argument("--adapter", default="kev"); ap.add_argument("--name", required=True)
a = ap.parse_args()
H = pathlib.Path(__file__).parent
load = lambda n: [json.loads(l) for l in (H / "data" / f"{n}.jsonl").open()]
val, test = load("val"), load("test")
yv = np.array([NAMES.index(r["label_name"]) for r in val]); yt = np.array([NAMES.index(r["label_name"]) for r in test])

m = letter.LetterModel(letter.KEV if a.adapter == "kev" else a.adapter)
lv = letter.score(m, [r["text"] for r in val]).numpy(); lt = letter.score(m, [r["text"] for r in test]).numpy()
other = NAMES.index("other")
T = fit_temperature(lv, yv)
# bias on 'other' chosen on val for macro-F1 (noisy: val has 4-22 examples per rare class)
best = max(np.arange(-3, 3.01, 0.25), key=lambda b: summarize(softmax(apply_other_bias(lv, other, b) / T), yv, other, boots=1)["macro_f1"])
res = {"adapter": a.adapter, "temperature": T, "other_bias": float(best), "prompt": "letters-v1"}
for tag, b in (("raw", 0.0), ("T", 0.0), ("T+bias", best)):
    t = 1.0 if tag == "raw" else T
    res[tag] = summarize(softmax(apply_other_bias(lt, other, b) / t), yt, other)
    r = res[tag]; print(f"{tag:7s} macroF1={r['macro_f1']:.3f} {np.round(r['ci95']['macro_f1'],3)} unfairF1={r['unfair_f1']:.3f} acc={r['acc']:.3f} ECE={r['ece']:.3f} Brier={r['brier']:.3f}")
for pc in res["T+bias"]["per_class"]: pc["name"] = NAMES[pc["id"]]
for pc in res["T+bias"]["per_class"]: print(f"  {pc['name']:24s} P={pc['precision']:.2f} R={pc['recall']:.2f} F1={pc['f1']:.2f} n={pc['support']}")
(H / "reports" / f"{a.name}.json").write_text(json.dumps(res, indent=1))
np.save(H / "reports" / f"{a.name}.test_logits.npy", lt)
