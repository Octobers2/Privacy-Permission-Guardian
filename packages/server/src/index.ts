/**
 * The backend.
 *
 *   public     GET  /api/v1/*            cached classification results (read-only)
 *              GET  /models/*            model bundles for the extension's setup screen
 *              POST /api/summary         optional plain-language summary (rate limited, opt-in on the client)
 *   trusted    POST /api/login           username + password -> bearer token
 *              POST /api/results         upload a classification result (public once stored)
 *              GET  /api/status, POST /api/form/assess
 *
 * Who can write is decided by `auth.txt` (`bun run auth add <name>`); who can read is everybody, by design: the point
 * of the cache is that a site's classification is a public fact anyone can look up.
 *
 *   cp .env.example .env && bun run dev
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  buildFormPrompt,
  buildSummaryPrompt,
  chatJson,
  finaliseSummary,
  FormAssessmentSchema,
  FormAssessRequestSchema,
  isPublicHostname,
  LlmError,
  LoginRequestSchema,
  passageHasPii,
  registrableDomain,
  ResultUploadSchema,
  SUMMARY_PROMPT_VERSION,
  SummaryModelResponseSchema,
  SummaryRequestSchema,
  type EndpointConfig,
  type Summary,
} from '@ppg/shared';
import { AuthStore } from './auth.ts';
import { serveModelFile } from './models.ts';
import { RateLimiter } from './ratelimit.ts';
import { createSite } from './site.ts';
import { ResultStore } from './store.ts';

export interface ServerOptions {
  /** The OpenAI-compatible endpoint used for summaries and form assessments. */
  config: EndpointConfig;
  store: ResultStore;
  auth: AuthStore;
  modelsDir: string;
  /** Summary requests allowed per client per hour, and across all clients. */
  summaryPerIpPerHour?: number;
  summaryGlobalPerHour?: number;
  /** Read the client address from X-Forwarded-For. Only behind a proxy that sets it. */
  trustProxy?: boolean;
  /** Extra browser origins allowed to call the write routes (extension origins always are). */
  allowedOrigins?: string[];
  /** Injected by the tests so they never reach a real endpoint. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function envConfig(): EndpointConfig {
  return {
    baseUrl: Bun.env.PPG_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: Bun.env.PPG_API_KEY ?? '',
    model: Bun.env.PPG_MODEL ?? 'gpt-4o-mini',
    temperature: Number(Bun.env.PPG_TEMPERATURE ?? 0),
    maxTokens: Number(Bun.env.PPG_MAX_TOKENS ?? 1_200),
    timeoutMs: Number(Bun.env.PPG_TIMEOUT_MS ?? 30_000),
  };
}

function failure(error: unknown) {
  if (error instanceof LlmError) return { status: 502 as const, body: { error: error.kind, message: error.message } };
  return { status: 500 as const, body: { error: 'internal', message: 'Something went wrong on the server.' } };
}

const HOUR = 60 * 60 * 1_000;
const PUBLIC_CACHE = 'public, max-age=60';

/** `username` is set by the auth middleware and read by the handlers behind it. */
type Variables = { username: string };

function digest(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

function intParam(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Strips the query string and fragment: the cache is keyed on the document, not on a visit. */
function policyKey(raw: string | undefined): string | null {
  try {
    const u = new URL(raw ?? '');
    if (!/^https?:$/.test(u.protocol) || !isPublicHostname(u.hostname)) return null;
    u.search = '';
    u.hash = '';
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return null;
  }
}

export function createApp(options: ServerOptions): Hono<{ Variables: Variables }> {
  const site = createSite();
  const { config, store, auth, modelsDir, fetchImpl, trustProxy = false, allowedOrigins = [] } = options;
  const chatOptions = fetchImpl ? { fetchImpl } : {};
  const clock = options.now ?? Date.now;
  const perIp = new RateLimiter({ capacity: options.summaryPerIpPerHour ?? 20, perMs: HOUR, now: clock });
  const overall = new RateLimiter({ capacity: options.summaryGlobalPerHour ?? 500, perMs: HOUR, now: clock });

  const app = new Hono<{ Variables: Variables }>();

  const clientIp = (c: { req: { header: (n: string) => string | undefined; raw: Request }; env: unknown }): string => {
    if (trustProxy) return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const server = c.env as { requestIP?: (r: Request) => { address: string } | null } | undefined;
    return server?.requestIP?.(c.req.raw)?.address ?? 'unknown';
  };

  const extensionOrigin = (origin: string) => /^(chrome|moz)-extension:\/\//.test(origin) || allowedOrigins.includes(origin);

  /**
   * Reads are public, so any origin may read. Writes are protected by the token; on top of that a browser page on some
   * other site is not allowed to try them, so the response only opens for extension origins and the configured list.
   */
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    const read = c.req.method === 'GET' || c.req.method === 'HEAD';
    const publicPreflight = c.req.method === 'OPTIONS' && /^\/(api\/v1\/|models\/)/.test(c.req.path);
    if (read || publicPreflight) c.header('access-control-allow-origin', '*');
    else if (origin) {
      if (!extensionOrigin(origin)) return c.json({ error: 'origin_not_allowed', message: 'This origin may not call the API.' }, 403);
      c.header('access-control-allow-origin', origin);
      c.header('vary', 'origin');
    }
    c.header('access-control-allow-headers', 'content-type, authorization, range');
    c.header('access-control-allow-methods', 'GET, HEAD, POST, OPTIONS');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    await next();
  });

  /** Deliberately thin: "is a PPG server here?" and nothing about who runs it or what model it uses. */
  app.get('/health', (c) => c.json({ ok: true, ttlDays: 30, authRequired: true }));

  /** Everything under /api needs a token except login, the public API and the (rate-limited) summary. */
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;
    if (path === '/api/login' || path === '/api/summary' || path.startsWith('/api/v1/')) return next();
    const token = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
    const username = token ? auth.resolve(token) : null;
    if (!username) return c.json({ error: 'unauthorized', message: 'Sign in first.' }, 401);
    c.set('username', username);
    await next();
  });

  app.post('/api/login', async (c) => {
    const parsed = LoginRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400);
    const { username, password } = parsed.data;
    if (auth.isLockedOut(username)) {
      return c.json({ error: 'too_many_attempts', message: 'Too many failed sign-ins. Try again in 15 minutes.' }, 429);
    }
    if (!(await auth.verify(username, password))) {
      // One message for "no such user" and "wrong password": telling them apart helps whoever is guessing names.
      return c.json({ error: 'unauthorized', message: 'Wrong username or password.' }, 401);
    }
    return c.json(auth.issue(username));
  });

  app.get('/api/status', (c) =>
    c.json({
      ok: true,
      username: c.get('username'),
      summaryModel: config.model,
      summaryAvailable: config.apiKey !== '',
      ...store.stats(),
    }),
  );

  // ------------------------------------------------------------- uploading

  app.post(
    '/api/results',
    bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'too_large', message: 'The upload is larger than 1 MB.' }, 413) }),
    async (c) => {
      const parsed = ResultUploadSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400);
      const upload = parsed.data;

      const host = new URL(upload.url).hostname;
      if (!isPublicHostname(host)) {
        return c.json({ error: 'not_public', message: 'Only pages on the public internet can be shared.' }, 422);
      }
      if (registrableDomain(host) !== upload.domain.toLowerCase()) {
        return c.json({ error: 'domain_mismatch', message: 'The domain does not match the URL.' }, 422);
      }
      // Second line of defence: the extension already ran this. Reports positions only, never the text.
      const blocked = upload.passages.filter((p) => passageHasPii(p.text)).map((p) => p.index);
      if (blocked.length) {
        return c.json({ error: 'pii_blocked', message: 'Some passages look like personal data and were not stored.', indexes: blocked }, 422);
      }

      const { id, createdAt, expiresAt } = store.insert(upload, c.get('username'));
      return c.json({ id, url: upload.url, domain: upload.domain.toLowerCase(), createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() }, 201);
    },
  );

  // ------------------------------------------------------- public read API

  app.use('/api/v1/*', async (c, next) => {
    await next();
    if (c.res.status === 200) c.res.headers.set('cache-control', PUBLIC_CACHE);
  });

  /** The extension's cache check: the current result for a policy URL, and whether the text has changed since. */
  app.get('/api/v1/lookup', (c) => {
    const url = policyKey(c.req.query('url'));
    if (!url) return c.json({ error: 'bad_request', message: 'Give a public http(s) URL in ?url=.' }, 400);
    const result = store.lookup(url);
    if (!result) return c.json({ error: 'not_found', message: 'No current result for this policy.' }, 404);
    const hash = c.req.query('hash');
    return c.json({ result, sameText: hash ? hash === result.textHash : null });
  });

  app.get('/api/v1/sites/:domain', (c) => {
    const domain = c.req.param('domain').toLowerCase();
    if (!/^[a-z0-9.-]{1,253}$/.test(domain)) return c.json({ error: 'bad_request', message: 'Not a domain name.' }, 400);
    const documents = store.site(domain);
    if (!documents.length) return c.json({ error: 'not_found', message: 'No current results for this site.' }, 404);
    return c.json({ domain, documents });
  });

  app.get('/api/v1/results/:id', (c) => {
    const id = Number(c.req.param('id'));
    const result = Number.isInteger(id) ? store.get(id) : null;
    return result ? c.json(result) : c.json({ error: 'not_found', message: 'No such result, or it has expired.' }, 404);
  });

  app.get('/api/v1/history', (c) => {
    const url = policyKey(c.req.query('url'));
    if (!url) return c.json({ error: 'bad_request', message: 'Give a public http(s) URL in ?url=.' }, 400);
    return c.json({ url, versions: store.history(url) });
  });

  app.get('/api/v1/recent', (c) => c.json({ results: store.recent(intParam(c.req.query('limit'), 20, 1, 100)) }));

  app.get('/api/v1/rankings', (c) =>
    c.json({ by: c.req.query('by') === 'share' ? 'share' : 'count', rows: store.rankings(intParam(c.req.query('limit'), 20, 1, 100), c.req.query('by') === 'share' ? 'share' : 'count') }),
  );

  app.get('/api/v1/stats', (c) => c.json(store.stats()));

  // --------------------------------------------------------------- models

  app.on(['GET', 'HEAD'], '/models/*', async (c) => {
    let relative: string;
    try {
      relative = decodeURIComponent(c.req.path.slice('/models/'.length));
    } catch {
      return c.json({ error: 'bad_request', message: 'Bad path.' }, 400);
    }
    return serveModelFile(modelsDir, relative, c.req.raw);
  });

  // -------------------------------------------------------------- summary

  /**
   * The optional remote summary. Public (the extension may be signed out) but metered, and never reached unless the user
   * opted in during setup and the page passed the personal-data gate on the device.
   */
  app.post(
    '/api/summary',
    bodyLimit({ maxSize: 512 * 1024, onError: (c) => c.json({ error: 'too_large', message: 'The request is too large.' }, 413) }),
    async (c) => {
      const parsed = SummaryRequestSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400);
      const request = parsed.data;

      if (!policyKey(request.url)) return c.json({ error: 'not_public', message: 'Only pages on the public internet can be summarised.' }, 422);
      const blocked = request.passages.flatMap((p, i) => (passageHasPii(p.text) ? [i] : []));
      if (blocked.length) return c.json({ error: 'pii_blocked', message: 'Some passages look like personal data.', indexes: blocked }, 422);

      // Keyed on the passages too: a client must not be able to file invented passages under a real policy's hash.
      const key = ResultStore.summaryKey(`${request.textHash}:${digest(JSON.stringify(request.passages.map((p) => [p.category, p.text])))}`, SUMMARY_PROMPT_VERSION, config.model);
      const hit = store.summaryGet(key);
      if (hit) return c.json({ ...(JSON.parse(hit) as Summary), cached: true });

      if (config.apiKey === '') return c.json({ error: 'summary_unavailable', message: 'This server has no summary model configured.' }, 503);
      const ip = clientIp(c);
      for (const limiter of [perIp, overall]) {
        const taken = limiter.take(limiter === perIp ? ip : 'all');
        if (!taken.ok) {
          c.header('retry-after', String(Math.ceil(taken.retryAfterMs / 1_000)));
          return c.json({ error: 'rate_limited', message: 'Too many summary requests. Try again later.' }, 429);
        }
      }

      try {
        const { value } = await chatJson(config, buildSummaryPrompt(request), SummaryModelResponseSchema, chatOptions);
        const summary = finaliseSummary(value, { request, model: config.model, generatedAt: new Date(clock()).toISOString() });
        if (summary.points.length === 0) {
          return c.json({ error: 'unverified', message: 'The summary could not be checked against the document, so it was discarded.' }, 502);
        }
        store.summarySet(key, JSON.stringify(summary));
        return c.json(summary);
      } catch (error) {
        const { status, body } = failure(error);
        return c.json(body, status);
      }
    },
  );

  app.post('/api/form/assess', async (c) => {
    const parsed = FormAssessRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400);
    try {
      const { value } = await chatJson(config, buildFormPrompt(parsed.data), FormAssessmentSchema, chatOptions);
      return c.json(value);
    } catch (error) {
      const { status, body } = failure(error);
      return c.json(body, status);
    }
  });

  // ----------------------------------------------------------------- the public query site (last: everything above wins)

  app.on(['GET', 'HEAD'], '*', async (c) => (await site.respond(c.req.raw)) ?? c.notFound());

  return app;
}

/** Removes expired rows now and then daily. Reads already ignore them; this only reclaims the space. */
export function startPurgeJob(store: ResultStore, everyMs = 24 * HOUR): () => void {
  const run = () => {
    const { results, summaries } = store.purge();
    if (results || summaries) console.log(`purged ${results} expired results and ${summaries} summaries`);
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

const config = envConfig();
const store = new ResultStore({ file: Bun.env.PPG_DB_FILE });
const auth = new AuthStore();
const modelsDir = Bun.env.PPG_MODELS_DIR ?? new URL('../../../data/models', import.meta.url).pathname;
const app = createApp({
  config,
  store,
  auth,
  modelsDir,
  trustProxy: Bun.env.PPG_TRUST_PROXY === '1',
  allowedOrigins: (Bun.env.PPG_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  summaryPerIpPerHour: Number(Bun.env.PPG_SUMMARY_PER_IP_HOUR ?? 20),
  summaryGlobalPerHour: Number(Bun.env.PPG_SUMMARY_GLOBAL_HOUR ?? 500),
});
const port = Number(Bun.env.PPG_PORT ?? 8787);

if (import.meta.main) {
  startPurgeJob(store);
  const users = auth.count();
  const s = store.stats();
  console.log(`backend on http://localhost:${port}  (query site at /, API docs at /docs)`);
  console.log(`  results   ${s.results} current (${s.urls} policies, ${s.domains} sites), kept 30 days`);
  console.log(`  models    ${modelsDir}`);
  console.log(`  summaries ${config.apiKey ? `${config.model} via ${config.baseUrl}` : 'DISABLED — set PPG_API_KEY (see .env.example)'}`);
  console.log(users === 0 ? `  users     NONE — nobody can upload. Run \`bun run auth add <username>\`.` : `  users     ${users} (${auth.path()})`);
}

export default { port, fetch: app.fetch };
export { app, auth, config, store };
