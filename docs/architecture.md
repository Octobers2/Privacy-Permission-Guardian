# Architecture

This is how the pieces fit and why they are shaped this way. For what each is made of, see the [README](../README.md); for the threats the design answers, see [threat-model.md](threat-model.md).

## The idea in one paragraph

A language model reads a site's terms on the user's computer and labels every sentence. Reading is slow and needs a GPU, so the result can be shared: a contributor's extension uploads the flagged clauses of a public document, the server keeps them for 30 days, and everyone else (including people with no GPU) looks them up. What leaves the device is therefore only flagged clauses of public pages, only from signed-in contributors, and only after a personal-data check.

```
 ┌──────────────── browser ────────────────┐            ┌────────── results server ──────────┐
 │ content script   policy links, forms,    │            │ /api/v1/*   public reads           │
 │                  form-warning banner     │            │ /api/results   upload (contributor)│
 │ service worker   finds the terms, keeps  │   HTTPS    │ /api/summary   metered, optional   │
 │                  state, talks to server  │ ◄────────► │ /models/*      model bundles       │
 │ offscreen doc    WebLLM engine + analysis│            │ /  /site/<d>  /docs   query site   │
 │ popup/settings/setup   Svelte pages      │            │ SQLite: results, passages, summaries│
 └──────────────────────────────────────────┘            └────────────────────────────────────┘
        ▲ model files are downloaded once, from the server, into the browser's cache
```

## Packages

| Package | Role |
|---|---|
| `packages/shared` | Everything that must behave identically in the extension, the server and the Python code: labels and families, the two prompts, the text pipeline, personal-data rules, zod schemas for uploads and views, the form-warning rules. Pure TypeScript, no browser or server APIs. |
| `packages/extension` | The MV3 extension, built with Vite and CRXJS. |
| `packages/server` | Hono on Bun. Also holds the query site (`public/`) and `scripts/demo.ts`. |
| `ml/` | Training, evaluation, quantisation and packaging, in Python. Talks to the rest only through files: the model bundles and `ppg-model.json`. |

## The extension

Manifest V3 gives a service worker that sleeps after seconds, and a model that takes minutes to read a long document. The design follows from that.

- **Content script** (every page, about 37 KB). Scans forms and collects page-level signals for the warning banner (see *The form warning* below), and answers two questions for the service worker: which links on this page look like terms, and, if this page is itself a terms page, what its text is. It never reads the page's text for the classifier unless asked.
- **Service worker.** Thin on purpose. It finds the terms (`background/acquire.ts`): the live page if it is a terms page, otherwise the linked and guessed addresses fetched and rendered in the offscreen document, otherwise a hidden background tab for pages that only exist once their scripts run. It hands the text to the offscreen document, keeps per-tab state in `chrome.storage.session` and saved results in `chrome.storage.local` (30 days, at most 50), and paints the toolbar badge. Nothing it needs later lives only in memory.
- **Offscreen document.** Owns the model (one engine, jobs queued) and runs the analysis (`analysis/analyzer.ts`), because it outlives the service worker. It reports progress by messages, which the service worker writes into session storage. The popup just follows storage.
- **Engine** (`engine/engine.ts`). WebLLM loads a model bundle served by our server. The model is used as a classifier: for each prompt, the logits of the option letters at the first answer position become probabilities (a `LogitProcessor` reads them, because WebLLM's `top_logprobs` stops at five and there are nine options). If the GPU is lost mid-run, the engine reloads once and carries on.
- **Setup wizard** (`setup/`). Opens on install: checks WebGPU (reporting why it fails), offers the two models with their sizes, downloads and verifies one, runs a five-question self-test, and asks about the two optional extras (summaries, contributor sign-in). A computer with no usable GPU can choose shared results only.
- **Popup, settings, banner.** Svelte 5 with hand-written Material 3 tokens (`scripts/gen-theme.ts`). The popup's central picture is the *document strip*: one tick per sentence, the flagged ones tall and coloured by family.

Preferences (`prefs.ts`) hold the server address, the model, the mode (`device` or `shared`), the summary choice, the contributor token, and the form-warning allowlist. They live in `chrome.storage.local`, not `sync`, because they contain a token.

### The analysis flow

For one tab, in order. Each step can stop the flow, and the earlier ones are the privacy gate.

1. **Acquire** the terms text and its address (service worker).
2. **Rules check** (`shared/pii.ts`): does the text contain personal data about a person (a private email address, a card number that passes the Luhn check, a national ID, an IBAN, a date of birth, account markers)? Terms pages legitimately print company contact details, so phone numbers, role mailboxes and street addresses count only alongside other cues. If the page looks personal, the extension never contacts the server about it.
3. **Cache lookup** (`/api/v1/lookup?url=…&hash=…`). A hit whose text hash matches is shown straight away, together with similar clauses from other sites (`/api/v1/results/:id/similar`). A changed text is read again.
4. **Classify** on the device: split the text into sentences (`segmentDocument`), normalise each the way the training text was, ask the model for the nine-way answer, calibrate with the fitted temperature. Progress streams to the popup. In the same pass the fee rules (`shared/money.ts`) run on every sentence, fair ones included. They are patterns, not the model, and fill a fifth family, **Money** (automatic renewal, cancellation fee, no refund, price change).
5. **Model personal-data question** on the page (`pii-v1`, two options, threshold 0.5). This is the second opinion after the rules.
6. **In short** (`shared/local-summary.ts`): three to five points from the findings, ranked by a fixed severity per clause type, with fixed plain-English wording and the document's own sentence as the quote. The risk level is `riskScore` over every type found (50 and above is high, 20 and above medium). No model writes it.
7. **Offer to share**, only if the user is signed in as a contributor and everything above passed. The analysis stops at `sharing: offer`; the popup shows what would be sent and the upload (`analysis/share.ts`, run by the service worker) happens only on **Share**. Fair sentences travel as a count; every passage is checked again with the strict rules.
8. **Similar cases** (`analysis/similar.ts`), only on the **Find similar cases** button for a result read here: the flagged sentences go to `POST /api/v1/similar`, which finds stored clauses of the same type on other sites (SQLite FTS5 candidates ranked by BM25, kept when the word overlap is at least 0.35) and returns counts and three examples.
9. **Summary**, only if the user opted in at setup and the page passed: the flagged passages go to the server's `/api/summary` (or to the user's own OpenAI-compatible endpoint, kept as an advanced option).

**No terms found.** If acquisition finds no terms at all (no link, no usual address), the flow does not stop. The background reads the page's own text and runs steps 2 to 6 on it as a `noTerms` job: no cache lookup, never offered for sharing (`sharing: page-only`), and not saved. The page then shows a Caution banner with what the model found, and the popup says the result is about the page and not about terms. A page with a password or card form and no terms, legal-notice or privacy link gets the cheap version of the same banner on load, with no model (`content/no-terms.ts`).

Shared-results-only mode replaces steps 1 to 7 with one request, `GET /api/v1/sites/<domain>`, and shows the best document for the page (the one the page links to, then one that looks like terms, then the newest). Only the registrable domain of a public site is sent; localhost, private addresses and bare host names are refused before any request.

### Text pipeline

The classifier was trained on lower-cased, Penn-Treebank-tokenised sentences, which is not how a web page reads. `shared/classifier-text.ts` splits a document into sentences (dropping fragments under 25 characters or 5 words, cutting any over 1,200 characters) and normalises each (lower-case, URLs and emails protected, Treebank rules). 99.7% of the benchmark's sentences reproduce exactly. The prompts and the normaliser are **locked to the Python reference by golden files**: `ml/golden_prompts.py` and `ml/golden_text.py` write them, and unit tests require the TypeScript to match byte for byte. Change one side and the other's tests fail.

### The form warning

Separate from the classifier and needing no model. Two kinds of evidence go into one score, so the thresholds (60 for danger, 30 for caution), the allow-list and the cap for well-known brands act on a single number.

1. **Form rules** (`shared/rules.ts`, `shared/extract-form.ts`): what a form asks for (card numbers, CVV, national IDs, bank accounts, passwords), where it posts (another domain), look-alike domains, cheap top-level domains, passwords over plain HTTP.
2. **Page signals** (`shared/page-signals.ts`, collected by `content/page-signals.ts`): the text of the page's scripts (read, never run) and the list of hosts the page has contacted (from a `PerformanceObserver` over resource timing, which needs no permission and shows addresses only). From these, rules look for data sent to a Telegram bot, a webhook, a form relay or a test endpoint; sensitive fields on a page that talks to unrelated hosts (common infrastructure such as payment, analytics and error-reporting hosts is ignored); a script that keeps triggering the debugger, blocks F12 or detects open developer tools; and an icon hot-linked from another site.

A page with no form can still raise a warning: the standalone rules (a bot token, an icon that belongs to a known brand, a data-exfiltration destination) are enough on their own, while blocking developer tools alone is not. The banner says "this site" instead of "this form" in that case.

**Icon check.** The one check that makes a request of its own. When a page has already scored something (a form of at least 15 points, or another page-level hit), the service worker fetches the page's icon from the site the user is already on, decodes it locally (`createImageBitmap` and `OffscreenCanvas`, since it is an image and nothing is parsed as markup), reduces it to a 64-bit perceptual hash and compares it with a committed table of well-known brands. The result is cached per registered domain for a month, and the setting "Check site icons" turns it off. The table ships empty: `bun run favicons` generates it from the brands' own sites and needs the network, and until then this rule never fires.

Page signals travel from the content script to the service worker and stop there; they are not part of anything sent to a server.

## The results server

Hono on Bun, SQLite through `bun:sqlite`, one process. Source in `packages/server/src`.

**Routes**

| Route | Who | What |
|---|---|---|
| `GET /health` | anyone | `{ ok, ttlDays, authRequired }` and nothing else |
| `POST /api/login` | anyone | username and password, answers a bearer token (12 hours, held in memory). Locks a name out for 15 minutes after repeated failures |
| `POST /api/results` | contributor | upload a result. Validated by a strict schema, the host must be public, the domain must match the address, and the passages are checked again for personal data |
| `GET /api/v1/sites/:domain` | anyone | the current result of every document of a site, with passages |
| `GET /api/v1/lookup?url=&hash=` | anyone | the current result for one document, and whether the text changed |
| `GET /api/v1/results/:id`, `/history?url=` | anyone | one result; every unexpired version of one document |
| `GET /api/v1/results/:id/similar`, `POST /api/v1/similar` | anyone (the POST is metered) | clauses like the flagged ones on other sites. The GET uses stored text; the POST takes up to 50 sentences from the extension, checks them for personal data and keeps nothing |
| `POST /api/v1/reports/missing-terms`, `GET /api/v1/missing-terms[/:domain]` | anyone (the POST is metered) | "this site has no terms": one row per site, a count, kept 30 days from the last report. A site that has shared results is refused. One report per client per site per day |
| `GET /api/v1/recent`, `/rankings?by=count\|share`, `/stats` | anyone | lists for the site |
| `POST /api/summary` | anyone (metered) | plain-language summary of flagged passages. Per-client and global hourly limits; answers cached by passages |
| `GET /models/manifest.json`, `/models/<bundle>/…` | anyone | model bundles with HTTP Range, ETag and immutable cache headers |
| `GET /`, `/site/<domain>`, `/docs`, static files | anyone | the query site |
| `GET /api/status`, `POST /api/form/assess` | contributor | operator status; optional model-assisted form assessment |

Reads are public by design; the point is that results are shared. CORS is open for reads and for the public preflight; writes answer only extension origins and an optional allow-list.

**Storage** (`store.ts`)

- `results` (one row per upload: address, domain, text hash, model, counts, `created_at`, `expires_at`), `passages` (flagged sentences with their nine probabilities), `passages_fts` (the same sentences, full-text indexed, for similar cases), `money_clauses` (the fee-rule sentences of a result), `missing_terms` (one row per reported site) and `summaries` (cached by passages, prompt version and model).
- **Cache key:** the policy address with query string and fragment removed. **Latest wins:** the newest unexpired row for an address is "current"; older rows stay as history until they expire. A change in the text hash is what marks a real change in the terms.
- **TTL:** 30 days from upload. Reads ignore expired rows at once; a daily job (and one at boot) deletes them. The clock is injectable, which is how the tests cover expiry.

**Models.** `scripts/model-manifest.ts` walks `data/models`, reads each bundle's `ppg-model.json`, hashes the files and writes `manifest.json`. The extension reads the manifest, shows each model's size and held-out test scores, and verifies the kernel it loads against a SHA-256 integrity value.

## The query site

Plain files in `packages/server/public`, mounted by `src/site.ts` after every API route so the API's prefixes (`/api`, `/models`, `/health`) are never answered with a page. No build step. Clean URLs: `/`, `/site/<domain>`, `/docs`. The pages call the same server's public API. Passages are inserted as text only, and the pages are served with a policy that allows scripts, styles and fonts from the site's own origin and requests to nothing else. The stylesheet's colours are generated by the same script as the extension's.

## Model bundles

Two bundles, built by `ml/` and served from `data/models`:

| Tier | Base | Weights | Notes |
|---|---|---|---|
| Fast | Qwen3.5-0.8B | 451 MB | recommended first |
| Accurate | Qwen3.5-4B | 2.4 GB | slower to load; many fewer false alarms on the personal-data question (see [evaluation.md](evaluation.md)) |

Both are 4-bit (`q4f32_1`) and reuse WebLLM's prebuilt Qwen3.5 kernels, with the context window set to 2,048 tokens (the longest measured prompt is about 1.2k). Each bundle carries a `ppg-model.json` with its id, tier, size, the token ids of the answer letters, the fitted temperatures and the held-out scores.

## Testing map

| What | Where |
|---|---|
| Prompts and text pipeline match Python | `packages/shared/test` with the golden files |
| Personal-data rules, schemas, form rules | `packages/shared/test` |
| Store, TTL, latest-wins, routes, rate limits, models, site | `packages/server/test` |
| Analyzer, engine, shared lookup, prefs, scout | `packages/extension/test` |
| Whole flows in a real browser | `eval/run-*-e2e.ts` |
