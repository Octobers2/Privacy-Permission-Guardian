"""Load Qwen3.5 backbone (+ optional Kev LoRA) and score passages by the logits of the 9 letter tokens."""
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from prompt import LETTERS, letter_prompt, pii_prompt

BASE = "Qwen/Qwen3.5-4B-Base"
_KEV_DEFAULT = object()          # "use Kev's adapter"; resolved (and downloaded if needed) only when a model is built

def __getattr__(name):           # letter.KEV, looked up lazily so importing this module never needs the adapter
    if name == "KEV":
        from paths import kev_adapter
        return kev_adapter()
    raise AttributeError(name)

class LetterModel(torch.nn.Module):
    def __init__(self, adapter: str | None = _KEV_DEFAULT, trainable=False, base: str = BASE, lora_r: int | None = None):
        super().__init__()
        if adapter is _KEV_DEFAULT:
            from paths import kev_adapter
            adapter = kev_adapter()
        self.tok = AutoTokenizer.from_pretrained(base)
        lm = AutoModelForCausalLM.from_pretrained(base, dtype=torch.bfloat16, device_map={"": 0})
        self.backbone = lm.model
        ids = [self.tok.convert_tokens_to_ids("Ġ" + L) for L in LETTERS]
        assert all(i is not None and i != self.tok.unk_token_id for i in ids), ids
        self.register_buffer("rows", lm.get_output_embeddings().weight[ids].detach().clone())  # (9, hidden)
        del lm.lm_head
        if lora_r:  # fresh LoRA (student models); same target modules as Kev's adapter
            from peft import LoraConfig, get_peft_model
            targets = ["in_proj_b", "in_proj_qkv", "gate_proj", "v_proj", "o_proj", "k_proj", "up_proj", "in_proj_z", "in_proj_a", "out_proj", "down_proj", "q_proj"]
            self.backbone = get_peft_model(self.backbone, LoraConfig(task_type="FEATURE_EXTRACTION", r=lora_r, lora_alpha=2 * lora_r, lora_dropout=0.05, target_modules=targets))
        elif adapter:
            from peft import PeftModel
            self.backbone = PeftModel.from_pretrained(self.backbone, adapter, is_trainable=trainable)
        for p in self.backbone.parameters(): p.requires_grad_(False)
        if trainable:
            for n, p in self.backbone.named_parameters():
                if "lora_" in n: p.requires_grad_(True)

    def encode(self, texts, max_len=1024, builder=letter_prompt):
        """Right-padded token ids and mask. A prompt longer than max_len tokens (a run-on sentence from a real page) is cut
        in the passage, keeping its first max_len-4 tokens and its last 4 (the "\\nAnswer:" tail must survive), row by row,
        so one long prompt never stops a batch. Prompts within max_len are unchanged."""
        rows = [r if len(r) <= max_len else r[: max_len - 4] + r[-4:] for r in self.tok([builder(t) for t in texts], truncation=False)["input_ids"]]
        width = max(len(r) for r in rows); pad = self.tok.pad_token_id if self.tok.pad_token_id is not None else self.tok.eos_token_id
        ids = torch.tensor([r + [pad] * (width - len(r)) for r in rows])
        mask = torch.tensor([[1] * len(r) + [0] * (width - len(r)) for r in rows])
        return ids, mask

    def logits(self, ids, mask):
        h = self.backbone(input_ids=ids.cuda(), attention_mask=mask.cuda()).last_hidden_state
        last = mask.sum(1).cuda() - 1                       # right padding -> last real token
        h = h[torch.arange(h.shape[0]), last]
        with torch.autocast("cuda", enabled=False):
            return h.float() @ self.rows.float().T          # (B, 9) in fp32

@torch.no_grad()
def score(model: LetterModel, texts, bs=16, builder=letter_prompt, n=9):
    """Raw logits (len(texts), n) of the first n option letters. `builder` maps an item of `texts` to its prompt."""
    model.eval(); out = [None] * len(texts)
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
    for s in range(0, len(order), bs):
        idx = order[s : s + bs]
        ids, mask = model.encode([texts[i] for i in idx], builder=builder)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            lg = model.logits(ids, mask)
        for i, row in zip(idx, lg[:, :n].cpu()): out[i] = row
    return torch.stack(out)                                  # raw logits (n, 9)


def tos_prompts(rows, version="letters-v1", context=True):
    """ToS prompts for data rows ({"text", "prev"?}). context=False blanks the previous sentence (ablation)."""
    from prompt import tos_prompt
    return [tos_prompt(version, r["text"], r.get("prev") if context else None) for r in rows]

def score_prompts(model, prompts, bs=16, n=9):
    """Like score(), for prompts that are already built."""
    return score(model, prompts, bs=bs, builder=lambda p: p, n=n)
