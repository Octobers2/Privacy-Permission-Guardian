# /// script
# dependencies = ["nltk"]
# ///
"""data/test_natural.jsonl: the MTEB test sentences turned back into ordinary prose (detokenised, first letter capitalised),
i.e. what the same clauses look like on a web page. Used to measure what the page-text pipeline costs the classifier."""
import json, pathlib
from nltk.tokenize.treebank import TreebankWordDetokenizer
D = pathlib.Path(__file__).parent / "data"; det = TreebankWordDetokenizer()
rows = [json.loads(l) for l in (D / "test.jsonl").open()]
natural = lambda s: (lambda t: t[:1].upper() + t[1:])(det.detokenize(s.split()))
(D / "test_natural.jsonl").write_text("\n".join(json.dumps({"text": natural(r["text"].strip()), "label_name": r["label_name"], "prev": natural(r.get("prev", "").strip()) if r.get("prev", "").strip() else ""}, ensure_ascii=False) for r in rows))
print(len(rows), "sentences;", "e.g.", natural(rows[1]["text"].strip())[:110])
