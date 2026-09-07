import { describe, expect, test } from 'bun:test';
import type { EndpointConfig } from '@ppg/shared';
import { SummaryCache } from '../src/cache.ts';
import { createApp } from '../src/index.ts';

const CONFIG: EndpointConfig = {
  baseUrl: 'https://model.invalid/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  temperature: 0,
  maxTokens: 500,
  timeoutMs: 2_000,
};

const SOURCE = 'We share your personal information with advertising partners. We keep it forever.';

function modelReturning(points: unknown[], calls = { n: 0 }) {
  const impl = (async () => {
    calls.n++;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ points }) } }] }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function summariseRequest(overrides: Record<string, unknown> = {}) {
  return {
    domain: 'example.com',
    policyUrl: 'https://example.com/privacy',
    text: SOURCE,
    truncated: false,
    contentHash: 'a'.repeat(64),
    ...overrides,
  };
}

const REAL_POINT = {
  category: 'third_party_sharing',
  severity: 'high',
  title: '分享畀廣告商',
  detail: '你嘅資料會交畀廣告夥伴。',
  quote: 'We share your personal information with advertising partners.',
};

function appWith(points: unknown[]) {
  const { impl, calls } = modelReturning(points);
  const cache = new SummaryCache(':memory:');
  return { app: createApp({ config: CONFIG, cache, fetchImpl: impl }), calls, cache };
}

describe('GET /health', () => {
  test('reports the configuration without leaking the key', async () => {
    const cache = new SummaryCache(':memory:');
    const response = await createApp({ config: CONFIG, cache }).request('/health');
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.model).toBe('test-model');
    expect(body.hasKey).toBe(true);
    expect(JSON.stringify(body)).not.toContain('sk-test');
  });
});

describe('POST /api/policy/summarize', () => {
  test('rejects a request that does not match the contract', async () => {
    const { app } = appWith([REAL_POINT]);
    const response = await app.request('/api/policy/summarize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'example.com' }),
    });
    expect(response.status).toBe(400);
  });

  test('summarises and verifies quotes against the submitted text', async () => {
    const { app } = appWith([
      REAL_POINT,
      { ...REAL_POINT, category: 'retention', severity: 'medium', quote: 'Invented clause.' },
    ]);
    const response = await app.request('/api/policy/summarize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summariseRequest()),
    });
    const summary = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(summary.points).toHaveLength(1);
    expect(summary.droppedPoints).toBe(1);
    expect(summary.riskScore).toBe(25);
  });

  test('serves a repeat request from the cache without calling the model again', async () => {
    // This is the entire reason the managed mode exists: a group testing the
    // same site should spend one model call between them.
    const { app, calls } = appWith([REAL_POINT]);
    const send = () =>
      app.request('/api/policy/summarize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(summariseRequest()),
      });

    await send();
    await send();
    expect(calls.n).toBe(1);
  });

  test('a different document hash misses the cache', async () => {
    const { app, calls } = appWith([REAL_POINT]);
    for (const contentHash of ['a'.repeat(64), 'b'.repeat(64)]) {
      await app.request('/api/policy/summarize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(summariseRequest({ contentHash })),
      });
    }
    expect(calls.n).toBe(2);
  });

  test('reports a model failure as a bad gateway rather than a server crash', async () => {
    const impl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const app = createApp({ config: CONFIG, cache: new SummaryCache(':memory:'), fetchImpl: impl });
    const response = await app.request('/api/policy/summarize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summariseRequest()),
    });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe('auth');
  });
});

describe('POST /api/form/assess', () => {
  const request = {
    page: { url: 'https://a.test/x', hostname: 'a.test', isHttps: true, title: 'x' },
    fields: [
      { type: 'text', name: 'cc', id: '', autocomplete: 'cc-number', placeholder: '', label: 'Card', required: true },
    ],
    actionOrigin: null,
    ruleScore: 40,
    ruleHits: ['credit_card_fields'],
    textSnippet: 'pay now',
  };

  test('returns a validated assessment', async () => {
    const assessment = {
      verdict: 'caution', confidence: 0.6, reasons: ['要求信用卡'], advice: '核實網址', checklist: [],
    };
    const impl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(assessment) } }] }), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const app = createApp({ config: CONFIG, cache: new SummaryCache(':memory:'), fetchImpl: impl });
    const response = await app.request('/api/form/assess', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(await response.json()).toEqual(assessment);
  });

  test('refuses a request carrying field values', async () => {
    // The schema is strict, so an extension build that started sending values
    // would be rejected here too, not only in the browser.
    const { app } = appWith([]);
    const response = await app.request('/api/form/assess', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...request,
        fields: [{ ...request.fields[0], value: '4111111111111111' }],
      }),
    });
    expect(response.status).toBe(400);
  });
});
