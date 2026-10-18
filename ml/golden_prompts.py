"""Writes packages/shared/test/fixtures/prompts.golden.json: inputs and the exact prompts the Python side builds.
The TypeScript builders must reproduce every string byte for byte (see packages/shared/test/classifier-prompt.test.ts).
Run after any change to prompt.py:  uv run --with-editable . golden_prompts.py   (or just: python3 golden_prompts.py)"""
import json, pathlib
from prompt import letter_prompt, pii_prompt, PROMPT_VERSION, PII_PROMPT_VERSION

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
out = {"letters": PROMPT_VERSION, "pii": PII_PROMPT_VERSION,
       "tos": [{"passage": p, "prompt": letter_prompt(p)} for p in TOS],
       "pii_cases": [{"url": u, "text": t, "prompt": pii_prompt(u, t)} for u, t in PII]}
dest = pathlib.Path(__file__).parents[1] / "packages/shared/test/fixtures/prompts.golden.json"
dest.parent.mkdir(parents=True, exist_ok=True); dest.write_text(json.dumps(out, ensure_ascii=False, indent=1))
print("wrote", dest, len(out["tos"]), "tos +", len(out["pii_cases"]), "pii cases")
