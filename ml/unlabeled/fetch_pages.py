# /// script
# dependencies = ["httpx", "beautifulsoup4", "lxml"]
# ///
"""Step 1 of 3 for unlabelled distillation data: fetch the terms pages in tos_urls.txt -> data/unlabeled_pages.jsonl.
Block structure is kept (one line per paragraph or list item), because the extension's sentence splitter works per block.
run:  uv run ml/unlabeled/fetch_pages.py [--urls other_list.txt]
next: bun run eval/segment-unlabeled.ts, then ml/unlabeled/filter.py"""
import argparse, json, pathlib, httpx
from bs4 import BeautifulSoup

H = pathlib.Path(__file__).parent
ap = argparse.ArgumentParser(); ap.add_argument("--urls", default=str(H / "tos_urls.txt")); a = ap.parse_args()
urls = [l.strip() for l in open(a.urls) if l.strip() and not l.lstrip().startswith("#")]
BLOCKS = ["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "td", "dd", "dt", "blockquote", "pre"]
out, failed = [], []
with httpx.Client(follow_redirects=True, timeout=30, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/153.0 Safari/537.36"}) as c:
    for u in urls:
        try:
            r = c.get(u); r.raise_for_status()
            soup = BeautifulSoup(r.text, "lxml")
            for t in soup(["script", "style", "noscript", "nav", "header", "footer", "svg", "form", "button"]): t.decompose()
            main = soup.find("main") or soup.find("article") or soup.body or soup
            # leaf text blocks only (an <li> holding <p>s would otherwise be read twice)
            lines = [" ".join(b.get_text(" ").split()) for b in main.find_all(BLOCKS) if not b.find(BLOCKS)]
            text = "\n".join(l for l in lines if l)
            if len(text) < 3000: raise ValueError(f"only {len(text)} chars (needs JavaScript, or not a terms page)")
            out.append({"url": str(r.url), "text": text[:300_000]})
            print(f"ok   {len(text):>7} chars  {u}")
        except Exception as e:
            failed.append(u); print(f"FAIL {type(e).__name__}: {str(e)[:80]}  {u}")
dest = H.parent / "data" / "unlabeled_pages.jsonl"; dest.parent.mkdir(exist_ok=True)
dest.write_text("\n".join(json.dumps(o, ensure_ascii=False) for o in out))
print(f"\n{len(out)} pages saved to {dest}, {len(failed)} failed")
