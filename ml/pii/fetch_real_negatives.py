# /// script
# dependencies = ["httpx", "beautifulsoup4", "lxml"]
# ///
"""Real public policy pages = the deployment distribution for uploads. Saved to data/pii_real_negatives.jsonl (not committed)."""
import json, pathlib, httpx
from bs4 import BeautifulSoup
URLS = """https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement
https://policies.google.com/terms
https://policies.google.com/privacy
https://www.mozilla.org/en-US/about/legal/terms/mozilla/
https://www.mozilla.org/en-US/privacy/websites/
https://wikimediafoundation.org/wiki/Terms_of_Use/en
https://foundation.wikimedia.org/wiki/Policy:Privacy_policy
https://www.cloudflare.com/website-terms/
https://www.cloudflare.com/privacypolicy/
https://stripe.com/legal/ssa
https://stripe.com/privacy
https://www.spotify.com/us/legal/end-user-agreement/
https://www.spotify.com/us/legal/privacy-policy/
https://openai.com/policies/terms-of-use/
https://openai.com/policies/privacy-policy/
https://discord.com/terms
https://discord.com/privacy
https://www.reddit.com/policies/user-agreement
https://www.reddit.com/policies/privacy-policy
https://www.dropbox.com/terms
https://www.dropbox.com/privacy
https://slack.com/terms-of-service
https://www.notion.so/notion/Terms-and-Privacy-28ffdd083dc3473e9c2da6ec011b58ac""".split()
out = []
with httpx.Client(follow_redirects=True, timeout=30, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/153.0 Safari/537.36"}) as c:
    for u in URLS:
        try:
            r = c.get(u); r.raise_for_status()
            soup = BeautifulSoup(r.text, "lxml")
            for t in soup(["script", "style", "noscript", "nav", "header", "footer", "svg"]): t.decompose()
            main = soup.find("main") or soup.find("article") or soup.body or soup
            text = " ".join(main.get_text(" ").split())
            out.append({"url": str(r.url), "text": text[:60000], "label": 0, "src": "real"})
            print(f"ok   {len(text):>7} chars  {u}")
        except Exception as e:
            print(f"FAIL {type(e).__name__} {u}")
pathlib.Path(__file__).parents[1].joinpath("data", "pii_real_negatives.jsonl").write_text("\n".join(json.dumps(o) for o in out))
