# Privacy & Permission Guardian

A Chrome / Edge MV3 extension that does two things:

- **Policy summary** — pulls a site's Privacy Policy / ToS and turns it into 3–5 plain-language
  risk points, each backed by a verbatim quote from the source document.
- **Form risk warning** — scans forms for sensitive personal-data fields and warns when the
  combination of domain, field set and form target looks like phishing.

## Design principle

A tool that talks about privacy has to be private itself. Field **values** are never
transmitted — only field **metadata** (type / name / label), and URLs are stripped of their
query string before leaving the browser.

## Stack

Bun · TypeScript · Svelte 5 · Vite + CRXJS · Material Design 3 · Hono · zod

## Quick start

```bash
bun install
bun run build          # → packages/extension/dist/
```

Then load `packages/extension/dist/` as an unpacked extension at `chrome://extensions`
(Developer mode on).

See `docs/` for architecture, threat model and the demo script.
