"""PII-question eval. run (kev venv): eval_pii.py --base <hf dir or id> [--adapter <dir>] --name <report>
Threshold on P(personal) is fixed at 0.5 for the headline (no tuning on test); per-template recall/FPR are reported."""
import argparse, json, sys, pathlib, numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
import letter
from prompt import pii_prompt
from calibrate import softmax
ap = argparse.ArgumentParser(); ap.add_argument("--base", required=True); ap.add_argument("--adapter"); ap.add_argument("--name", required=True)
ap.add_argument("--splits", default="val,test"); a = ap.parse_args()
H = pathlib.Path(__file__).parents[1]
m = letter.LetterModel(a.adapter, base=a.base)
res = {}
for split in a.splits.split(","):
    rows = [json.loads(l) for l in (H / "data" / f"pii_{split}.jsonl").open()]
    lg = letter.score(m, rows, builder=lambda r: pii_prompt(r["url"], r["text"]), n=2).numpy()
    p = softmax(lg)[:, 0]; y = np.array([r["label"] for r in rows]); pred = (p >= .5).astype(int)
    tp, fp, fn, tn = ((pred == 1) & (y == 1)).sum(), ((pred == 1) & (y == 0)).sum(), ((pred == 0) & (y == 1)).sum(), ((pred == 0) & (y == 0)).sum()
    kinds = {}
    for r, pr in zip(rows, pred): kinds.setdefault((r["label"], r["kind"]), []).append(int(pr))
    res[split] = dict(n=len(y), tp=int(tp), fp=int(fp), fn=int(fn), tn=int(tn), precision=float(tp / max(tp + fp, 1)), recall=float(tp / max(tp + fn, 1)),
                      by_kind={f"{'P' if l else 'N'}:{k}": float(np.mean(v)) for (l, k), v in kinds.items()})
    np.save(H / "reports" / f"{a.name}.{split}.p.npy", p)
    print(f"{split}: n={len(y)} precision={res[split]['precision']:.3f} recall={res[split]['recall']:.3f} FP={fp} FN={fn}")
    for k, v in sorted(res[split]["by_kind"].items()): print(f"    {k:26s} flagged {v*100:5.1f}%")
(H / "reports" / f"{a.name}.json").write_text(json.dumps(res, indent=1))
