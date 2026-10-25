# Privacy & Permission Guardian

Terms of service are written to be skipped. This project reads them for you and points at the clauses that tend to work against you: forced arbitration, accounts closed without notice, terms that change whenever the company likes.

The reading happens **on your own computer**. A small language model runs inside the browser through WebGPU, so the text of the page you are looking at is not sent anywhere. What people choose to share is a short list of flagged clauses, and that list is public.

It has four parts:

| Part | What it is | Where |
|---|---|---|
| **Extension** | Chrome and Edge (Manifest V3). Finds a site's terms, classifies them on the device, warns about suspicious forms. | [`packages/extension`](packages/extension) |
| **Results server** | Bun and SQLite. Keeps shared results for 30 days, hosts the model files, serves the public API and the query site. | [`packages/server`](packages/server) |
| **Query site** | Plain HTML, CSS and JavaScript, served by the results server. Look up any site that has been read. | [`packages/server/public`](packages/server/public) |
| **Classifier** | Two Qwen3.5 models (4B and 0.8B) trained on unfair terms-of-service clauses, plus a personal-data question. Python training and packaging code. | [`ml`](ml) |

Shared code (labels, prompts, text splitting, personal-data rules, schemas) lives in [`packages/shared`](packages/shared).

## How it works

1. You open a site and press the toolbar icon. The extension finds the site's terms (the page itself, a link on it, or a usual address such as `/terms`) and reads the text.
2. A rule check and a model question decide whether the page shows **your own personal data**. If it does, nothing leaves the device.
3. Otherwise the extension asks the server whether someone has already read this document. If so, you get that result in under a second.
4. If not, the on-device model reads the document sentence by sentence and picks one of nine classes for each (eight kinds of unfair clause, or "other"). You see the flagged clauses, grouped into four families: your rights, liability, their control, consent.
5. Next to the clauses you get **In short**: three to five plain-English points with a low, medium or high risk level, each with the document's own sentence underneath. It is built on your computer from what the model found, and needs no extra model. Renewals, cancellation fees, refunds and price changes are found by fixed patterns and shown in their own family, **Money**.
6. If you are signed in as a contributor, the popup then asks **Share this result?** and lists exactly what would be sent. Nothing is shared until you press Share, so the next visitor can get step 3 only if you choose. **Find similar cases** (on the clause list) shows which other sites have a clause like each flagged one, again only when you press it. You can also ask for an optional plain-language summary written by a server model.

A computer without a usable graphics card can skip the model and use **shared results only**: the popup then looks up what others have already found and reads nothing itself.

The form warning is separate and needs no model. It scores forms on the page for signs of phishing and shows a banner, labelled **Caution** or **Critical risk**.

**Sites with no terms.** A page that asks for a password or a card, and links no terms or privacy policy, gets a Caution banner. When you press the toolbar button on a site where no terms can be found, the on-device model reads the page itself, and the banner and popup say what it found. Anyone can then press **Report this site** (it sends the page address and the places that were checked, nothing else); reports are public, counted, and kept for 30 days, and other people see "someone else has reported this site". It also reads the page itself for signs that need no form at all: data sent somewhere it has no business going (a Telegram bot, a form-forwarding service), a site icon that belongs to a well-known brand the domain does not own, and a page that actively fights the browser's developer tools. A phishing kit with no `<form>` is still caught. The brand icon table (`packages/shared/src/favicon-hashes.json`) ships empty; `bun run favicons` fills it and needs the network.

## Run it

You need [Bun](https://bun.sh) and Chromium or Chrome.

```bash
bun install
bun run build                 # builds the extension to packages/extension/dist
bun run demo                  # a throwaway server with invented sites, on http://localhost:8788
```

Open `http://localhost:8788` to see the query site. To use the real thing:

```bash
cp packages/server/.env.example packages/server/.env     # optional: a model endpoint for summaries
bun run auth add yourname                                  # a contributor account (asks for a password)
bun run server                                             # http://localhost:8787
```

The server needs model bundles in `data/models` before the extension can download one: see [docs/ml.md](docs/ml.md) for how they are made and [docs/operations.md](docs/operations.md) for hosting them (`bun run models:manifest` indexes them).

Then load the extension: open `chrome://extensions`, turn on developer mode, choose **Load unpacked** and pick `packages/extension/dist`. The setup page opens by itself. After every rebuild, press the reload icon on the extension's card, or the browser keeps running the old version.

## Test it

```bash
bun test                      # unit tests (424 across 34 files)
bun run e2e                   # builds, then runs every browser check below
```

| Check | What it drives |
|---|---|
| `bun run e2e:analysis` | The full flow on fake sites: read on the device, the share question, public cache, a changed policy, a page showing personal data, similar clauses, no terms (the page is read instead, and reported), signed out |
| `bun run e2e:setup` | The setup wizard end to end, downloading and loading a real model (`--model accurate` for the 4B) |
| `bun run e2e:shared` | Shared-results-only mode in a browser with no GPU |
| `bun run e2e:site` | The query site: search, filters, history, a hostile passage shown as text |
| `bun run e2e:banner` | The form warning on phishing and legitimate fixtures |

The analysis and setup checks need a WebGPU-capable Chromium (`CHROMIUM=/path/to/chromium` to override) and the model bundles in `data/models`. More in [docs/evaluation.md](docs/evaluation.md).

## What it can and cannot do

- It finds **clause types that research has shown to be unfair**. It does not judge whether a clause is legal where you live, and a clean result is not a guarantee: skim the document when it matters.
- On the benchmark it was built against (2,048 clauses, never used for training) the shipped models score a macro-F1 of 0.76 (4B) and 0.77 (0.8B). Most clauses are fair, so the numbers per clause type matter more than the average: see [docs/evaluation.md](docs/evaluation.md).
- Results come from contributors you trust. There is no moderation tool yet, and a contributor can upload a wrong result. See [docs/threat-model.md](docs/threat-model.md).
- English terms only. The classifier was trained on English.

## Where to read next

- [docs/architecture.md](docs/architecture.md): how the pieces fit, the analysis flow, the API
- [docs/ml.md](docs/ml.md): data, training, quantisation, packaging and how to reproduce them
- [docs/evaluation.md](docs/evaluation.md): the numbers, how they were measured and what they do not show
- [docs/threat-model.md](docs/threat-model.md): what is protected, from whom, and what is not
- [docs/operations.md](docs/operations.md): running and hosting the server
- [docs/demo-script.md](docs/demo-script.md): a ten-minute walk through for showing it

## Repository layout

```
packages/extension   MV3 extension (Svelte 5): popup, settings, setup wizard, banner, on-device engine
packages/server      results server (Hono on Bun) and the query site in public/
packages/shared      labels, prompts, text pipeline, personal-data rules, schemas (used by all three)
ml/                  training, evaluation, quantisation and packaging (Python)
eval/                end-to-end checks, fixtures, screenshots, small measurements
scripts/             `auth` (contributor accounts) and `models:manifest`
spike/               early experiments, kept for their findings (WebLLM)
data/                runtime data: the results database and model bundles (not in git)
docs/                the documentation above
```
