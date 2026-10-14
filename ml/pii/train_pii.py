"""Multi-task continuation: teach the PII question (2 options) on top of a trained ToS adapter without forgetting it.
run (kev venv): train_pii.py --base <hf id> --adapter <adapter dir> --name <run> [--epochs 2 --lr 1e-4 --micro 16 --accum 1 --replay 2500]"""
import argparse, json, math, pathlib, random, sys, time
import numpy as np, torch
sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
import letter
from prompt import NAMES, letter_prompt, pii_prompt
from metrics import summarize
from calibrate import fit_temperature, softmax

ap = argparse.ArgumentParser()
ap.add_argument("--base", required=True); ap.add_argument("--adapter", required=True); ap.add_argument("--name", required=True)
ap.add_argument("--epochs", type=int, default=2); ap.add_argument("--lr", type=float, default=1e-4)
ap.add_argument("--micro", type=int, default=16); ap.add_argument("--accum", type=int, default=1)
ap.add_argument("--replay", type=int, default=2500, help="ToS examples mixed in per epoch (all unfair ones first)"); ap.add_argument("--seed", type=int, default=0)
a = ap.parse_args(); random.seed(a.seed); torch.manual_seed(a.seed)
H = pathlib.Path(__file__).parents[1]; OUT = pathlib.Path("/ironwolf/ppg-cache/runs") / a.name; OUT.mkdir(parents=True, exist_ok=True)
load = lambda n: [json.loads(l) for l in (H / "data" / f"{n}.jsonl").open()]
tos_tr, tos_va, pii_tr, pii_va = load("train"), load("val"), load("pii_train"), load("pii_val")
other_id = NAMES.index("other")
ytr = np.array([NAMES.index(r["label_name"]) for r in tos_tr]); yva = np.array([NAMES.index(r["label_name"]) for r in tos_va])
cw = np.bincount(ytr, minlength=9).astype(float) ** -0.25; cw = cw / cw[ytr].mean(); cw_t = torch.tensor(cw, dtype=torch.float32).cuda()
unfair_idx = [i for i in range(len(tos_tr)) if ytr[i] != other_id]; other_idx = [i for i in range(len(tos_tr)) if ytr[i] == other_id]

def epoch_items():
    items = [dict(p=pii_prompt(r["url"], r["text"]), y=0 if r["label"] == 1 else 1, n=2) for r in pii_tr]        # option A = personal, B = public
    k = max(0, a.replay - len(unfair_idx)); pick = unfair_idx + random.sample(other_idx, min(k, len(other_idx)))
    items += [dict(p=letter_prompt(tos_tr[i]["text"]), y=int(ytr[i]), n=9) for i in pick]
    random.shuffle(items); return items

m = letter.LetterModel(a.adapter, trainable=True, base=a.base)
m.backbone.base_model.model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
params = [p for p in m.backbone.parameters() if p.requires_grad]
opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=0.0)
per_epoch = math.ceil((len(pii_tr) + max(a.replay, len(unfair_idx))) / (a.micro * a.accum)); total = per_epoch * a.epochs
sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / max(1, int(0.05 * total))) * 0.5 * (1 + math.cos(math.pi * min(s, total) / total)))
ident = lambda x: x

def evaluate():
    lv = letter.score(m, [r["text"] for r in tos_va]).numpy(); T = fit_temperature(lv, yva)
    tos = summarize(softmax(lv / T), yva, other_id, boots=1)
    lg = letter.score(m, pii_va, builder=lambda r: pii_prompt(r["url"], r["text"]), n=2).numpy(); p = softmax(lg)[:, 0]
    y = np.array([r["label"] for r in pii_va]); pred = p >= .5
    tp, fp, fn = (pred & (y == 1)).sum(), (pred & (y == 0)).sum(), (~pred & (y == 1)).sum()
    return dict(tos_val_macro_f1=tos["macro_f1"], pii_val_precision=float(tp / max(tp + fp, 1)), pii_val_recall=float(tp / max(tp + fn, 1)), pii_val_fp=int(fp), pii_val_fn=int(fn))

print("before:", json.dumps(evaluate()), flush=True)
step, t0 = 0, time.time()
for ep in range(a.epochs):
    items = epoch_items(); m.train()
    for s in range(0, len(items), a.micro * a.accum):
        chunk = items[s : s + a.micro * a.accum]; tot = 0.0
        for k in range(0, len(chunk), a.micro):
            b = chunk[k : k + a.micro]
            ids, mask = m.encode([x["p"] for x in b], builder=ident)
            with torch.autocast("cuda", dtype=torch.bfloat16): lg = m.logits(ids, mask)
            loss = 0.0
            for i, x in enumerate(b):
                y = torch.tensor([x["y"]]).cuda()
                loss = loss + (torch.nn.functional.cross_entropy(lg[i : i + 1], y, weight=cw_t)*cw_t[y] if x["n"] == 9 else torch.nn.functional.cross_entropy(lg[i : i + 1, :2], y)).sum()
            (loss / len(chunk)).backward(); tot += float(loss) / len(chunk)
        torch.nn.utils.clip_grad_norm_(params, 1.0); opt.step(); sched.step(); opt.zero_grad(set_to_none=True); step += 1
        if step % 20 == 0 or step == 1: print(f"ep{ep} step {step}/{total} loss {tot:.4f} {time.time()-t0:.0f}s mem {torch.cuda.max_memory_allocated()/1e9:.1f}GB", flush=True)
    ev = evaluate(); ev["epoch"] = ep + 1; print("VAL", json.dumps(ev), flush=True)
    m.backbone.save_pretrained(OUT / f"ep{ep+1}"); (OUT / f"ep{ep+1}.json").write_text(json.dumps(ev))
print("done")
