# /// script
# dependencies = ["faker"]
# ///
"""Synthetic pages for the PII question. label 1 = shows the signed-in person's own personal data, 0 = public/anonymous page.
All people are fake (Faker). Whole templates are held out for the test split to measure generalisation to unseen page types.
usage: uv run make_data.py   -> ../data/pii_{train,val,test}.jsonl"""
import json, pathlib, random, string
from faker import Faker

OUT = pathlib.Path(__file__).parents[1] / "data"
rng = random.Random(7)
fk = {loc: Faker(loc) for loc in ("en_US", "en_GB", "zh_CN", "zh_TW", "en_AU")}
for f in fk.values(): f.seed_instance(rng.randrange(10**6))

def hkid():
    L = rng.choice(string.ascii_uppercase); d = [rng.randrange(10) for _ in range(6)]
    s = 36 * 9 + (ord(L) - 55) * 8 + sum(v * (7 - i) for i, v in enumerate(d)); c = (11 - s % 11) % 11
    return f"{L}{''.join(map(str, d))}({'A' if c == 10 else c})"

class P:  # one fake person
    def __init__(self):
        self.f = fk[rng.choice(list(fk))]
        self.name = self.f.name(); self.first = self.name.split()[0]
        self.email = rng.choice([self.f.free_email(), self.f.email(), f"{self.first.lower()}{rng.randrange(99)}@{rng.choice(['gmail.com','outlook.com','qq.com','yahoo.com','icloud.com'])}"])
        self.phone = rng.choice([self.f.phone_number(), f"+852 {rng.randrange(2000,9999)} {rng.randrange(1000,9999)}", f"+1 ({rng.randrange(200,999)}) {rng.randrange(200,999)}-{rng.randrange(1000,9999)}"])
        self.addr = self.f.address().replace("\n", ", ")
        self.dob = self.f.date_of_birth(minimum_age=18, maximum_age=80).strftime(rng.choice(["%d/%m/%Y", "%B %d, %Y", "%Y-%m-%d"]))
        self.card = self.f.credit_card_number(); self.iban = self.f.iban(); self.hkid = hkid()
        self.order = rng.randrange(10**6, 10**7); self.handle = self.first.lower() + str(rng.randrange(100))

NAV = ["Home", "Products", "Pricing", "About", "Contact", "Help", "Blog", "Careers", "Sign out", "Log in", "Search", "Cart (2)", "EN | 中文"]
def nav(): return " | ".join(rng.sample(NAV, rng.randrange(3, 8)))
LEGAL = ["We may suspend or terminate your access at any time without notice.", "You agree to resolve disputes through binding arbitration and waive any right to a class action.",
 "These terms are governed by the laws of the State of California.", "We may change these terms at any time; continued use means you accept the changes.",
 "The service is provided as is, and we disclaim all warranties to the fullest extent permitted by law.", "We are not liable for any indirect or consequential damages.",
 "You grant us a worldwide, royalty-free licence to host and display content you submit.", "We may remove content that violates these terms at our sole discretion.",
 "We collect your name, email address, phone number, device identifiers and usage data.", "We share information with service providers and advertising partners.",
 "You may request access to or deletion of your personal data by contacting us.", "We retain information for as long as necessary to provide the service."]
FILL = ["Lorem ipsum dolor sit amet, consectetur adipiscing elit.", "New features are rolling out this week across all plans.", "Read our latest customer stories and release notes.",
 "Sign up for the newsletter to get product updates.", "Our team is distributed across twelve countries.", "Free shipping on orders over $50.", "Compare plans and pick the one that fits your team."]
def legal(n=6): return " ".join(rng.sample(LEGAL, min(n, len(LEGAL))))
def fill(n=3): return " ".join(rng.choices(FILL, k=n))
def company():
    f = fk["en_US"]; return f"{f.company()}, {f.address().replace(chr(10), ', ')}. Email: {rng.choice(['legal','privacy','support','dpo','info'])}@{f.domain_name()}. Tel: {f.phone_number()}."
ITEMS = ["Wireless headphones", "Running shoes", "Coffee grinder", "USB-C hub", "Desk lamp", "Yoga mat", "Backpack", "Notebook set"]

# real clauses (the ToS classifier data) make policy-page negatives far less repetitive than hand-written sentences
POOLS = {sp: [json.loads(l)["text"] for l in (OUT / f"{f}.jsonl").open()] for sp, f in (("train", "train"), ("val", "val"), ("test", "test"))}
CUR = {"split": "train"}
def real_policy_page(p):
    pool = POOLS[CUR["split"]]; body = " ".join(rng.sample(pool, rng.randrange(5, 10)))
    return (rng.choice(["/terms", "/legal/terms-of-service", "/privacy-policy", "/user-agreement", "/policies/terms"]), f"{rng.choice(['Terms of Service', 'Privacy Policy', 'User Agreement'])} {body} Contact: {company()}")

# ---- templates: (name, label, fn(P)->(url_path, text)) ----
POS = {
 "dashboard": lambda p: ("/account", f"{nav()} My Account Welcome back, {p.name}. Email {p.email} Phone {p.phone} Member since 2019. Recent orders: #{p.order} {rng.choice(ITEMS)} delivered. Saved addresses: {p.addr}. {fill(1)}"),
 "order_confirmation": lambda p: ("/orders/confirmation", f"Thank you for your order, {p.first}! Order #{p.order}. Shipping to: {p.name}, {p.addr}. Payment: card ending {p.card[-4:]}. A confirmation was sent to {p.email}. Items: {rng.choice(ITEMS)} x1. {fill(1)}"),
 "bank_statement": lambda p: ("/statements/2024-05", f"{nav()} Statement for {p.name}. Account number {rng.randrange(10**9,10**10)}. IBAN {p.iban}. Opening balance 2,340.55. 03 May Rent -1,200.00. 07 May Salary +4,800.00. Contact {p.phone}. {p.addr}"),
 "profile_settings": lambda p: ("/settings/profile", f"Profile settings. Full name {p.name}. Date of birth {p.dob}. Email {p.email}. Phone {p.phone}. Address {p.addr}. Change password. Delete account. {nav()}"),
 "checkout_prefilled": lambda p: ("/checkout", f"Checkout Shipping address {p.name} {p.addr} Contact {p.email} {p.phone} Payment Card number {p.card} Expiry 09/27 {fill(1)}"),
 "social_profile": lambda p: (f"/u/{p.handle}", f"@{p.handle} {p.name} Joined 2018 Lives in {p.f.city()} Born {p.dob} Contact: {p.email} 128 following 412 followers Edit profile {nav()}"),
 "payslip": lambda p: ("/hr/payslip", f"Payslip May 2024 Employee {p.name} Employee ID E{rng.randrange(10000,99999)} National ID {p.hkid} Bank account {p.iban} Gross pay 38,500 Net pay 33,120 Home address {p.addr}"),
 "stealth_dashboard": lambda p: (rng.choice(["/home", "/overview", "/app"]), f"{nav()} Welcome back, {p.first}! You have {rng.randrange(1,9)} unread messages. Balance ${rng.randrange(100,9000)}.{rng.randrange(10,99)} Next bill due June {rng.randrange(1,28)}. Recent activity: transfer to {p.f.first_name()} ${rng.randrange(10,500)}. Upgrade your plan."),
 "stealth_orders": lambda p: ("/your-purchases", f"Hi {p.first}. Your purchases: {rng.choice(ITEMS)} delivered May {rng.randrange(1,28)} ${rng.randrange(10,200)}.99; {rng.choice(ITEMS)} arriving Friday; return window closes soon. Track package. Buy it again. {fill(1)}"),
 # held-out for test only:
 "stealth_health": lambda p: ("/results", f"Hi {p.first}, your lab results are ready. Cholesterol {rng.randrange(3,7)}.{rng.randrange(0,9)} mmol/L. Blood pressure {rng.randrange(110,150)}/{rng.randrange(70,95)}. Your doctor has added a note. Book a follow-up appointment. Sign out"),
 "stealth_messages": lambda p: ("/chat", f"Conversations: {p.f.first_name()} - see you at 8? | {p.f.first_name()} - sent a photo | Mum - call me later. You: ok, running late. {p.f.first_name()} is typing… {nav()}"),
 "inbox": lambda p: ("/mail/inbox", f"Inbox (12) Compose {p.name} <{p.email}> Primary Social Promotions From: {p.f.name()} <{p.f.email()}> Subject: Your invoice From: {p.f.name()} <{p.f.email()}> Subject: Meeting tomorrow Signed in as {p.email}"),
 "patient_portal": lambda p: ("/portal/records", f"Patient portal Patient: {p.name} DOB {p.dob} ID {p.hkid} Medications: metformin 500 mg. Next appointment 14 June, Dr. {p.f.last_name()}. Phone on file {p.phone}. {p.addr}"),
 "insurance_policy": lambda p: ("/policies/overview", f"Your policy Policy number P{rng.randrange(10**7,10**8)} Insured: {p.name} ID {p.hkid} Beneficiary {p.f.name()} Premium paid monthly by card {p.card[:4]} **** **** {p.card[-4:]} {p.email}"),
}
NEG = {
 "tos_real": real_policy_page,
 "tos": lambda p: ("/terms", f"Terms of Service {legal(7)} Last updated 2024-05-17. Contact: {company()}"),
 "privacy": lambda p: ("/privacy", f"Privacy Policy {legal(7)} Data controller: {company()}"),
 "docs": lambda p: ("/docs/api", f"{nav()} API reference. Install with npm install acme-sdk. Call client.init({{apiKey}}). Example: send mail to user@example.com. Version 2.3.1 released 2024-05-17. Rate limit 100 requests per minute."),
 "blog": lambda p: ("/blog/2024/launch", f"{nav()} {p.f.sentence(12)} {p.f.paragraph(4)} Posted by the editorial team on May 17, 2024. {fill(2)}"),
 "landing": lambda p: ("/", f"{nav()} {fill(4)} Start your free trial. Trusted by 10,000 teams. {fill(2)} © 2024 Acme Inc."),
 "login": lambda p: ("/login", f"Sign in Email address Password Forgot your password? Remember me Sign in with Google Don't have an account? Create account {legal(1)}"),
 "contact": lambda p: ("/contact", f"Contact us {fill(1)} Head office: {company()} Opening hours Mon-Fri 9:00-18:00."),
 # held-out for test only:
 "faq": lambda p: ("/help/faq", f"Help centre FAQ How do I change my email address? Go to Settings and choose Edit profile. How do I reset my password? Click Forgot password on the sign-in page. How do I close my account? {fill(2)}"),
 "product": lambda p: ("/products/" + rng.choice(ITEMS).lower().replace(" ", "-"), f"{nav()} {rng.choice(ITEMS)} $49.99 In stock. Reviews: 'Great sound' by {p.first} {p.f.last_name()[0]}., 'Fast delivery' by {fk['en_US'].first_name()} K. {fill(2)}"),
 "bio_public": lambda p: ("/wiki/" + p.name.replace(" ", "_"), f"{p.name} (born {p.dob}) is a {rng.choice(['novelist','footballer','politician','physicist'])} from {p.f.city()}. {p.f.paragraph(4)} Early life. Career. Awards. References."),
}
HELD_POS, HELD_NEG = {"inbox", "patient_portal", "insurance_policy", "stealth_health", "stealth_messages"}, {"faq", "product", "bio_public"}

def make(label, name, fn, split):
    CUR["split"] = split
    p = P(); path, text = fn(p)
    if rng.random() < .5: text = f"{nav()} " + text            # chrome around the content
    host = rng.choice(["shop.example.net", "www.acme.com", "app.bluebank.example", "portal.example.org"])
    n = rng.choice([400, 700, 1000, 1500])
    return {"url": f"https://{host}{path}", "text": text[:n], "label": label, "kind": name, "src": "synthetic", "split": split}

rows = {"train": [], "val": [], "test": []}
def gen(table, held, label):
    for name, fn in table.items():
        if name in held:
            rows["test"] += [make(label, name, fn, "test") for _ in range(120)]
        else:
            rows["train"] += [make(label, name, fn, "train") for _ in range(330)]
            rows["val"] += [make(label, name, fn, "val") for _ in range(50)]
            rows["test"] += [make(label, name, fn, "test") for _ in range(60)]
gen(POS, HELD_POS, 1); gen(NEG, HELD_NEG, 0)
# real public policy pages: negatives for val/test (head + middle window of each)
real = [json.loads(l) for l in (OUT / "pii_real_negatives.jsonl").open() if json.loads(l)["text"]] if (OUT / "pii_real_negatives.jsonl").exists() else []
real = [r for r in real if len(r["text"]) > 2000]
for r in real:
    for off in (0, len(r["text"]) // 2):
        rows["test"].append({"url": r["url"], "text": r["text"][off:off + 1200], "label": 0, "kind": "real_policy", "src": "real", "split": "test"})
for k, v in rows.items():
    rng.shuffle(v); (OUT / f"pii_{k}.jsonl").write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in v))
    print(k, len(v), "pos", sum(x["label"] for x in v))
