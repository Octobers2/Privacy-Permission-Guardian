"""Teacher letter-logits for train/val passages (for distillation).
run: HF_HOME=... vendor/kev/.venv/bin/python distill_targets.py <merged_teacher_dir> <out_name>"""
import json, sys, numpy as np, letter
base, name = sys.argv[1:3]
m = letter.LetterModel(None, base=base)
for split in ("train", "val"):
    rows = [json.loads(l) for l in open(f"data/{split}.jsonl")]
    np.save(f"data/{name}.{split}.logits.npy", letter.score(m, [r["text"] for r in rows]).numpy()); print(split, len(rows), flush=True)
