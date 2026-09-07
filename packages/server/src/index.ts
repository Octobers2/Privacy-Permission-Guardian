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
  PolicySummarizeRequestSchema,
  PolicySummaryResponseSchema,
  PROMPT_VERSION,
  type EndpointConfig,
} from '@ppg/shared';
import { SummaryCache } from './cache.ts';

export interface ServerOptions {
  config: EndpointConfig;
  cache: SummaryCache;
  /** Injected by the tests so they never reach a real endpoint. */
  fetchImpl?: typeof fetch;
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

export function createApp({ config, cache, fetchImpl }: ServerOptions): Hono {
  const app = new Hono();
  const chatOptions = fetchImpl ? { fetchImpl } : {};

/**
 * The extension reaches this through host permissions rather than CORS, but the
 * options page and a browser opened by hand do not, and a silent CORS failure
 * is a miserable thing to debug during a demo.
 */
  app.use('*', async (context, next) => {
    context.header('access-control-allow-origin', '*');
    context.header('access-control-allow-headers', 'content-type');
    if (context.req.method === 'OPTIONS') return context.body(null, 204);
    await next();
  });

  app.get('/health', (context) =>
    context.json({
      ok: true,
      model: config.model,
      baseUrl: config.baseUrl,
      hasKey: config.apiKey !== '',
      promptVersion: PROMPT_VERSION,
      cachedSummaries: cache.count(),
    }),
  );

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
const app = createApp({ config, cache });
const port = Number(Bun.env.PPG_PORT ?? 8787);

if (import.meta.main) {
  console.log(`managed backend on http://localhost:${port}`);
  console.log(`  endpoint  ${config.baseUrl}`);
  console.log(`  model     ${config.model}`);
  console.log(`  api key   ${config.apiKey ? 'set' : 'MISSING — copy .env.example to .env'}`);
  console.log(`  cached    ${cache.count()} summaries`);
}

export default { port, fetch: app.fetch };
export { app, config, cache };
