"""Load Qwen3.5 backbone (+ optional Kev LoRA) and score passages by the logits of the 9 letter tokens."""
import glob, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from prompt import LETTERS, letter_prompt

BASE = "Qwen/Qwen3.5-4B-Base"
KEV = glob.glob("/ironwolf/ppg-cache/hf/hub/models--jaredpalmer--kev-4b/snapshots/*")[0]

class LetterModel(torch.nn.Module):
    def __init__(self, adapter: str | None = KEV, trainable=False):
        super().__init__()
        self.tok = AutoTokenizer.from_pretrained(BASE)
        lm = AutoModelForCausalLM.from_pretrained(BASE, dtype=torch.bfloat16, device_map={"": 0})
        self.backbone = lm.model
        ids = [self.tok.convert_tokens_to_ids("Ġ" + L) for L in LETTERS]
        assert all(i is not None and i != self.tok.unk_token_id for i in ids), ids
        self.register_buffer("rows", lm.get_output_embeddings().weight[ids].detach().clone())  # (9, hidden)
        del lm.lm_head
        if adapter:
            from peft import PeftModel
            self.backbone = PeftModel.from_pretrained(self.backbone, adapter, is_trainable=trainable)
        for p in self.backbone.parameters(): p.requires_grad_(False)
        if trainable:
            for n, p in self.backbone.named_parameters():
                if "lora_" in n: p.requires_grad_(True)

    def encode(self, texts, max_len=1024):
        enc = self.tok([letter_prompt(t) for t in texts], return_tensors="pt", padding=True, truncation=False)
        # right-pad, truncate from the passage side only if absurdly long (prompt tail "Answer:" must survive)
        ids, mask = enc["input_ids"], enc["attention_mask"]
        if ids.shape[1] > max_len:
            keep = torch.cat([ids[:, : max_len - 4], ids[:, -4:]], 1) if (mask.sum(1) == ids.shape[1]).all() else None
            if keep is None: raise ValueError("overlong prompt in mixed batch; sort/limit lengths")
            ids, mask = keep, torch.ones_like(keep)
        return ids, mask

    def logits(self, ids, mask):
        h = self.backbone(input_ids=ids.cuda(), attention_mask=mask.cuda()).last_hidden_state
        last = mask.sum(1).cuda() - 1                       # right padding -> last real token
        h = h[torch.arange(h.shape[0]), last]
        with torch.autocast("cuda", enabled=False):
            return h.float() @ self.rows.float().T          # (B, 9) in fp32

@torch.no_grad()
def score(model: LetterModel, texts, bs=16):
    model.eval(); out = [None] * len(texts)
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
    for s in range(0, len(order), bs):
        idx = order[s : s + bs]
        ids, mask = model.encode([texts[i] for i in idx])
        with torch.autocast("cuda", dtype=torch.bfloat16):
            lg = model.logits(ids, mask)
        for i, row in zip(idx, lg.cpu()): out[i] = row
    return torch.stack(out)                                  # raw logits (n, 9)
