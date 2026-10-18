# Running the server

The results server is one Bun process. It stores shared results, hosts the model files, serves the public API and the query site, and (if you give it a language-model key) writes plain-language summaries. What it holds is described in [architecture.md](architecture.md); what to worry about is in [threat-model.md](threat-model.md).

## Set it up

```bash
bun install
cp packages/server/.env.example packages/server/.env     # then edit
bun run auth add alice                                     # a contributor account; asks for a password twice
bun run server                                             # listens on PPG_PORT, default 8787
```

On start it prints where it is listening, how many results it holds, where the models and the summary endpoint are, and how many contributors exist. With no contributors, nobody can upload; reading and the site still work.

### Settings (`packages/server/.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PPG_PORT` | 8787 | listening port |
| `PPG_DB_FILE` | `data/ppg.sqlite` | SQLite file for results and cached summaries |
| `PPG_MODELS_DIR` | `data/models` | model bundles served at `/models/*` |
| `PPG_AUTH_FILE` | `auth.txt` | contributor accounts (`username:bcrypt-hash`, one per line) |
| `PPG_BASE_URL`, `PPG_API_KEY`, `PPG_MODEL` | OpenAI, empty, `gpt-4o-mini` | an OpenAI-compatible endpoint for summaries. With no key, `/api/summary` answers 503 and everything else works. `PPG_BASE_URL` must end in the API path (for example `/v1`) |
| `PPG_TEMPERATURE`, `PPG_MAX_TOKENS`, `PPG_TIMEOUT_MS` | 0, 1200, 30000 | model call settings |
| `PPG_SUMMARY_PER_IP_HOUR`, `PPG_SUMMARY_GLOBAL_HOUR` | 20, 500 | summary requests per client address and across everyone |
| `PPG_TRUST_PROXY` | off | set to `1` only behind a proxy that sets `X-Forwarded-For` |
| `PPG_ALLOWED_ORIGINS` | none | extra browser origins allowed to call write routes (extension origins always are) |

Relative paths are relative to `packages/server`. The files `data/` and `auth.txt` are ignored by git.

### Contributors

```bash
bun run auth add <name>       # add or change a password
bun run auth list             # names only
bun run auth remove <name>
```

The server rereads `auth.txt` when it changes, so no restart is needed. Tokens last 12 hours and live in memory; a restart signs everyone out.

### Models

The extension downloads models from `/models`. Put each bundle (made by `ml/`, see [ml.md](ml.md)) and the prebuilt kernel files in `data/models`, then:

```bash
bun run models:manifest      # hashes every file, writes data/models/manifest.json
```

Run it again after any change to a bundle. If a bundle is symlinked from another disk, the symlink is followed. The manifest is what the setup page lists, so a bundle that is not in it does not exist for users. After changing a bundle's files, users who already downloaded it fetch only the files whose hashes changed.

## Put it on the internet

- **Use HTTPS.** Put the server behind a reverse proxy or a tunnel that terminates TLS. Over plain HTTP, tokens and downloads can be read by anyone on the path.
- **Set `PPG_TRUST_PROXY=1`** if, and only if, the proxy sets `X-Forwarded-For`, so the summary limits see real client addresses.
- **Use a CDN for `/models/*` if you expect traffic.** The files are 0.4 to 2.4 GB; they are served with Range requests, an ETag and a one-year immutable cache header, which suits one.
- **Point the extension at it.** Users enter the address on the setup page and in settings. For a build with a fixed address, set `VITE_PPG_SERVER` when running `bun run build`.
- **Make sure the proxy passes through `POST` bodies up to 1 MB** (uploads) and does not rewrite 5xx responses (see the next section).

Run it under a supervisor, for example a systemd unit with `WorkingDirectory` set to the repository and `ExecStart=/path/to/bun run packages/server/src/index.ts`, and `Restart=on-failure`.

## Health and logs

- `GET /health` answers `{"ok":true,"ttlDays":30,"authRequired":true}` and nothing about the deployment. Use it for a probe.
- `GET /api/status` (needs a token) adds the summary model, whether summaries are available, and counts.
- Failed summary requests are logged as `[summary] <status> <kind>: <reason> (model … at …)`; the client only receives the kind. Start there when summaries fail.
- A daily job (and one at start-up) deletes expired results and summaries.

## Backups

Results are public and expire after 30 days, so they are cheap to lose. If you want a copy anyway, copy `data/ppg.sqlite` together with its `-wal` file while the server is stopped, or use `sqlite3 data/ppg.sqlite ".backup copy.sqlite"` while it runs. Back up `auth.txt` if you cannot recreate the accounts.

## When something is wrong

| Symptom | Likely cause | Look at |
|---|---|---|
| The popup says "Loading" forever after an update | the browser still runs the previous service worker | reload the extension at `chrome://extensions`; the popup now offers a reload button |
| Setup fails with "Cache.add() network error" | the browser's storage is full (a 4 GB model) or the connection was cut | free disk space; check the proxy's size and timeout limits |
| The extension cannot download a model | `manifest.json` missing or stale | run `bun run models:manifest`, and check `GET /models/manifest.json` |
| Summary requests return a bare `error code: 502` | the proxy or the CDN is hiding our JSON error: the app's own failures are JSON with `error` and `message` | call `POST /api/summary` on the server itself and read the JSON; then read the `[summary]` log line. Usual causes: wrong `PPG_API_KEY`, unreachable or wrong `PPG_BASE_URL` (missing `/v1`), wrong `PPG_MODEL` |
| Summary requests return 503 | no `PPG_API_KEY` | set it and restart |
| 429 on summaries | the per-client or global hourly limit | raise `PPG_SUMMARY_*`, or check the proxy is passing real client addresses |
| Everyone shares one rate limit | `PPG_TRUST_PROXY` is off behind a proxy | turn it on if the proxy sets `X-Forwarded-For` |
| Uploads answer 422 `pii_blocked` | a flagged sentence looks like personal data | working as intended; the response lists positions, never text |
| Uploads answer 401 | the 12-hour token expired, or the server restarted | sign in again from the extension |

A quick local test of the summary route, with a made-up hash:

```bash
curl -i -X POST localhost:8787/api/summary -H 'content-type: application/json' \
  -d '{"url":"https://example.com/terms","domain":"example.com","textHash":"'$(head -c32 /dev/urandom | sha256sum | cut -d" " -f1)'","passages":[{"category":"arbitration","text":"Any dispute will be resolved by binding arbitration."}]}'
```

## Trying it without a model or contributors

`bun run demo` starts the server on a throwaway in-memory database filled with invented sites, on port 8788 (`PPG_DEMO_PORT`). Nothing is written to `data/`.
