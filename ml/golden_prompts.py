"""Writes packages/shared/test/fixtures/prompts.golden.json: inputs and the exact prompts the Python side builds.
The TypeScript builders must reproduce every string byte for byte (see packages/shared/test/classifier-prompt.test.ts).
Run after any change to prompt.py:  uv run --with-editable . golden_prompts.py   (or just: python3 golden_prompts.py)"""
import json, pathlib
from prompt import letter_prompt, letter_prompt_v2, pii_prompt, PROMPT_VERSION, PII_PROMPT_VERSION, LETTERS_V2

TOS = ["you can control most communications from the services . ",
       "  We may terminate your account at any time.\n\n",
       "subject to your compliance with these terms , uber grants you a limited license ( i ) access ( ii ) use .",
       "Any dispute shall be resolved by arbitration — not in court. 请用中文。😀",
       "x" * 3000]
LONG = "word " * 600
PII = [("https://shop.example.net/account/orders", "My Account Welcome back, Jane. Order #1234 shipped."),
       ("https://app.bluebank.example/wiki/曾鈺婷?token=abc#top", "A  page\twith\nodd   whitespace　and ideographic space."),
       ("https://portal.example.org/u/张云1/", "emoji 😀 at the edge " + "y" * 1190 + "😀😀"),
       ("https://docs.acme.com:8443/guide/a%20b", LONG),
       ("http://example.com", "no path at all"),
       ("https://example.com/legal/terms?x=1", ""),
       ("HTTPS://Example.COM:443/Path", "default port and upper-case host"),
       ("http://example.com:80", "default http port, no path"),
       ("https://[2001:db8::1]:8443/a", "ipv6 with port"),
       ("https://example.com/a%zzb%E4%B8%AD", "malformed escape next to a valid one")]
PREV = [None, "", "   \n\t ", "we may update these terms . \n", "Prior   sentence\twith\u3000odd whitespace.", "z" * 399 + "😀😀", "q " * 300]
V2 = [(p, q) for p, q in zip(TOS, PREV)] + [(TOS[1], PREV[5]), (TOS[3], PREV[6])]
out = {"letters": PROMPT_VERSION, "letters_v2": LETTERS_V2, "pii": PII_PROMPT_VERSION,
       "tos_v2": [{"passage": p, "previous": q, "prompt": letter_prompt_v2(p, q)} for p, q in V2],
       "tos": [{"passage": p, "prompt": letter_prompt(p)} for p in TOS],
       "pii_cases": [{"url": u, "text": t, "prompt": pii_prompt(u, t)} for u, t in PII]}
# the flag decision (calibrate.decide <-> decideCategory): random probability rows, ties included, at a few thresholds
import numpy as np
from calibrate import decide
from prompt import NAMES
rng = np.random.default_rng(0); rows = rng.dirichlet(np.ones(9) * 0.5, 40); rows[0] = np.full(9, 1 / 9); rows[1, [0, 3]] = rows[1, [0, 3]].max()
out["decisions"] = [{"probs": r.tolist(), "threshold": t, "category": NAMES[int(decide(r[None], NAMES.index("other"), t)[0])]}
                    for t in (None, 0.5, 0.8, 0.95) for r in rows]
dest = pathlib.Path(__file__).parents[1] / "packages/shared/test/fixtures/prompts.golden.json"
dest.parent.mkdir(parents=True, exist_ok=True); dest.write_text(json.dumps(out, ensure_ascii=False, indent=1))
print("wrote", dest, len(out["tos"]), "tos +", len(out["tos_v2"]), "tos v2 +", len(out["pii_cases"]), "pii cases +", len(out["decisions"]), "decisions")
