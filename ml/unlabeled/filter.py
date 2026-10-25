"""Step 3 of 3 for unlabelled distillation data: data/unlabeled_raw.jsonl -> data/unlabeled.jsonl.

Drops:
  * any sentence that is, or nearly is, a benchmark test sentence (the student must never be taught a test sentence,
    not even through the teacher's guess). Near = word-trigram Jaccard >= 0.5, which catches a clause that a service
    has reworded slightly since the corpus was collected;
  * exact copies of a train/val sentence (those already have real labels);
  * a previous sentence that is a near-test sentence is blanked, for the same reason;
  * duplicates (boilerplate repeated across pages).
run: python3 ml/unlabeled/filter.py [--jaccard 0.5]"""
import argparse, collections, json, pathlib, re

D = pathlib.Path(__file__).parents[1] / "data"
ap = argparse.ArgumentParser(); ap.add_argument("--jaccard", type=float, default=0.5); a = ap.parse_args()
norm = lambda t: re.sub(r"[^a-z0-9]+", " ", t.lower()).strip()
load = lambda n: [json.loads(l) for l in (D / f"{n}.jsonl").open()]

def grams(t):
    w = norm(t).split()
    return {" ".join(w[i : i + 3]) for i in range(len(w) - 2)} or ({" ".join(w)} if w else set())

test = [grams(r["text"]) for r in load("test")]
index = collections.defaultdict(list)
for j, g in enumerate(test):
    for x in g: index[x].append(j)

def near_test(text):
    g = grams(text)
    if not g: return False
    hits = collections.Counter(j for x in g for j in index.get(x, ()))
    return any(n / len(g | test[j]) >= a.jaccard for j, n in hits.items())

labelled = {norm(r["text"]) for split in ("train", "val") for r in load(split)}
rows, seen, why = [], set(), collections.Counter()
for r in load("unlabeled_raw"):
    k = norm(r["text"])
    if k in seen: why["duplicate"] += 1; continue
    seen.add(k)
    if near_test(r["text"]): why["near a test sentence"] += 1; continue
    if k in labelled: why["already labelled (train/val)"] += 1; continue
    if r["prev"] and near_test(r["prev"]): r["prev"] = ""; why["context blanked (near test)"] += 1
    rows.append({"text": r["text"], "prev": r["prev"], "url": r["url"]})
(D / "unlabeled.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows))
print(f"kept {len(rows)} sentences from {len({r['url'] for r in rows})} pages -> data/unlabeled.jsonl;", dict(why))
