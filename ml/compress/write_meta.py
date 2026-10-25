"""Writes <bundle>/ppg-model.json: the facts the extension needs about a shipped bundle (read by scripts/model-manifest.ts).
usage: write_meta.py <bundle_dir> --id ID --name NAME --tier fast|accurate --lib WASM --tos-report REPORT.json [--pii-report REPORT.json] --version V [--with-threshold]
The ToS prompt version and the flag threshold come from the eval_letter.py report."""
import argparse, json, pathlib
ap = argparse.ArgumentParser()
ap.add_argument("bundle"); ap.add_argument("--id", required=True); ap.add_argument("--name", required=True); ap.add_argument("--tier", required=True, choices=["fast", "accurate"])
ap.add_argument("--lib", required=True); ap.add_argument("--quantization", default="q4f32_1"); ap.add_argument("--version", required=True)
ap.add_argument("--tos-report", required=True); ap.add_argument("--pii-report"); ap.add_argument("--context", type=int, default=2048)
ap.add_argument("--with-threshold", action="store_true", help="ship the flag threshold from the report (default: plain argmax; see tune_threshold.py for why)")
a = ap.parse_args()
# the nine option-letter tokens (" A" … " I"): the extension reads their logits, so it must not need the 20 MB tokenizer to find them
vocab = json.load(open(pathlib.Path(a.bundle) / "tokenizer.json"))["model"]["vocab"]
letter_ids = [vocab["\u0120" + L] for L in "ABCDEFGHI"]
tos = json.load(open(a.tos_report)); pii = json.load(open(a.pii_report))["test"] if a.pii_report else None
use_thr = tos.get("other_threshold") is not None and a.with_threshold        # reports from eval_letter.py since letters-v2 carry one
meta = {
    "id": a.id, "name": a.name, "tier": a.tier, "version": a.version, "quantization": a.quantization, "lib": a.lib,
    "letterTokenIds": letter_ids, "requiresShaderF16": "f16" in a.quantization.split("_")[0], "contextWindow": a.context,
    "tasks": {
        "tos": {"promptVersion": tos.get("prompt", "letters-v1"), "temperature": round(tos["temperature"], 4),
                **({"otherThreshold": tos["other_threshold"], "testMacroF1": round(tos["T+threshold"]["macro_f1"], 3)} if use_thr else {"testMacroF1": round(tos["T"]["macro_f1"], 3)})},
        **({"pii": {"promptVersion": "pii-v1", "threshold": 0.5, "testPrecision": round(pii["precision"], 3), "testRecall": round(pii["recall"], 3)}} if pii else {}),
    },
}
(pathlib.Path(a.bundle) / "ppg-model.json").write_text(json.dumps(meta, indent=2)); print(json.dumps(meta))
