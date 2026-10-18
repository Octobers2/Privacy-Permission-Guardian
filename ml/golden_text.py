# /// script
# dependencies = ["nltk"]
# ///
"""Writes packages/shared/test/fixtures/normalize.golden.json: natural sentences and the exact normalised form the Python
reference (lowercase + address protection + NLTK TreebankWordTokenizer) produces. The TypeScript port must match all of them.
run: uv run golden_text.py"""
import json, pathlib, random, re
from nltk.tokenize import TreebankWordTokenizer
from nltk.tokenize.treebank import TreebankWordDetokenizer

HERE = pathlib.Path(__file__).parent
T, DET = TreebankWordTokenizer(), TreebankWordDetokenizer()
ADDRESS = re.compile(r"(?:https?://|www\.)[^\s<>\"']+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+")

def normalize(text: str) -> str:
    kept = []
    def hold(m):
        u, tail = m.group(0), ""
        while u and u[-1] in ".,;:!?)]}'\"": tail, u = u[-1] + tail, u[:-1]
        kept.append(u); return f"zzurl{len(kept)-1}zz{tail}"
    out = " ".join(T.tokenize(ADDRESS.sub(hold, text.lower())))
    return re.sub(r"zzurl(\d+)zz", lambda m: kept[int(m.group(1))], out)

natural = lambda s: (lambda t: t[:1].upper() + t[1:])(DET.detokenize(s.split()))
rows = [json.loads(l)["text"].strip() for l in (HERE / "data" / "test.jsonl").open()]
random.Random(3).shuffle(rows)
EDGE = ['He said "hello" to them.', "Don't go; we can't wait, they'd say.", "Contact us at Legal@Example.COM, or see https://example.com/terms.",
        "Visit www.example.org/a-b_c?x=1&y=2.", "The parties' rights (see section 5.4) apply -- always.", "We’ll do it.", "Price is $5.00 (50% off) & more.",
        "A “quoted” phrase and 'single' quotes.", "Call (800) 555-0132 today!", "Wait... what?", "cannot gonna wanna gimme", "[bracketed] {braced} <angled>"]
sample = [natural(s) for s in rows[:300]] + EDGE
out = [{"text": t, "normalized": normalize(t)} for t in sample]
dest = HERE.parent / "packages/shared/test/fixtures/normalize.golden.json"
dest.write_text(json.dumps(out, ensure_ascii=False, indent=1)); print("wrote", dest, len(out))
