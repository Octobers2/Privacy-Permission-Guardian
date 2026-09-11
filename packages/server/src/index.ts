/**
 * The managed backend.
 *
 * Optional by design: everything it does, the extension can do itself in BYOK
 * mode. What it adds is that the API key stays out of the browser and that a
 * group testing the extension shares one cache and one key instead of each
 * setting up an account.
 *
 *   cp .env.example .env      # fill in the endpoint
 *   bun run dev
 */
import { Hono } from 'hono';
import {
  buildFormPrompt,
  buildPolicyPrompt,
  chatJson,
  finalisePolicySummary,
  FormAssessmentSchema,
  FormAssessRequestSchema,
  LlmError,
  LoginRequestSchema,
  PolicyRenderRequestSchema,
  PolicySummarizeRequestSchema,
  PolicySummaryResponseSchema,
  PROMPT_VERSION,
  type EndpointConfig,
} from '@ppg/shared';
import { AuthStore } from './auth.ts';
import { SummaryCache } from './cache.ts';
import { renderFirstPolicy, type Renderer } from './render.ts';

export interface ServerOptions {
  config: EndpointConfig;
  cache: SummaryCache;
  auth: AuthStore;
  /** Injected by the tests so they never reach a real endpoint. */
  fetchImpl?: typeof fetch;
  /** Injected by the tests so nothing in `bun test` launches a browser. */
  renderImpl?: Renderer;
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
  if (error instanceof LlmError) {
    return { status: 502 as const, body: { error: error.kind, message: error.message } };
  }
  return { status: 500 as const, body: { error: 'internal', message: String(error) } };
}

/** `username` is set by the auth middleware and read by the handlers behind it. */
type Variables = { username: string };

export function createApp({
  config,
  cache,
  auth,
  fetchImpl,
  renderImpl,
}: ServerOptions): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  const chatOptions = fetchImpl ? { fetchImpl } : {};
  const render = renderImpl ?? renderFirstPolicy;

/**
 * The extension reaches this through host permissions rather than CORS, but the
 * options page and a browser opened by hand do not, and a silent CORS failure
 * is a miserable thing to debug during a demo.
 */
  app.use('*', async (context, next) => {
    context.header('access-control-allow-origin', '*');
    context.header('access-control-allow-headers', 'content-type, authorization');
    if (context.req.method === 'OPTIONS') return context.body(null, 204);
    await next();
  });

  /**
   * Deliberately thin, and the only thing outside the login.
   *
   * It answers "is a PPG server listening here?" and nothing else. The model
   * name, the endpoint and the cache size moved to `/api/status`, because an
   * unauthenticated caller has no business knowing which model somebody else is
   * paying for.
   */
  app.get('/health', (context) =>
    context.json({ ok: true, promptVersion: PROMPT_VERSION, authRequired: true }),
  );

  /**
   * Everything else under /api needs a token.
   *
   * The backend holds an API key and a browser. Without this, anybody who can
   * reach the port has both.
   */
  app.use('/api/*', async (context, next) => {
    if (context.req.path === '/api/login') return next();

    const header = context.req.header('authorization') ?? '';
    const token = /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? '';
    const username = token ? auth.resolve(token) : null;
    if (!username) {
      return context.json(
        { error: 'unauthorized', message: '要先登入。喺插件設定頁填帳號密碼。' },
        401,
      );
    }

    context.set('username', username);
    await next();
  });

  app.post('/api/login', async (context) => {
    const parsed = LoginRequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: 'bad_request', issues: parsed.error.issues }, 400);
    const { username, password } = parsed.data;

    if (auth.isLockedOut(username)) {
      return context.json(
        { error: 'too_many_attempts', message: '登入失敗太多次，等 15 分鐘再試。' },
        429,
      );
    }

    if (!(await auth.verify(username, password))) {
      // One message for both "no such user" and "wrong password": telling them
      // apart is free help for somebody working through a list of names.
      return context.json({ error: 'unauthorized', message: '帳號或者密碼唔啱。' }, 401);
    }

    return context.json(auth.issue(username));
  });

  /** The authenticated half of "test connection": proves the credentials work. */
  app.get('/api/status', (context) =>
    context.json({
      ok: true,
      model: config.model,
      baseUrl: config.baseUrl,
      hasKey: config.apiKey !== '',
      promptVersion: PROMPT_VERSION,
      cachedSummaries: cache.count(),
      username: context.get('username'),
    }),
  );

  /**
   * Opens policy pages in a real browser and returns the first readable one.
   *
   * This is the half of the backend that is not about the API key: a policy
   * page that only exists after its own JavaScript has run cannot be read by
   * fetching it, and the browser-side fallbacks are slower and sometimes
   * blocked. `render.ts` refuses anything that does not resolve to a public
   * address.
   */
  app.post('/api/policy/render', async (context) => {
    const parsed = PolicyRenderRequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: 'bad_request', issues: parsed.error.issues }, 400);

    try {
      return context.json(await render(parsed.data.urls));
    } catch (error) {
      return context.json({ error: 'internal', message: String(error) }, 500);
    }
  });

  app.post('/api/policy/summarize', async (context) => {
    const parsed = PolicySummarizeRequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: 'bad_request', issues: parsed.error.issues }, 400);
    const request = parsed.data;

    const key = SummaryCache.keyFor(request.domain, request.contentHash, PROMPT_VERSION);
    const hit = cache.get(key);
    if (hit) return context.json(JSON.parse(hit));

    try {
      const { value } = await chatJson(
        config,
        buildPolicyPrompt(request),
        PolicySummaryResponseSchema,
        chatOptions,
      );
      const { summary } = finalisePolicySummary(value, {
        domain: request.domain,
        policyUrl: request.policyUrl,
        sourceText: request.text,
        truncated: request.truncated,
        promptVersion: PROMPT_VERSION,
        generatedAt: new Date().toISOString(),
      });
      cache.set(key, request.domain, JSON.stringify(summary));
      return context.json(summary);
    } catch (error) {
      const { status, body } = failure(error);
      return context.json(body, status);
    }
  });

  app.post('/api/form/assess', async (context) => {
    const parsed = FormAssessRequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: 'bad_request', issues: parsed.error.issues }, 400);

    try {
      const { value } = await chatJson(
        config,
        buildFormPrompt(parsed.data),
        FormAssessmentSchema,
        chatOptions,
      );
      return context.json(value);
    } catch (error) {
      const { status, body } = failure(error);
      return context.json(body, status);
    }
  });

  return app;
}

const config = envConfig();
const cache = new SummaryCache(Bun.env.PPG_CACHE_FILE);
const auth = new AuthStore();
const app = createApp({ config, cache, auth });
const port = Number(Bun.env.PPG_PORT ?? 8787);

if (import.meta.main) {
  const users = auth.count();
  console.log(`managed backend on http://localhost:${port}`);
  console.log(`  endpoint  ${config.baseUrl}`);
  console.log(`  model     ${config.model}`);
  console.log(`  api key   ${config.apiKey ? 'set' : 'MISSING — copy .env.example to .env'}`);
  console.log(`  cached    ${cache.count()} summaries`);
  console.log(
    users === 0
      ? `  users     NONE — nobody can log in. Run \`bun run auth add <username>\`.`
      : `  users     ${users} (${auth.path()})`,
  );
}

export default { port, fetch: app.fetch };
export { app, auth, config, cache };
