"""Teacher letter-logits for distillation: data/<out_name>.<split>.logits.npy for each data/<split>.jsonl.
run: HF_HOME=... vendor/kev/.venv/bin/python distill_targets.py <merged_teacher_dir> <out_name> [--splits unlabeled] [--prompt letters-v1]

Use the teacher on sentences it was NOT trained on. Its logits on its own training split are memorised (near-certain on
the gold label), which is why distilling on train added nothing before. The default split is therefore `unlabeled`
(built by ml/unlabeled/). --prompt is the prompt the TEACHER was trained on; the student may use another version.
(The old behaviour, train and val, is --splits train,val.)"""
import argparse, json, pathlib, numpy as np, letter
from prompt import NAMES
ap = argparse.ArgumentParser(); ap.add_argument("base"); ap.add_argument("name")
ap.add_argument("--splits", default="unlabeled"); ap.add_argument("--prompt", default="letters-v1", choices=["letters-v1", "letters-v2"])
a = ap.parse_args()
D = pathlib.Path(__file__).parent / "data"
m = letter.LetterModel(None, base=a.base)
for split in a.splits.split(","):
    rows = [json.loads(l) for l in (D / f"{split}.jsonl").open()]
    lg = letter.score_prompts(m, letter.tos_prompts(rows, a.prompt)).numpy()
    np.save(D / f"{a.name}.{split}.logits.npy", lg)
    flagged = (lg.argmax(1) != NAMES.index("other")).mean()
    print(f"{split}: {len(rows)} sentences, teacher calls {flagged*100:.1f}% unfair -> data/{a.name}.{split}.logits.npy", flush=True)
