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
