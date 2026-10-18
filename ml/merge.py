"""Merge a LoRA adapter into Qwen3.5-4B-Base (bf16) and save a standard HF checkpoint.
run: HF_HOME=/ironwolf/ppg-cache/hf vendor/kev/.venv/bin/python merge.py <adapter_dir> <out_dir> [base=Qwen/Qwen3.5-4B-Base]"""
import sys, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel
adapter, out = sys.argv[1:3]
BASE = sys.argv[3] if len(sys.argv) > 3 else "Qwen/Qwen3.5-4B-Base"
tok = AutoTokenizer.from_pretrained(BASE)
lm = AutoModelForCausalLM.from_pretrained(BASE, dtype=torch.bfloat16, device_map={"": 0})
lm.model = PeftModel.from_pretrained(lm.model, adapter).merge_and_unload()   # adapter was trained on the inner backbone
lm.save_pretrained(out, safe_serialization=True, max_shard_size="5GB"); tok.save_pretrained(out)
print("saved", out)
