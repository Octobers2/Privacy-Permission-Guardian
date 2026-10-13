"""CPU sanity tests for pack_mlc.py. run: vendor/kev/.venv/bin/python compress/test_pack.py"""
import json, sys, pathlib, numpy as np, torch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from pack_mlc import *

# 1. nibble pack/unpack roundtrip, element 0 in the lowest bits
c = np.random.default_rng(0).integers(0, 15, (5, 64), dtype=np.uint8)
w = pack_nibbles(c); assert (unpack_nibbles(w) == c).all()
assert (w[:, 0] & 0xF == c[:, 0]).all() and (w[:, 0] >> 28 == c[:, 7]).all()

# 2. RTN: reconstruction error bounded by half a step per group, zero groups survive
x = torch.randn(16, 128) * 0.1; x[0, :32] = 0
p, s = rtn_quantize(x); d = dequantize(p, s)
step = np.repeat(s, GROUP, 1)
assert (np.abs(d - x.numpy()) <= step / 2 + 1e-7).all(); assert (d[0, :32] == 0).all()

# 3. GSQ -> MLC nibble conversion: code c in [-8,7] stored as c+8 -> clamp(c,-7,7)+7
g = np.arange(16, dtype=np.uint8).reshape(2, 8)             # nibbles 0..15  == codes -8..7
m = unpack_nibbles(gsq_to_mlc(pack_nibbles(g).view(np.int32)))
assert m.tolist() == [[0, 0, 1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12, 13, 14]], m.tolist()

# 4. bf16 encoding roundtrip is exact for bf16-representable values and RNE otherwise
v = np.array([1.0, -2.5, 0.0, 3.0517578e-05], dtype=np.float32)
assert (bf16_bytes_to_f32(f32_to_bf16_bytes(v), v.shape) == v).all()
print("unit tests ok")

# 5. the OFFICIAL 0.8B tensors obey the quantizer's invariants under my reading of the layout
root = pathlib.Path("/tmp/claude-1000/models/Qwen3.5-0.8B-q4f32_1-MLC")
cache = json.load(open(root / "tensor-cache.json")); recs = {}
for f in cache["records"]:
    data = (root / f["dataPath"]).read_bytes()
    for r in f["records"]: recs[r["name"]] = (r, data[r["byteOffset"]: r["byteOffset"] + r["nbytes"]])
for mod in ["model.layers.0.mlp.down_proj", "model.layers.0.linear_attn.in_proj_qkv", "model.layers.3.self_attn.o_proj", "model.embed_tokens"]:
    (rw, bw), (rs, bs) = recs[mod + ".q_weight"], recs[mod + ".q_scale"]
    codes = unpack_nibbles(np.frombuffer(bw, np.uint32).reshape(rw["shape"]))
    scale = bf16_bytes_to_f32(bs, rs["shape"])
    assert codes.max() <= 14, mod
    grp = codes.reshape(codes.shape[0], -1, GROUP)
    has_extreme = ((grp == 0) | (grp == 14)).any(-1)
    nz = scale > 0
    print(f"{mod:42s} groups with an extreme code: {has_extreme[nz].mean():.4f} | codes in [{codes.min()},{codes.max()}] | scale>0 {nz.mean():.4f}")
    assert has_extreme[nz].mean() > 0.999
print("official-format invariants ok")
