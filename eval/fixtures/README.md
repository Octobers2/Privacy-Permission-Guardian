# Fixtures

Every page the evaluation runs against. `../labels.csv` is the index: it says
which file holds a fixture, the URL it should be judged as, whether a human
labelled it phishing, and where it came from.

## synthetic vs collected

| `source` | What it is | What it is good for |
|---|---|---|
| `synthetic` | Written by this project | Development and regression tests |
| `collected` | A snapshot of a page nobody here wrote | The numbers in the report |

**Only `collected` fixtures belong in a headline detection rate.** A page we
wrote while looking at the rules will score well on those rules; that measures
whether the code does what it was written to do, not whether it detects
phishing. `run-rules-eval.ts` prints a warning when the set is all synthetic and
takes `--collected-only`.

## Collecting a fixture safely

**Do not open live phishing URLs in your normal browser.** Use a separate
profile, or better, fetch the page without rendering it:

```bash
curl -sL --max-time 20 -A 'Mozilla/5.0' 'https://the-suspicious-url.example/' -o saved.html
```

Sources for candidate URLs: PhishTank and OpenPhish publish feeds; the entries
are frequently already dead, which is fine — a dead URL still has an archived
copy worth snapshotting, and a page that no longer resolves cannot hurt you.

For the legitimate half, save real pages that ask for a lot of personal data:
bank account opening, government forms, insurance quotes, checkout flows. Those
are the ones the detector is most likely to get wrong, and a set of easy
negatives would flatter the results.

## Defusing, which is not optional

```bash
bun run eval/sanitize-fixture.ts saved.html \
  --host login.microsoft-verify.example \
  --label phishing \
  --path /signin \
  --notes "Fake Outlook sign-in, credentials posted cross-origin"
```

This removes `<script>` elements and inline handlers, cuts every remote
reference, rewrites form actions to `#`, and strips any values that were
autofilled when the page was saved. It then appends a row to `labels.csv` with
`source=collected`.

Raw phishing HTML in git is a working phishing page that everyone who clones the
repository has a copy of and can open by accident. Defusing changes nothing the
evaluation measures — the rule engine reads field names, types, labels and the
domain, and never executes anything.

Verify before committing:

```bash
bun run eval/sanitize-fixture.ts --check eval/fixtures/phishing/*.html
```

## Multi-page fixtures

A homepage that links to a privacy policy cannot be tested with a single file.
Those live under `sites/<hostname>/`, where the request path picks the file
(`/` serves `index.html`). See `sites/www.datahungry.example/`.

### Manual-test sites: unfair terms and sensitive forms

Three invented companies, written to read like the large sites people actually use, for trying the extension by hand
(`bun run fixtures`, then open the hostnames in Chromium with the printed flags). They use no real brand names, logos or
layouts, and their forms post nowhere. **They are test fixtures only; do not host them anywhere public.**

| Host | Style | Pages | What to expect |
|---|---|---|---|
| `www.pomme.example` | device maker | `/`, `/terms`, `/privacy`, `/signin`, `/checkout`, `/support`, `/cookies` | Terms flag arbitration, unilateral change, termination, content removal, liability, jurisdiction and choice of law. `/checkout` asks for card, CVV and national ID: the form warning reaches danger. |
| `www.gogol.example` | search and cloud account | `/`, `/terms`, `/privacy`, `/signup`, `/verify`, `/traffic`, `/help`, `/about` | Same clause families in a different voice. The footer has a decoy link, "Maps traffic conditions", which the policy finder must not pick over "Terms of Service". `/verify` asks for ID, SSN and a card number: the form warning reaches caution. |
| `www.northvale-bank.example` | online bank | `/`, `/terms`, `/privacy`, `/login`, `/open-account`, `/security`, `/fees` | Footer link is titled "Online Banking Terms and Conditions". `/login` asks for a card PIN and mother's maiden name; `/open-account` for SSN and CVV (danger). The `/login` form is a known gap: the rules do not yet treat a card PIN or a security question as sensitive, so it currently scores safe. |

Only the homepages are listed in `labels.csv` (as `legit`, so the end-to-end run checks that they do not reach "danger").

### Added for the demo video and the "no terms" warning

| Host | Pages | What to expect |
|---|---|---|
| `www.pomme-demo.com` | the Pomme folder again, under a public-looking name | The results server only stores and reports addresses on public domains, and `.example` is not one. A `demo` row in `labels.csv` serves the same folder (`sites/www.pomme.example/`) under this name, so sharing and "similar cases" can be shown. Pomme's terms also carry a "5a. Subscriptions and fees" section (automatic renewal, an early termination fee, no refunds), so the **Money** family has something to find. |
| `www.quickloan-demo.com` | `/` (marketing, **no link to terms or a privacy policy anywhere**), `/signup` (name, email, password, card number, CVV, and a paragraph of one-sided fine print) | The page-level warning "asks for your details but publishes no terms": a Caution banner with **Report this site**. Pressing the toolbar button makes the model read the page itself and the banner says what it found. |
| `account-verify-center.top` | `/` and `favicon.png` | Nothing in the domain names a brand; the page borrows Google's public icon (`favicon.png` is the 32 px frame of Google's own icon) and posts a password to another domain. The rules alone give a caution; the favicon check (the table built by `bun run favicons`) adds "the icon is identical to the one used by Google", which makes it **Critical risk**. Marked `demo` in `labels.csv`, so the rules-only evaluation leaves it out (it needs a browser to fetch the icon). |

Two additions to the fixture server: a file with a known extension next to a site's pages (an icon, a stylesheet) is served as itself,
and a site's folder is taken from the `file` column, not from the host, so one folder can answer to two names.
`eval/fixtures/terms/scam-demo.com/` (used by `bun run e2e:analysis`) is the same idea as QuickLoan for the end-to-end test.
