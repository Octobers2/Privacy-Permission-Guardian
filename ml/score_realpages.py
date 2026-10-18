"""Classifies data/realpages_sentences.jsonl (the real-page sentences from eval/run-realpages.ts) with both shipped tiers and prints
flag rates, tier agreement and a sample of what was flagged, for reading by a human. No labels exist for these pages."""
import json, sys, collections, numpy as np
import letter
from calibrate import softmax
from prompt import NAMES
rows = [json.loads(l) for l in open("data/realpages_sentences.jsonl")]
res = {}
for tier, T in (("stu08mt", json.load(open("reports/stu08mt-rtn4-deq-letter.json"))["temperature"]), ("run4bmt", json.load(open("reports/run4bmt-rtn4-deq-letter.json"))["temperature"])):
    m = letter.LetterModel(None, base=f"/ironwolf/ppg-cache/merged/{tier}-rtn4-deq")
    res[tier] = softmax(letter.score(m, [r["normalized"] for r in rows]).numpy() / T)
    del m
    import torch; torch.cuda.empty_cache()
other = NAMES.index("other")
flag = {t: p.argmax(1) != other for t, p in res.items()}
print(f"\nsentences: {len(rows)}   flagged: 0.8B {flag['stu08mt'].mean()*100:.1f}%   4B {flag['run4bmt'].mean()*100:.1f}%   (benchmark: ~9.4% of sentences are unfair)")
a, b = flag["stu08mt"], flag["run4bmt"]
print(f"both flag {np.sum(a&b)}, only 0.8B {np.sum(a&~b)}, only 4B {np.sum(~a&b)};  agree on category when both flag: {np.mean(res['stu08mt'].argmax(1)[a&b] == res['run4bmt'].argmax(1)[a&b]):.2f}")
by = collections.defaultdict(list)
for i, r in enumerate(rows): by[r["url"]].append(i)
for url, idx in by.items():
    print(f"  {len(idx):4d} sentences  4B flags {flag['run4bmt'][idx].sum():3d} ({flag['run4bmt'][idx].mean()*100:4.1f}%)  {url.split('//')[1][:60]}")
print("\n--- the 4B's most confident flags on Discord's terms, for reading:")
idx = by[[u for u in by if "discord" in u][0]]
top = sorted((i for i in idx if flag["run4bmt"][i]), key=lambda i: -res["run4bmt"][i].max())[:7]
for i in top: print(f"  [{NAMES[res['run4bmt'][i].argmax()]:24s} {res['run4bmt'][i].max():.2f}] {rows[i]['text'][:170]}")
print("\n--- flagged by the 4B with LOW confidence (where mistakes live):")
low = sorted((i for i in range(len(rows)) if flag["run4bmt"][i]), key=lambda i: res["run4bmt"][i].max())[:5]
for i in low: print(f"  [{NAMES[res['run4bmt'][i].argmax()]:24s} {res['run4bmt'][i].max():.2f}] {rows[i]['text'][:170]}")
