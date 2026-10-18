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

- **Content script** (every page, about 29 KB). Scans forms for the warning banner, and answers two questions for the service worker: which links on this page look like terms, and, if this page is itself a terms page, what its text is. It never reads the page unless asked.
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
3. **Cache lookup** (`/api/v1/lookup?url=…&hash=…`). A hit whose text hash matches is shown straight away. A changed text is read again.
4. **Classify** on the device: split the text into sentences (`segmentDocument`), normalise each the way the training text was, ask the model for the nine-way answer, calibrate with the fitted temperature. Progress streams to the popup.
5. **Model personal-data question** on the page (`pii-v1`, two options, threshold 0.5). This is the second opinion after the rules.
6. **Share**, only if the user is signed in as a contributor and everything above passed: upload the flagged passages with their probabilities, the address (without query or fragment), the text hash, and the model id. Fair sentences travel as a count. Every passage is checked again with the strict rules.
7. **Summary**, only if the user opted in at setup and the page passed: the flagged passages go to the server's `/api/summary` (or to the user's own OpenAI-compatible endpoint, kept as an advanced option).

Shared-results-only mode replaces steps 1 to 7 with one request, `GET /api/v1/sites/<domain>`, and shows the best document for the page (the one the page links to, then one that looks like terms, then the newest). Only the registrable domain of a public site is sent; localhost, private addresses and bare host names are refused before any request.

### Text pipeline

The classifier was trained on lower-cased, Penn-Treebank-tokenised sentences, which is not how a web page reads. `shared/classifier-text.ts` splits a document into sentences (dropping fragments under 25 characters or 5 words, cutting any over 1,200 characters) and normalises each (lower-case, URLs and emails protected, Treebank rules). 99.7% of the benchmark's sentences reproduce exactly. The prompts and the normaliser are **locked to the Python reference by golden files**: `ml/golden_prompts.py` and `ml/golden_text.py` write them, and unit tests require the TypeScript to match byte for byte. Change one side and the other's tests fail.

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
| `GET /api/v1/recent`, `/rankings?by=count\|share`, `/stats` | anyone | lists for the site |
| `POST /api/summary` | anyone (metered) | plain-language summary of flagged passages. Per-client and global hourly limits; answers cached by passages |
| `GET /models/manifest.json`, `/models/<bundle>/…` | anyone | model bundles with HTTP Range, ETag and immutable cache headers |
| `GET /`, `/site/<domain>`, `/docs`, static files | anyone | the query site |
| `GET /api/status`, `POST /api/form/assess` | contributor | operator status; optional model-assisted form assessment |

Reads are public by design; the point is that results are shared. CORS is open for reads and for the public preflight; writes answer only extension origins and an optional allow-list.

**Storage** (`store.ts`)

- `results` (one row per upload: address, domain, text hash, model, counts, `created_at`, `expires_at`), `passages` (flagged sentences with their nine probabilities), `summaries` (cached by passages, prompt version and model).
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
