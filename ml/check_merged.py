"""Score the test set with a merged checkpoint (no adapter) and compare with the LoRA run's saved logits.
run: check_merged.py <merged_dir> <reference_report_name> """
import sys, json, numpy as np
from prompt import NAMES
from metrics import summarize
from calibrate import softmax
import letter
merged, ref = sys.argv[1:3]
test = [json.loads(l) for l in open("data/test.jsonl")]; y = np.array([NAMES.index(r["label_name"]) for r in test])
lg = letter.score(letter.LetterModel(None, base=merged), [r["text"] for r in test]).numpy()
ref_lg = np.load(f"reports/{ref}.test_logits.npy"); T = json.load(open(f"reports/{ref}.json"))["temperature"]
print("argmax agreement with LoRA run:", float((lg.argmax(1) == ref_lg.argmax(1)).mean()), "| max |dlogit|:", float(np.abs(lg - ref_lg).max()), "| mean:", float(np.abs(lg - ref_lg).mean()))
r = summarize(softmax(lg / T), y, NAMES.index("other"))
print(f"merged macroF1={r['macro_f1']:.3f} {np.round(r['ci95']['macro_f1'],3)} unfairF1={r['unfair_f1']:.3f} ECE={r['ece']:.3f}")
np.save(f"reports/{ref}-merged.test_logits.npy", lg)
