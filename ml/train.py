"""Continue training Kev's LoRA with 9-way CE over the letter logits (bf16 base, fp32 LoRA, grad checkpointing).
run: HF_HOME=/ironwolf/ppg-cache/hf vendor/kev/.venv/bin/python train.py --name run1 [--max_steps 10]"""
import argparse, json, math, pathlib, random, time
import numpy as np, torch
from prompt import NAMES
from metrics import summarize
from calibrate import fit_temperature, softmax, apply_other_bias
import letter

ap = argparse.ArgumentParser()
ap.add_argument("--name", required=True); ap.add_argument("--epochs", type=int, default=3)
ap.add_argument("--lr", type=float, default=5e-5); ap.add_argument("--micro", type=int, default=8)
ap.add_argument("--accum", type=int, default=2); ap.add_argument("--weight_pow", type=float, default=0.5)
ap.add_argument("--max_steps", type=int); ap.add_argument("--seed", type=int, default=0)
a = ap.parse_args()
random.seed(a.seed); torch.manual_seed(a.seed)
H = pathlib.Path(__file__).parent
OUT = pathlib.Path("/ironwolf/ppg-cache/runs") / a.name; OUT.mkdir(parents=True, exist_ok=True)
load = lambda n: [json.loads(l) for l in (H / "data" / f"{n}.jsonl").open()]
train, val = load("train"), load("val")
ytr = np.array([NAMES.index(r["label_name"]) for r in train]); yv = np.array([NAMES.index(r["label_name"]) for r in val])
other = NAMES.index("other")

counts = np.bincount(ytr, minlength=9).astype(float)
cw = counts ** -a.weight_pow; cw = cw / (cw[ytr].mean())          # mean sample weight = 1
cw_t = torch.tensor(cw, dtype=torch.float32).cuda()
print("class weights:", {NAMES[i]: round(float(cw[i]), 2) for i in range(9)})

m = letter.LetterModel(letter.KEV, trainable=True)
m.backbone.base_model.model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
params = [p for p in m.backbone.parameters() if p.requires_grad]
print(f"trainable params: {sum(p.numel() for p in params)/1e6:.1f}M (dtype {params[0].dtype})")
opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=0.0)
steps_per_epoch = math.ceil(len(train) / (a.micro * a.accum)); total = a.max_steps or steps_per_epoch * a.epochs
sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / max(1, int(0.05 * total))) * 0.5 * (1 + math.cos(math.pi * min(s, total) / total)))

def evaluate():
    lv = letter.score(m, [r["text"] for r in val]).numpy()
    T = fit_temperature(lv, yv)
    b = max(np.arange(-3, 3.01, 0.25), key=lambda b: summarize(softmax(apply_other_bias(lv, other, b) / T), yv, other, boots=1)["macro_f1"])
    r = summarize(softmax(apply_other_bias(lv, other, b) / T), yv, other, boots=1)
    nll = float(-np.log(softmax(lv / T)[np.arange(len(yv)), yv] + 1e-12).mean())
    return dict(T=T, bias=float(b), val_macro_f1=r["macro_f1"], val_unfair_f1=r["unfair_f1"], val_nll=nll)

step, best, t0, hist = 0, -1, time.time(), []
for ep in range(a.epochs):
    order = list(range(len(train))); random.shuffle(order); m.train()
    for s in range(0, len(order), a.micro * a.accum):
        chunk = order[s : s + a.micro * a.accum]; tot = 0.0
        for k in range(0, len(chunk), a.micro):
            idx = chunk[k : k + a.micro]
            ids, mask = m.encode([train[i]["text"] for i in idx])
            with torch.autocast("cuda", dtype=torch.bfloat16):
                lg = m.logits(ids, mask)
            y = torch.tensor(ytr[idx]).cuda()
            loss = torch.nn.functional.cross_entropy(lg, y, weight=cw_t, reduction="sum") / len(chunk)
            loss.backward(); tot += loss.item()
        torch.nn.utils.clip_grad_norm_(params, 1.0); opt.step(); sched.step(); opt.zero_grad(set_to_none=True); step += 1
        if step % 10 == 0 or step == 1:
            print(f"ep{ep} step {step}/{total} loss {tot:.4f} lr {sched.get_last_lr()[0]:.2e} {time.time()-t0:.0f}s mem {torch.cuda.max_memory_allocated()/1e9:.1f}GB", flush=True)
        if a.max_steps and step >= a.max_steps: break
    if a.max_steps and step >= a.max_steps: print("max_steps reached"); break
    ev = evaluate(); ev["epoch"] = ep + 1; hist.append(ev); print("VAL", json.dumps(ev), flush=True)
    if ev["val_macro_f1"] > best:
        best = ev["val_macro_f1"]; m.backbone.save_pretrained(OUT / "best"); (OUT / "best.json").write_text(json.dumps(ev))
(OUT / "history.json").write_text(json.dumps(hist, indent=1)); print("done; best val macro-F1", best)
