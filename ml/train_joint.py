"""One training stage for both questions, plus optional distillation. Replaces the two-stage recipe (train.py, then
pii/train_pii.py), which taught the PII question on top of a finished ToS adapter and cost the 4B 0.05 macro-F1
(0.811 -> 0.760) because only 2,500 ToS sentences were replayed.

Every epoch mixes, shuffled together:
  * all ToS training sentences    cross-entropy over the 9 letters, class weights count^-weight_pow
  * all PII training pages        cross-entropy over A/B, times --pii_weight            (--no-pii to skip)
  * unlabelled ToS sentences      KL to the teacher's softened letters, times --kd_weight (--unlabeled/--teacher, optional)

The ToS prompt is --prompt (letters-v1, or letters-v2 with definitions + previous sentence). With v2 the previous sentence
is dropped at random (--ctx_drop) so the model also copes with the first sentence of a page and with stray context.

run (kev venv), e.g.
  4B:   train_joint.py --name j4b-v2 --base Qwen/Qwen3.5-4B-Base --adapter kev --prompt letters-v2
  0.8B: train_joint.py --name j08-v2-kd --base Qwen/Qwen3.5-0.8B-Base --lora_r 64 --prompt letters-v2 \
            --unlabeled unlabeled --teacher run1T
        (data/run1T.unlabeled.logits.npy from: distill_targets.py <merged 4B> run1T)
Checkpoints: $PPG_RUNS/<name>/ep<k>/ each epoch, and best/ = highest ToS val macro-F1 among epochs whose PII val recall
is at least --pii_min_recall (a missed personal page is the dangerous direction, so it is a floor, not a trade-off)."""
import argparse, json, math, os, pathlib, random, time
import numpy as np, torch
import torch.nn.functional as F
from prompt import NAMES, PROMPT_VERSION, pii_prompt, tos_prompt
from metrics import summarize
from calibrate import fit_temperature, softmax
import letter

ap = argparse.ArgumentParser()
ap.add_argument("--name", required=True); ap.add_argument("--base", default=letter.BASE)
ap.add_argument("--adapter", help="'kev' or a LoRA dir to continue"); ap.add_argument("--lora_r", type=int, help="fresh LoRA of this rank instead")
ap.add_argument("--prompt", default=PROMPT_VERSION, choices=["letters-v1", "letters-v2"]); ap.add_argument("--ctx_drop", type=float, default=0.3)
ap.add_argument("--epochs", type=int, default=3); ap.add_argument("--lr", type=float, default=5e-5)
ap.add_argument("--micro", type=int, default=8); ap.add_argument("--accum", type=int, default=2); ap.add_argument("--weight_pow", type=float, default=0.5)
ap.add_argument("--no-pii", dest="pii", action="store_false"); ap.add_argument("--pii_weight", type=float, default=1.0); ap.add_argument("--pii_min_recall", type=float, default=0.95)
ap.add_argument("--unlabeled", help="data/<name>.jsonl of unlabelled ToS sentences"); ap.add_argument("--teacher", help="data/<teacher>.<unlabeled>.logits.npy")
ap.add_argument("--unlabeled_per_epoch", type=int, help="sample this many unlabelled sentences per epoch (default: all)")
ap.add_argument("--kd_weight", type=float, default=1.0); ap.add_argument("--kd_T", type=float, default=2.0)
ap.add_argument("--max_steps", type=int); ap.add_argument("--seed", type=int, default=0)
a = ap.parse_args()
assert bool(a.adapter) != bool(a.lora_r), "give exactly one of --adapter (continue) or --lora_r (fresh)"
assert bool(a.unlabeled) == bool(a.teacher), "--unlabeled and --teacher go together"
random.seed(a.seed); np.random.seed(a.seed); torch.manual_seed(a.seed)
H = pathlib.Path(__file__).parent
from paths import RUNS
OUT = RUNS / a.name; OUT.mkdir(parents=True, exist_ok=True)
(OUT / "args.json").write_text(json.dumps(vars(a), indent=1))
load = lambda n: [json.loads(l) for l in (H / "data" / f"{n}.jsonl").open()]
other = NAMES.index("other")

tos_tr, tos_va = load("train"), load("val")
ytr = np.array([NAMES.index(r["label_name"]) for r in tos_tr]); yva = np.array([NAMES.index(r["label_name"]) for r in tos_va])
cw = np.bincount(ytr, minlength=9).astype(float) ** -a.weight_pow; cw = cw / cw[ytr].mean()         # mean ToS sample weight = 1
cw_t = torch.tensor(cw, dtype=torch.float32).cuda()
print("class weights:", {NAMES[i]: round(float(cw[i]), 2) for i in range(9)})
pii_tr, pii_va = (load("pii_train"), load("pii_val")) if a.pii else ([], [])
unl = load(a.unlabeled) if a.unlabeled else []
teacher = np.load(H / "data" / f"{a.teacher}.{a.unlabeled}.logits.npy") if a.unlabeled else None
if teacher is not None: assert len(teacher) == len(unl), f"teacher logits {len(teacher)} != {len(unl)} sentences"

def tos_item_prompt(r):
    prev = r.get("prev") if random.random() >= a.ctx_drop else None
    return tos_prompt(a.prompt, r["text"], prev)

def epoch_items():
    """(prompt, kind, target) with kind 0 = ToS label, 1 = PII label, 2 = teacher row index."""
    items = [(tos_item_prompt(r), 0, int(y)) for r, y in zip(tos_tr, ytr)]
    items += [(pii_prompt(r["url"], r["text"]), 1, 0 if r["label"] == 1 else 1) for r in pii_tr]    # A = personal, B = public
    idx = list(range(len(unl)))
    if a.unlabeled_per_epoch: idx = random.sample(idx, min(a.unlabeled_per_epoch, len(idx)))
    items += [(tos_item_prompt(unl[i]), 2, i) for i in idx]
    random.shuffle(items); return items

if a.lora_r: m = letter.LetterModel(None, trainable=True, base=a.base, lora_r=a.lora_r)
else: m = letter.LetterModel(letter.KEV if a.adapter == "kev" else a.adapter, trainable=True, base=a.base)
m.backbone.base_model.model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
params = [p for p in m.backbone.parameters() if p.requires_grad]
print(f"trainable params: {sum(p.numel() for p in params)/1e6:.1f}M; items/epoch: ToS {len(tos_tr)}, PII {len(pii_tr)}, "
      f"unlabelled {min(a.unlabeled_per_epoch or len(unl), len(unl))}; prompt {a.prompt}", flush=True)
opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=0.0)
n_items = len(tos_tr) + len(pii_tr) + min(a.unlabeled_per_epoch or len(unl), len(unl))
total = a.max_steps or math.ceil(n_items / (a.micro * a.accum)) * a.epochs
sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / max(1, int(0.05 * total))) * 0.5 * (1 + math.cos(math.pi * min(s, total) / total)))

def batch_loss(batch, n_chunk):
    ids, mask = m.encode([p for p, _, _ in batch], builder=lambda p: p)
    with torch.autocast("cuda", dtype=torch.bfloat16): lg = m.logits(ids, mask)
    kind = torch.tensor([k for _, k, _ in batch]).cuda(); tgt = torch.tensor([t for _, _, t in batch]).cuda()
    loss = lg.new_zeros(())
    s = kind == 0
    if s.any(): loss = loss + F.cross_entropy(lg[s], tgt[s], weight=cw_t, reduction="sum")    # weight-scaled per sample, summed
    s = kind == 1
    if s.any(): loss = loss + a.pii_weight * F.cross_entropy(lg[s, :2], tgt[s], reduction="sum")
    s = kind == 2
    if s.any():
        t = torch.tensor(teacher[tgt[s].cpu().numpy()], dtype=torch.float32).cuda()
        kl = F.kl_div(F.log_softmax(lg[s] / a.kd_T, -1), F.softmax(t / a.kd_T, -1), reduction="none").sum(-1)
        loss = loss + a.kd_weight * a.kd_T ** 2 * kl.sum()
    return loss / n_chunk

def evaluate():
    m.eval()
    lv = letter.score_prompts(m, letter.tos_prompts(tos_va, a.prompt)).numpy(); T = fit_temperature(lv, yva)
    r = summarize(softmax(lv / T), yva, other, boots=1)
    ev = dict(T=T, tos_val_macro_f1=r["macro_f1"], tos_val_unfair_f1=r["unfair_f1"])
    if a.prompt != PROMPT_VERSION:   # what the context is worth, measured on val every epoch
        ln = letter.score_prompts(m, letter.tos_prompts(tos_va, a.prompt, context=False)).numpy()
        ev["tos_val_macro_f1_no_context"] = summarize(softmax(ln / fit_temperature(ln, yva)), yva, other, boots=1)["macro_f1"]
    if pii_va:
        p = softmax(letter.score(m, pii_va, builder=lambda r: pii_prompt(r["url"], r["text"]), n=2).numpy())[:, 0]
        y = np.array([r["label"] for r in pii_va]); pred = p >= .5
        tp, fp, fn = (pred & (y == 1)).sum(), (pred & (y == 0)).sum(), (~pred & (y == 1)).sum()
        ev.update(pii_val_precision=float(tp / max(tp + fp, 1)), pii_val_recall=float(tp / max(tp + fn, 1)), pii_val_fp=int(fp), pii_val_fn=int(fn))
    return ev

step, t0, hist, best = 0, time.time(), [], None
for ep in range(a.epochs):
    items = epoch_items(); m.train()
    for s in range(0, len(items), a.micro * a.accum):
        chunk = items[s : s + a.micro * a.accum]; tot = 0.0
        for k in range(0, len(chunk), a.micro):
            loss = batch_loss(chunk[k : k + a.micro], len(chunk)); loss.backward(); tot += loss.item()
        torch.nn.utils.clip_grad_norm_(params, 1.0); opt.step(); sched.step(); opt.zero_grad(set_to_none=True); step += 1
        if step % 20 == 0 or step == 1:
            print(f"ep{ep} step {step}/{total} loss {tot:.4f} lr {sched.get_last_lr()[0]:.2e} {time.time()-t0:.0f}s mem {torch.cuda.max_memory_allocated()/1e9:.1f}GB", flush=True)
        if a.max_steps and step >= a.max_steps: break
    ev = evaluate(); ev["epoch"] = ep + 1; hist.append(ev); print("VAL", json.dumps(ev), flush=True)
    m.backbone.save_pretrained(OUT / f"ep{ep+1}"); (OUT / f"ep{ep+1}.json").write_text(json.dumps(ev))
    ok = not pii_va or ev["pii_val_recall"] >= a.pii_min_recall
    if ok and (best is None or ev["tos_val_macro_f1"] > best["tos_val_macro_f1"]):
        best = ev; m.backbone.save_pretrained(OUT / "best"); (OUT / "best.json").write_text(json.dumps(ev))
    if a.max_steps and step >= a.max_steps: print("max_steps reached"); break
(OUT / "history.json").write_text(json.dumps(hist, indent=1))
print("done; best:", json.dumps(best) if best else f"no epoch reached PII val recall {a.pii_min_recall}; pick from ep*/ by hand")
