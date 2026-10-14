"""Pack a merged Qwen3.5-4B (HF safetensors) into an MLC q4f32_1 weight directory that the *prebuilt* WebLLM wasm loads.

We do not use `mlc_llm convert_weight`: the nightly toolchain crashes while exporting qwen3_5 (TIR ill-formed in
create_rnn_state). The format is small and fully specified by MLC's own sources, so we write it directly:
  - loader spec    : python/mlc_llm/model/qwen35/qwen35_loader.py  (fuse q|k|v and gate|up, +1 on RMSNorm weights)
  - quantizer spec : python/mlc_llm/quantization/group_quantization.py  (scale = max|w|/7, code = clip(rint(w/scale)+7, 0, 14),
                     8 nibbles per uint32 with element 0 in the lowest bits, groups of 32 along the input dimension)
  - on-disk spec   : tensor-cache.json (raw-shard records; float32 tensors stored as bf16, uint32 raw)

Tensor names / shapes / dtypes are taken from the official Qwen3.5-4B-q4f32_1-MLC tensor-cache.json (same architecture),
and the shard plan is checked against it.

run:  kev-venv python pack_mlc.py --src <merged_hf_dir> --out <mlc_dir> --official <dir with tensor-cache.json + mlc-chat-config.json>
      [--gsq <gsq ckpt dir>]   # use GSQ codes/scales for every linear GSQ covers, MLC-style rounding for the rest
"""
import argparse, glob, hashlib, json, os, pathlib, re, shutil
import numpy as np, torch
from safetensors import safe_open

GROUP, MAXINT = 32, 7


# ---------------------------------------------------------------- encoding helpers
def f32_to_bf16_bytes(x: np.ndarray) -> bytes:
    """Round-to-nearest-even float32 -> bfloat16, little endian."""
    u = np.ascontiguousarray(x, dtype=np.float32).view(np.uint32)
    r = ((u + 0x7FFF + ((u >> 16) & 1)) >> 16).astype(np.uint16)
    return r.tobytes()


def bf16_bytes_to_f32(b: bytes, shape) -> np.ndarray:
    u = np.frombuffer(b, dtype=np.uint16).astype(np.uint32) << 16
    return u.view(np.float32).reshape(shape)


def pack_nibbles(codes: np.ndarray) -> np.ndarray:
    """(N, K) uint8 in [0,15] -> (N, K/8) uint32, element j of a word in bits [4j, 4j+4)."""
    n, k = codes.shape
    c = codes.reshape(n, k // 8, 8).astype(np.uint32)
    out = np.zeros((n, k // 8), dtype=np.uint32)
    for j in range(8):
        out |= c[:, :, j] << (4 * j)
    return out


def unpack_nibbles(words: np.ndarray) -> np.ndarray:
    w = words.astype(np.uint32)
    return np.stack([(w >> (4 * j)) & 0xF for j in range(8)], axis=-1).reshape(w.shape[0], -1).astype(np.uint8)


def rtn_quantize(w: torch.Tensor):
    """MLC group quantization (symmetric, 4 bit). w: (N, K) float32. Returns packed uint32 (N,K/8) and scale float32 (N,K/32)."""
    n, k = w.shape
    assert k % GROUP == 0, (n, k)
    g = w.reshape(n, k // GROUP, GROUP)
    scale = g.abs().amax(-1) / MAXINT
    safe = torch.where(scale == 0, torch.ones_like(scale), scale)
    code = torch.clamp(torch.round(g / safe[..., None] + MAXINT), 0, 2 * MAXINT).reshape(n, k)
    code = torch.where(scale.repeat_interleave(GROUP, 1) == 0, torch.full_like(code, MAXINT), code)
    return pack_nibbles(code.to(torch.uint8).numpy()), scale.numpy().astype(np.float32)


def dequantize(words: np.ndarray, scale: np.ndarray) -> np.ndarray:
    codes = unpack_nibbles(words).astype(np.float32) - MAXINT
    return codes * np.repeat(scale.astype(np.float32), GROUP, axis=1)


def gsq_to_mlc(packed_i32: np.ndarray) -> np.ndarray:
    """compressed-tensors int32 nibbles hold code+8 (code in [-8,7]); MLC holds code+7 in [0,14] -> clamp -8 to -7."""
    n = unpack_nibbles(packed_i32.view(np.uint32)).astype(np.int16)
    return pack_nibbles((np.maximum(n, 1) - 1).astype(np.uint8))


# ---------------------------------------------------------------- source weights
def weight_map(d):
    """tensor name -> safetensors file, for sharded checkpoints (index json) and single-file ones alike."""
    idx = os.path.join(d, "model.safetensors.index.json")
    if os.path.exists(idx): return json.load(open(idx))["weight_map"]
    with safe_open(os.path.join(d, "model.safetensors"), "pt") as f: return {k: "model.safetensors" for k in f.keys()}


class Source:
    def __init__(self, hf_dir, gsq_dir=None):
        self.hf_dir, self.idx = hf_dir, weight_map(hf_dir)
        self.gsq = {}
        if gsq_dir:  # name (without .weight) -> (file, packed key, scale key)
            for f in sorted(glob.glob(os.path.join(gsq_dir, "*.safetensors"))):
                with safe_open(f, "pt") as s:
                    for k in s.keys():
                        if k.endswith(".weight_packed"):
                            base = k[: -len(".weight_packed")]
                            self.gsq[base] = (f, k, base + ".weight_scale")

    def dense(self, name) -> torch.Tensor:
        with safe_open(os.path.join(self.hf_dir, self.idx[name]), "pt") as s:
            return s.get_tensor(name).float()

    def quantized(self, hf_base):
        """-> (packed uint32 (N,K/8), scale float32 (N,K/32), source tag)"""
        if hf_base in self.gsq:
            f, kp, ks = self.gsq[hf_base]
            with safe_open(f, "pt") as s:
                p, sc = s.get_tensor(kp).numpy(), s.get_tensor(ks).float().numpy()
            return gsq_to_mlc(p), sc, "gsq"
        p, sc = rtn_quantize(self.dense(hf_base + ".weight"))
        return p, sc, "rtn"


FUSED = {"self_attn.c_attn": ["self_attn.q_proj", "self_attn.k_proj", "self_attn.v_proj"], "mlp.gate_up_proj": ["mlp.gate_proj", "mlp.up_proj"]}
NORM_PLUS_ONE = ("input_layernorm.weight", "post_attention_layernorm.weight", "q_norm.weight", "k_norm.weight")


def hf_bases(mlc_module: str):
    m = re.match(r"model\.layers\.(\d+)\.(.*)", mlc_module)
    if m:
        i, rest = m.groups()
        parts = FUSED.get(rest, [rest])
        return [f"model.language_model.layers.{i}.{p}" for p in parts]
    return [mlc_module.replace("model.", "model.language_model.", 1)]


# ---------------------------------------------------------------- shards: reuse the official grouping (the runtime addresses tensors by dataPath/offset, so any grouping is valid)
def tensor_nbytes(shape, dtype):
    return int(np.prod(shape)) * (4 if dtype == "uint32" else 2)  # float32 is stored as bf16


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True); ap.add_argument("--out", required=True); ap.add_argument("--official", required=True)
    ap.add_argument("--gsq"); ap.add_argument("--context", type=int, default=4096); ap.add_argument("--check-plan-only", action="store_true")
    a = ap.parse_args()
    off = json.load(open(os.path.join(a.official, "tensor-cache.json")))
    recs = [r for f in off["records"] for r in f["records"]]
    # structural check: our byte-size rule (uint32 raw, float32 -> bf16) must reproduce every official record size
    assert all(tensor_nbytes(r["shape"], r["dtype"]) == r["nbytes"] for r in recs), "nbytes rule differs from official"
    ours, k = [], 0
    for f in off["records"]:
        ours.append(list(range(k, k + len(f["records"])))); k += len(f["records"])
    print(f"byte-size rule matches official for all {len(recs)} tensors ({len(ours)} shards)")
    if a.check_plan_only: return

    src = Source(a.src, a.gsq)
    out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
    cache, stats = {}, {"gsq": 0, "rtn": 0}

    def produce(r):
        name, shape, dtype = r["name"], r["shape"], r["dtype"]
        if name.endswith((".q_weight", ".q_scale")):
            mod = name.rsplit(".", 1)[0]
            if mod not in cache:  # q_weight and q_scale of one module can sit in different shards: compute once, keep the missing half
                ps, ss = [], []
                for b in hf_bases(mod):
                    p, s, tag = src.quantized(b); ps.append(p); ss.append(s); stats[tag] += 1
                cache[mod] = {"q_weight": np.concatenate(ps, 0), "q_scale": np.concatenate(ss, 0)}
            arr = cache[mod].pop(name.rsplit(".", 1)[1])          # each half is used exactly once
            if not cache[mod]: del cache[mod]
        else:
            hf = name.replace("model.", "model.language_model.", 1).replace("conv1d_weight", "conv1d.weight")
            arr = src.dense(hf).numpy()
            if name.endswith(NORM_PLUS_ONE) or name == "model.norm.weight":
                arr = arr + 1.0
            arr = arr.reshape(shape)
        assert list(arr.shape) == shape, (name, arr.shape, shape)
        return arr.view(np.uint32) if dtype == "uint32" and arr.dtype != np.uint32 else arr

    new_records, total_bytes, params = [], 0, 0
    for si, idxs in enumerate(ours):
        buf, shard_recs, off_b = bytearray(), [], 0
        for i in idxs:
            r = recs[i]; arr = produce(r)
            data = arr.astype(np.uint32).tobytes() if r["dtype"] == "uint32" else f32_to_bf16_bytes(arr)
            assert len(data) == r["nbytes"], (r["name"], len(data), r["nbytes"])
            shard_recs.append({**{k: r[k] for k in ("name", "shape", "dtype", "format", "nbytes")}, "byteOffset": off_b})
            buf += data; off_b += len(data); params += int(np.prod(r["shape"]))
        path = f"params_shard_{si}.bin"; (out / path).write_bytes(bytes(buf))
        new_records.append({"dataPath": path, "format": "raw-shard", "nbytes": len(buf), "md5sum": hashlib.md5(buf).hexdigest(), "records": shard_recs})
        total_bytes += len(buf)
        if si % 10 == 0: print(f"shard {si}/{len(ours)} {stats}", flush=True)
    meta = {"ParamSize": len(recs), "ParamBytes": float(total_bytes), "BitsPerParam": off["metadata"]["BitsPerParam"]}
    (out / "tensor-cache.json").write_text(json.dumps({"metadata": meta, "records": new_records}, indent=1))

    cfg = json.load(open(os.path.join(a.official, "mlc-chat-config.json")))
    cfg["context_window_size"] = a.context; cfg["model_config"]["context_window_size"] = a.context
    (out / "mlc-chat-config.json").write_text(json.dumps(cfg, indent=1))
    for t in ("tokenizer.json", "tokenizer_config.json", "vocab.json", "merges.txt"):
        p = os.path.join(a.src, t)
        if os.path.exists(p): shutil.copy(p, out / t)
    print(f"done: {total_bytes/1e9:.2f} GB, quantized tensors by source {stats} (counted per HF weight)")


if __name__ == "__main__":
    main()
