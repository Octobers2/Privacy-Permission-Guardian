# Privacy & Permission Guardian

A Chrome / Edge MV3 extension that does two things:

- **Policy summary** — finds the site's privacy policy or terms of service and
  turns it into 3–5 plain-language risk points, each backed by a quote that is
  checked, word for word, against the source document.
- **Form risk warning** — scans forms for sensitive personal-data fields and
  warns when the combination of domain, field set and form target looks like
  phishing. This half runs entirely offline: no API key, no network.

一個 GenAI + Cybersecurity 課程 project。中文文件喺 [`docs/`](docs/)。

## The design principle

A tool that talks about privacy has to be private itself. **Field values never
leave the page** — only field metadata (type, name, label) — and URLs are
stripped of their query string before anything is sent. The `FormField` schema
has no `value` key, it is `.strict()`, and there is a test on both the extension
and the server side that fails if one is ever added.

## Stack

Bun · TypeScript · Svelte 5 · Vite + CRXJS · Material Design 3 · Hono · zod

Deliberately few dependencies: `bun test`, `bun:sqlite`, `Bun.password` and
Bun's TypeScript support are built in, the headless browser is driven over the
DevTools protocol by ~250 lines rather than by Puppeteer, and the content
script — the only code that runs on every page the user visits — is **25 KB**
with nothing else behind it.

## Quick start

```bash
bun install
bun run build          # → packages/extension/dist/
```

`chrome://extensions` → Developer mode → Load unpacked → pick
`packages/extension/dist/`.

The form warnings work immediately. For the policy summary, open the options
page and pick one of the two modes.

**Direct / BYOK** — point it at your own OpenAI-compatible endpoint. Any
`/chat/completions` works: OpenAI, OpenRouter, DeepSeek, Groq, or a local
Ollama. For Ollama, set `OLLAMA_ORIGINS=chrome-extension://*` so it accepts
requests from the extension.

**Managed** — run the backend. It holds the API key, shares one cache between
everybody testing, and opens policy pages in a headless Chromium, which is the
only way to read the ones that are rendered by JavaScript (Next.js sites, Meta,
TikTok — by now most large sites).

```bash
cp packages/server/.env.example packages/server/.env    # fill in the endpoint
bun run auth add yourname                               # asks for a password
bun run server                                          # localhost:8787
```

Then put that username and password into the extension's options page and press
測試連線. **Nobody can use the server until `auth add` has been run**: it holds
an API key and a browser, so an open one is a free LLM and a free page fetcher
for anyone who finds the port. Credentials live in `auth.txt` at the repository
root — `username:bcrypt-hash`, one per line, gitignored — and the server rereads
it when it changes, so adding a user needs no restart.

The server needs a `chromium` on `PATH` (`PPG_CHROMIUM` to point elsewhere).

## Commands

| | |
|---|---|
| `bun test` | Unit tests (225 across 17 files) |
| `bun run build` | Build the extension |
| `bun run dev` | Build with HMR |
| `bun run server` | Managed backend |
| `bun run auth add <name>` | Add a backend user (also `list`, `remove`) |
| `bun run fixtures` | Serve the evaluation fixtures under their real hostnames |
| `bun run e2e` | Load the built extension in headless Chromium and check everything |
| `bun run eval:rules` | Precision / recall / confusion matrix |
| `bun run eval:injection` | Prompt injection defence measurements |
| `bun run fixtures:check` | Verify no fixture in the repo is still live |

## Documentation

| | |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | How the pieces fit, and the three decisions that are not obvious |
| [`docs/threat-model.md`](docs/threat-model.md) | What leaves the browser, the five injection defences, and what none of them can stop |
| [`docs/evaluation.md`](docs/evaluation.md) | The measurements, and why the current numbers should not go in a report yet |
| [`docs/demo-script.md`](docs/demo-script.md) | Six steps, five minutes, with an automated equivalent |
| [`eval/fixtures/README.md`](eval/fixtures/README.md) | How to collect and defuse phishing samples safely |

## Status

| | |
|---|---|
| Rule engine, banner, options, offline detection | done (`w1-rules-only`) |
| Policy summary end to end, both modes, managed backend | done (`w2-llm-e2e`) |
| Evaluation harnesses, injection measurements, docs | done |
| **Collected (non-synthetic) fixtures** | **outstanding — see `docs/evaluation.md` §0** |
| LLM arms of the detection evaluation | needs an endpoint |

Every fixture in the repository today was written by this project, so the
detection numbers measure whether the code does what it was written to do, not
whether it detects phishing. That gap is the next piece of work, and
`eval/fixtures/README.md` is the instructions for closing it.
