"""Writes <bundle>/ppg-model.json: the facts the extension needs about a shipped bundle (read by scripts/model-manifest.ts).
usage: write_meta.py <bundle_dir> --id ID --name NAME --tier fast|accurate --lib WASM --tos-report REPORT.json [--pii-report REPORT.json] --version V"""
import argparse, json, pathlib
ap = argparse.ArgumentParser()
ap.add_argument("bundle"); ap.add_argument("--id", required=True); ap.add_argument("--name", required=True); ap.add_argument("--tier", required=True, choices=["fast", "accurate"])
ap.add_argument("--lib", required=True); ap.add_argument("--quantization", default="q4f32_1"); ap.add_argument("--version", required=True)
ap.add_argument("--tos-report", required=True); ap.add_argument("--pii-report"); ap.add_argument("--context", type=int, default=4096)
a = ap.parse_args()
tos = json.load(open(a.tos_report)); pii = json.load(open(a.pii_report))["test"] if a.pii_report else None
meta = {
    "id": a.id, "name": a.name, "tier": a.tier, "version": a.version, "quantization": a.quantization, "lib": a.lib,
    "requiresShaderF16": "f16" in a.quantization.split("_")[0], "contextWindow": a.context,
    "tasks": {
        "tos": {"promptVersion": "letters-v1", "temperature": round(tos["temperature"], 4), "testMacroF1": round(tos["T"]["macro_f1"], 3)},
        **({"pii": {"promptVersion": "pii-v1", "threshold": 0.5, "testPrecision": round(pii["precision"], 3), "testRecall": round(pii["recall"], 3)}} if pii else {}),
    },
}
(pathlib.Path(a.bundle) / "ppg-model.json").write_text(json.dumps(meta, indent=2)); print(json.dumps(meta))
