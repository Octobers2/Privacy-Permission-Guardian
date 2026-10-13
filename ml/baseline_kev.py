# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "httpx"]
# ///
"""Zero-shot Kev (System One /v1/systemone, choice question) on the MTEB UnfairToS test set.
usage: uv run baseline_kev.py [--variant names|defs] [--limit N] [--url http://127.0.0.1:8009]"""
import argparse, json, pathlib, time
from concurrent.futures import ThreadPoolExecutor
import numpy as np, httpx
from prompt import NAMES, DEFINITIONS, INSTRUCTIONS
from metrics import summarize

ap = argparse.ArgumentParser()
ap.add_argument("--variant", choices=["names", "defs"], default="defs")
ap.add_argument("--limit", type=int)
ap.add_argument("--url", default="http://127.0.0.1:8009")
ap.add_argument("--workers", type=int, default=4)
a = ap.parse_args()

rows = [json.loads(l) for l in (pathlib.Path(__file__).parent / "data" / "test.jsonl").open()]
if a.limit: rows = rows[: a.limit]
criteria = {n: (DEFINITIONS[n] if a.variant == "defs" else None) for n in NAMES}
client = httpx.Client(base_url=a.url, timeout=120)

def ask(r):
    body = {"state": r["text"], "model": "kev-latest",
            "questions": {"clause": {"type": "choice", "instructions": INSTRUCTIONS, "criteria": criteria}}}
    resp = client.post("/v1/systemone", json=body); resp.raise_for_status()
    pr = resp.json()["answers"]["clause"]["probabilities"]
    return [pr[n] for n in NAMES]

t0 = time.time()
with ThreadPoolExecutor(a.workers) as ex: probs = list(ex.map(ask, rows))
dt = time.time() - t0
probs = np.array(probs); probs /= probs.sum(1, keepdims=True)
y = np.array([NAMES.index(r["label_name"]) for r in rows])
res = summarize(probs, y, NAMES.index("other"))
res.update(model="kev-4b@v1.0 zero-shot", variant=a.variant, seconds=round(dt, 1))
for pc in res["per_class"]: pc["name"] = NAMES[pc["id"]]
out = pathlib.Path(__file__).parent / "reports" / f"kev4b-zeroshot-{a.variant}.json"
out.write_text(json.dumps(res, indent=1))
np.save(out.with_suffix(".probs.npy"), probs)
print(f"{a.variant}: n={res['n']} macroF1={res['macro_f1']:.3f} {res['ci95']['macro_f1']}  unfairF1={res['unfair_f1']:.3f}  acc={res['acc']:.3f}  ECE={res['ece']:.3f} Brier={res['brier']:.3f}  ({dt:.0f}s)")
for pc in res["per_class"]: print(f"  {pc['name']:24s} P={pc['precision']:.2f} R={pc['recall']:.2f} F1={pc['f1']:.2f} n={pc['support']}")
