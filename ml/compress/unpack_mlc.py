"""MLC q4f32_1 dir -> HF-format bf16 safetensors dir (dequantized), to evaluate exactly what ships.
run: vendor/kev/.venv/bin/python compress/unpack_mlc.py <mlc_dir> <hf_template_dir> <out_dir>"""
import json, os, re, shutil, sys, pathlib, numpy as np, torch
from safetensors.torch import save_file
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from pack_mlc import dequantize, bf16_bytes_to_f32, FUSED, NORM_PLUS_ONE

mlc, tmpl, out = map(pathlib.Path, sys.argv[1:4])
cache = json.load(open(mlc / "tensor-cache.json")); raw = {}
for f in cache["records"]:
    mm = np.memmap(mlc / f["dataPath"], dtype=np.uint8, mode="r")          # lazy: nothing is read until a tensor is used
    for r in f["records"]: raw[r["name"]] = (r, mm[r["byteOffset"]: r["byteOffset"] + r["nbytes"]])

def get(name):
    r, b = raw[name]
    return np.frombuffer(b.tobytes(), np.uint32).reshape(r["shape"]) if r["dtype"] == "uint32" else bf16_bytes_to_f32(b.tobytes(), r["shape"])

hf, written, size = {}, {}, 0
out.mkdir(parents=True, exist_ok=True)
shard_no = 0

def put(k, v):
    global size
    t = torch.from_numpy(np.ascontiguousarray(v)).to(torch.bfloat16); hf[k] = t; size += t.numel() * 2
    flush(False)

def flush(final):
    global hf, size, shard_no
    if hf and (final or size > 3e9):
        fn = f"model-{shard_no:05d}.safetensors"; save_file(hf, out / fn, metadata={"format": "pt"})
        written.update({k: fn for k in hf}); hf, size, shard_no = {}, 0, shard_no + 1

for name in raw:
    if name.endswith(".q_scale"): continue
    if name.endswith(".q_weight"):
        mod = name[: -len(".q_weight")]; w = dequantize(get(name), get(mod + ".q_scale"))
        m = re.match(r"model\.layers\.(\d+)\.(.*)", mod)
        if m:
            i, rest = m.groups(); parts = FUSED.get(rest, [rest])
            if len(parts) == 1: put(f"model.language_model.layers.{i}.{rest}.weight", w)
            else:  # split the stacked rows back (sizes from the HF template)
                split = {"self_attn.c_attn": [4096 * 2, 1024, 1024], "mlp.gate_up_proj": [9216, 9216]}[rest]  # q has attn_output_gate -> 2x
                for p, chunk in zip(parts, np.split(w, np.cumsum(split)[:-1], axis=0)): put(f"model.language_model.layers.{i}.{p}.weight", chunk)
        else: put(mod.replace("model.", "model.language_model.", 1) + ".weight", w)
    else:
        a = get(name)
        if name.endswith(NORM_PLUS_ONE) or name == "model.norm.weight": a = a - 1.0
        put(name.replace("model.", "model.language_model.", 1).replace("conv1d_weight", "conv1d.weight"), a)
flush(True)
ref = json.load(open(tmpl / "model.safetensors.index.json"))["weight_map"]
assert set(written) == set(ref), (sorted(set(written) ^ set(ref))[:6])
json.dump({"metadata": {}, "weight_map": written}, open(out / "model.safetensors.index.json", "w"))
for f in os.listdir(tmpl):
    if f.startswith("model") and f.endswith((".safetensors", ".json")): continue
    shutil.copy(tmpl / f, out / f)
print("wrote", out, len(written), "tensors")
