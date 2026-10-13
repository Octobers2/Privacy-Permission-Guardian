"""Calibration data for GSQ: our own letter-format prompts + gold answer letter, packed into fixed-length chunks.
Registered into GSQ by compress/setup_gsq.sh (GSQ resolves dataset_name via globals() of src/data/dataset.py)."""
import json, pathlib, random, sys, torch
from torch.utils.data import DataLoader

ML = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML))
from prompt import NAMES, LETTERS, letter_prompt  # noqa: E402

def _rows(split):
    return [json.loads(l) for l in (ML / "data" / f"{split}.jsonl").open()]

def _chunks(rows, tokenizer, max_length, limit, seed):
    rng = random.Random(seed); rows = rows[:]; rng.shuffle(rows)
    buf, out = [], []
    for r in rows:
        text = letter_prompt(r["text"]) + " " + LETTERS[NAMES.index(r["label_name"])] + "\n\n"
        buf.extend(tokenizer(text, return_tensors=None)["input_ids"])
        while len(buf) >= max_length:
            out.append(torch.tensor(buf[:max_length], dtype=torch.long)); del buf[:max_length]
            if len(out) >= limit: return out
    return out

def tos(tokenizer, batch_size, train_samples, val_samples, gpt_samples, num_workers, max_length, shuffle_seed=1234, **_kw):
    tr = _rows("train"); rng = random.Random(0)
    unfair = [r for r in tr if r["label_name"] != "other"]; other = [r for r in tr if r["label_name"] == "other"]
    mix = unfair + rng.sample(other, min(len(other), 4 * len(unfair)))      # ~1/5 unfair, so rare classes shape the activations
    toks = _chunks(mix, tokenizer, max_length, train_samples + gpt_samples, shuffle_seed)
    val = _chunks(_rows("val"), tokenizer, max_length, val_samples, 7)
    mk = lambda xs: DataLoader(xs, batch_size=batch_size, shuffle=False, num_workers=num_workers)
    print(f"[tos calib] chunks: train {len(toks[:train_samples])} gptq {len(toks[train_samples:])} val {len(val)} x {max_length} tokens")
    return mk(toks[:train_samples]), mk(val), mk(toks[train_samples:])
