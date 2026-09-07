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

Deliberately few dependencies: `bun test`, `bun:sqlite` and Bun's TypeScript
support are built in, and the content script — the only code that runs on every
page the user visits — is **23 KB** with nothing else behind it.

## Quick start

```bash
bun install
bun run build          # → packages/extension/dist/
```

`chrome://extensions` → Developer mode → Load unpacked → pick
`packages/extension/dist/`.

The form warnings work immediately. For the policy summary, open the options
page and either point it at your own OpenAI-compatible endpoint (Direct / BYOK)
or start the managed backend:

```bash
cp packages/server/.env.example packages/server/.env    # fill in the endpoint
bun run server                                          # localhost:8787
```

Any OpenAI-compatible `/chat/completions` works: OpenAI, OpenRouter, DeepSeek,
Groq, or a local Ollama. For Ollama, set `OLLAMA_ORIGINS=chrome-extension://*`
so it accepts requests from the extension.

## Commands

| | |
|---|---|
| `bun test` | Unit tests (177 across 15 files) |
| `bun run build` | Build the extension |
| `bun run dev` | Build with HMR |
| `bun run server` | Managed backend |
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
