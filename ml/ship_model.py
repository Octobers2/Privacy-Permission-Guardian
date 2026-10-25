"""Turns a trained run into a browser model bundle, and tests exactly what will ship before anything else uses it.

  1  merge the LoRA into the base model                     -> <PPG_CACHE>/merged/<run>
  2  pack to 4-bit MLC q4f32_1 (compress/pack_mlc.py)       -> data/models/<bundle>       (repository root)
  3  unpack that bundle back to bf16 and score it on test   -> reports/<run>-rtn4-deq(.json, -pii.json)
  4  compare with the bundle it replaces (compare.py)
  5  write ppg-model.json, fetch the WebLLM kernel (.wasm), rebuild data/models/manifest.json

Steps already done are skipped. Defaults are for the fast (0.8B) tier and run j08-kd:
  Windows:  ml\\.venv\\Scripts\\python.exe ml\\ship_model.py
  4B:       ... ship_model.py --run j4b-v1 --size 4B --tier accurate --replaces run4bmt-rtn4-deq-letter
The official MLC layout files (tensor-cache.json, mlc-chat-config.json, tokenizer) come from Hugging Face
(mlc-ai/Qwen3.5-<size>-q4f32_1-MLC) and the kernel from WebLLM's binary-mlc-llm-libs (v0_2_86), the ones the
extension was tested with."""
import argparse, datetime, json, os, pathlib, shutil, subprocess, sys, urllib.request

ML = pathlib.Path(__file__).resolve().parent; ROOT = ML.parent
sys.path.insert(0, str(ML))
from paths import RUNS, MERGED, CACHE

ap = argparse.ArgumentParser()
ap.add_argument("--run", default="j08-kd"); ap.add_argument("--size", default="0.8B", choices=["0.8B", "4B"])
ap.add_argument("--tier", default="fast", choices=["fast", "accurate"]); ap.add_argument("--replaces", default="stu08mt-rtn4-deq-letter")
ap.add_argument("--version", default=datetime.date.today().isoformat()); ap.add_argument("--prompt", default="letters-v1")
a = ap.parse_args()
PY = sys.executable; ENV = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
BASE = f"Qwen/Qwen3.5-{a.size}-Base"; OFFICIAL_REPO = f"mlc-ai/Qwen3.5-{a.size}-q4f32_1-MLC"
WASM = f"Qwen3.5-{a.size}-q4f32_1_cs1k-webgpu.wasm"
WASM_URL = f"https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_86/base/{WASM}"
MODELS = ROOT / "data" / "models"; BUNDLE = f"ppg-{a.tier}-{a.run}-q4f32_1"
merged, bundle, deq = MERGED / a.run, MODELS / BUNDLE, CACHE / "deq" / a.run
report = f"{a.run}-rtn4-deq"

def run(cmd, cwd=ML):
    cmd = [str(c) for c in cmd]; print(f"\n=== {' '.join(cmd)}", flush=True)
    if subprocess.run(cmd, cwd=cwd, env=ENV).returncode: sys.exit(f"*** failed: {' '.join(cmd)}  (fix it and run ship_model.py again; finished steps are skipped)")

if not (RUNS / a.run / "best").exists(): sys.exit(f"no trained run at {RUNS / a.run / 'best'}")
# 1. merge
if not (merged / "config.json").exists(): run([PY, "merge.py", RUNS / a.run / "best", merged, BASE])
# 2. pack
if not (bundle / "tensor-cache.json").exists():
    from huggingface_hub import snapshot_download
    official = snapshot_download(OFFICIAL_REPO, allow_patterns=["*.json", "merges.txt", "vocab.json"])
    run([PY, "compress/pack_mlc.py", "--src", merged, "--out", bundle, "--official", official])
# 3. unpack and score exactly what ships
if not (deq / "config.json").exists(): run([PY, "compress/unpack_mlc.py", bundle, merged, deq])
if not (ML / "reports" / f"{report}.json").exists():
    run([PY, "eval_letter.py", "--adapter", "none", "--base", deq, "--prompt", a.prompt, "--name", report])
if not (ML / "reports" / f"{report}-pii.json").exists():
    run([PY, "pii/eval_pii.py", "--base", deq, "--name", f"{report}-pii"])
# 4. compare: with the training-time (unpacked) numbers, and with the bundle being replaced
for old in (a.run, a.replaces):
    if (ML / "reports" / f"{old}.json").exists(): run([PY, "compare.py", f"reports/{old}.json", f"reports/{report}.json"])
# 5. metadata, kernel, manifest
name = {"fast": "Fast (0.8B)", "accurate": "Accurate (4B)"}[a.tier]
run([PY, "compress/write_meta.py", bundle, "--id", f"ppg-{a.tier}", "--name", name, "--tier", a.tier, "--lib", WASM,
     "--tos-report", f"reports/{report}.json", "--pii-report", f"reports/{report}-pii.json", "--version", a.version])
if not (MODELS / WASM).exists():
    print(f"\n=== downloading {WASM_URL}"); urllib.request.urlretrieve(WASM_URL, MODELS / WASM)
bun = shutil.which("bun") or str(pathlib.Path.home() / ".bun" / "bin" / "bun")
run([bun, "run", "scripts/model-manifest.ts", MODELS], cwd=ROOT)
print(f"\nBundle ready: {bundle}\nThe server serves data/models; copy this folder, {WASM} and manifest.json there "
      f"(or run the server from this checkout). Then open the extension's setup page and pick '{name}'.")
