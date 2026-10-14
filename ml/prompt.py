"""Category definitions shared by every baseline / training / eval script."""
import json, pathlib

HERE = pathlib.Path(__file__).parent
LABELS = json.loads((HERE / "labels.json").read_text())
NAMES = [LABELS["mteb"][str(i)] for i in range(9)]   # class order = MTEB ids

DEFINITIONS = {
    "limitation_of_liability": "The provider excludes or limits its liability for damages, losses or failures.",
    "contract_by_using": "The user is bound by the terms merely by using, accessing or continuing to use the service.",
    "unilateral_change": "The provider may change the terms or the service at any time at its own discretion.",
    "arbitration": "Disputes must be settled by arbitration instead of in court, including class-action waivers.",
    "content_removal": "The provider may remove or modify user content at its discretion.",
    "choice_of_law": "The clause states which country's or state's law governs the terms.",
    "other": "None of the above: an ordinary clause that is not one of these unfair-clause types.",
    "unilateral_termination": "The provider may suspend or terminate the user's account or access at its discretion.",
    "jurisdiction": "The clause names the court or place where disputes must be litigated.",
}
INSTRUCTIONS = "Which type of terms-of-service clause is this passage?"


# ---- letter-scoring format (what the browser runs): 9-way softmax over the logits of " A".." I" ----
LETTERS = list("ABCDEFGHI")
PROMPT_VERSION = "letters-v1"

def letter_prompt(passage: str) -> str:
    opts = "\n".join(f"{L}) {n.replace('_', ' ')}" for L, n in zip(LETTERS, NAMES))
    return f"Classify this terms-of-service passage.\n{opts}\n\nPassage: {passage.strip()}\nAnswer:"


# ---- PII question: does this page show private information about the person using it? (2 options: A personal, B public) ----
PII_PROMPT_VERSION = "pii-v1"

def pii_prompt(url: str, text: str) -> str:
    from urllib.parse import unquote, urlsplit
    u = urlsplit(url); where = f"{u.netloc}{unquote(u.path)}"             # never the query string; paths are shown decoded (what a person reads)
    return ("Decide whether this web page shows private information about the person using it "
            "(their account, orders, messages, health, finances, contact or ID details) or is a public page.\n"
            f"A) personal\nB) public\n\nPage address: {where}\nPage text: {' '.join(text.split())[:1200]}\nAnswer:")
