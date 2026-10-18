# /// script
# requires-python = ">=3.11"
# dependencies = ["datasets", "pandas", "pyarrow", "scikit-learn"]
# ///
"""Build train/val/test splits.

train/val: LexGLUE unfair_tos (multi-label -> single label), minus any sentence
that also appears in the MTEB set. test: the MTEB set, untouched.
"""
import json, re, collections, pathlib
import pandas as pd
from datasets import load_dataset
from sklearn.model_selection import train_test_split

HERE = pathlib.Path(__file__).parent
OUT = HERE / "data"; OUT.mkdir(exist_ok=True)
labels = json.loads((HERE / "labels.json").read_text())
NAMES = list(labels["mteb"].values())          # canonical class order = MTEB ids
LEX = {int(k): v for k, v in labels["lexglue_to_name"].items()}

def norm(t: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", t.lower()).strip()

# MTEB test set (held out)
mteb = load_dataset("mteb/UnfairTOSLegalBenchClassification", split="test").to_pandas()
mteb["label_name"] = mteb.label.map(lambda i: labels["mteb"][str(i)])
mteb_keys = set(mteb.text.map(norm))

# LexGLUE (all three official splits are pooled, then re-split stratified)
lex = pd.concat([load_dataset("coastalcph/lex_glue", "unfair_tos", split=s).to_pandas() for s in ("train", "validation", "test")])
freq = collections.Counter(l for ls in lex.labels for l in ls)   # rarest label wins for multi-label rows
def pick(ls):
    return "other" if len(ls) == 0 else LEX[min(ls, key=lambda l: freq[l])]
lex["label_name"] = lex.labels.map(pick)
lex["key"] = lex.text.map(norm)
before = len(lex)
lex = lex[~lex.key.isin(mteb_keys)].drop_duplicates("key")
print(f"lexglue {before} -> {len(lex)} after removing MTEB overlap + dups")

tr, va = train_test_split(lex, test_size=0.1, stratify=lex.label_name, random_state=0)
for name, df in (("train", tr), ("val", va), ("test", mteb)):
    df[["text", "label_name"]].to_json(OUT / f"{name}.jsonl", orient="records", lines=True)
    print(name, len(df), dict(df.label_name.value_counts()))
