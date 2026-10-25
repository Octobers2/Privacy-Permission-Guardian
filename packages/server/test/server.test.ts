import { describe, expect, test } from 'bun:test';
import type { EndpointConfig } from '@ppg/shared';
import { AuthStore } from '../src/auth.ts';
import { createApp } from '../src/index.ts';
import { ResultStore } from '../src/store.ts';
import { clock, DAY, passage, RESULT_TTL_MS, upload } from './helpers.ts';

const CONFIG: EndpointConfig = { baseUrl: 'https://model.invalid/v1', apiKey: 'sk-test', model: 'test-model', temperature: 0, maxTokens: 500, timeoutMs: 2_000 };
const EXT = 'chrome-extension://abcdefghijklmnop';

const auth = new AuthStore({ users: new Map() });
const TOKEN = auth.issue('alice').token;
const AUTHED = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

function modelReturning(content: unknown, calls = { n: 0 }) {
  const impl = (async () => {
    calls.n++;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function build(extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  const c = clock();
  const store = new ResultStore({ file: ':memory:', now: c.now });
  const app = createApp({ config: CONFIG, store, auth, modelsDir: '/nonexistent', now: c.now, ...extra });
  const post = (path: string, body: unknown, headers: Record<string, string> = AUTHED) =>
    app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { app, store, c, post };
}

describe('POST /api/results', () => {
  test('stores an upload from a signed-in user and makes it publicly readable', async () => {
    const { app, post } = build();
    const response = await post('/api/results', upload());
    expect(response.status).toBe(201);
    const stored = (await response.json()) as { id: number; expiresAt: string };
    expect(Date.parse(stored.expiresAt) - Date.parse('2026-10-14T00:00:00Z')).toBe(RESULT_TTL_MS);

    const read = await app.request('/api/v1/results/' + stored.id); // no token
    expect(read.status).toBe(200);
    expect(((await read.json()) as { unfairCount: number }).unfairCount).toBe(2);
  });

  test('needs a token', async () => {
    const { post } = build();
    expect((await post('/api/results', upload(), { 'content-type': 'application/json' })).status).toBe(401);
  });

  test('rejects anything that is not exactly an upload', async () => {
    const { post } = build();
    expect((await post('/api/results', { ...upload(), pageText: 'everything on the page' })).status).toBe(400);
    expect((await post('/api/results', upload({ url: 'https://example.com/terms?session=abc' }))).status).toBe(400);
    expect((await post('/api/results', 'not json')).status).toBe(400);
  });

  test('refuses private and intranet addresses, so they can never reach the public database', async () => {
    const { post } = build();
    for (const host of ['localhost', 'wiki.internal', '192.168.0.4', 'nas.local']) {
      const response = await post('/api/results', upload({ url: `https://${host}/terms`, domain: host }));
      expect([400, 422]).toContain(response.status);
      expect(response.status).not.toBe(201);
    }
  });

  test('refuses a domain that does not belong to the URL', async () => {
    const { post } = build();
    const response = await post('/api/results', upload({ domain: 'evil.com' }));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toBe('domain_mismatch');
  });

  test('refuses passages that look like personal data and says which, without echoing them', async () => {
    const { post, store } = build();
    const response = await post('/api/results', upload({ passages: [passage(1, 'arbitration'), passage(2, 'arbitration', 'Contact jane.doe@gmail.com about this.')] }));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({ error: 'pii_blocked', indexes: [2] });
    expect(JSON.stringify(body)).not.toContain('jane');
    expect(store.stats().results).toBe(0);
  });

  test('refuses a money clause that looks like personal data', async () => {
    const { post, store } = build();
    const response = await post('/api/results', upload({ money: [{ index: 7, kind: 'no_refund', text: 'Refunds go to jane.doe@gmail.com only.' }] }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'pii_blocked', indexes: [7] });
    expect(store.stats().results).toBe(0);
  });

  test('stores money clauses and serves them back', async () => {
    const { app, post } = build();
    const money = [{ index: 2, kind: 'auto_renewal' as const, text: 'The plan renews automatically.' }];
    expect((await post('/api/results', upload({ money }))).status).toBe(201);
    const body = (await (await app.request('/api/v1/lookup?url=https://example.com/terms')).json()) as { result: { money: unknown[] } };
    expect(body.result.money).toEqual(money);
  });

  test('accepts company contact details inside a clause', async () => {
    const { post } = build();
    const response = await post('/api/results', upload({ passages: [passage(1, 'arbitration', 'To opt out, write to legal@example.com or call +1 415 555 0132.')] }));
    expect(response.status).toBe(201);
  });

  test('refuses a body over 1 MB', async () => {
    const { app } = build();
    const response = await app.request('/api/results', { method: 'POST', headers: AUTHED, body: 'x'.repeat(1024 * 1024 + 10) });
    expect(response.status).toBe(413);
  });
});

describe('public read API', () => {
  async function seeded() {
    const ctx = build();
    await ctx.post('/api/results', upload({ textHash: '1'.repeat(64) }));
    ctx.c.advance(DAY);
    await ctx.post('/api/results', upload({ textHash: '2'.repeat(64), passages: [passage(7, 'jurisdiction')] }));
    await ctx.post('/api/results', upload({ url: 'https://example.com/privacy', passages: [] }));
    return ctx;
  }

  test('lookup returns the current result and whether the policy text changed', async () => {
    const { app } = await seeded();
    const same = await (await app.request('/api/v1/lookup?url=https://example.com/terms&hash=' + '2'.repeat(64))).json();
    expect(same.sameText).toBe(true);
    expect(same.result.unfairCount).toBe(1);
    const changed = await (await app.request('/api/v1/lookup?url=https://example.com/terms&hash=' + '9'.repeat(64))).json();
    expect(changed.sameText).toBe(false);
    expect((await (await app.request('/api/v1/lookup?url=https://example.com/terms')).json()).sameText).toBeNull();
  });

  test('lookup ignores the query string and fragment of the requested url', async () => {
    const { app } = await seeded();
    expect((await app.request('/api/v1/lookup?url=' + encodeURIComponent('https://example.com/terms?utm=1#top'))).status).toBe(200);
  });

  test('lookup of something never analysed, or on a private host, is a clear error', async () => {
    const { app } = await seeded();
    expect((await app.request('/api/v1/lookup?url=https://example.com/unknown')).status).toBe(404);
    expect((await app.request('/api/v1/lookup?url=http://localhost/terms')).status).toBe(400);
    expect((await app.request('/api/v1/lookup')).status).toBe(400);
  });

  test('a site lists the current result of each of its policies', async () => {
    const { app } = await seeded();
    const body = await (await app.request('/api/v1/sites/Example.com')).json();
    expect(body.domain).toBe('example.com');
    expect(body.documents.map((d: { url: string }) => d.url)).toEqual(['https://example.com/privacy', 'https://example.com/terms']);
    expect((await app.request('/api/v1/sites/unknown.org')).status).toBe(404);
    expect((await app.request('/api/v1/sites/bad%20name')).status).toBe(400);
  });

  test('history shows older versions and marks the current one', async () => {
    const { app } = await seeded();
    const body = await (await app.request('/api/v1/history?url=https://example.com/terms')).json();
    expect(body.versions.map((v: { current: boolean }) => v.current)).toEqual([true, false]);
  });

  test('recent, rankings and stats', async () => {
    const { app } = await seeded();
    const recent = await (await app.request('/api/v1/recent?limit=1')).json();
    expect(recent.results).toHaveLength(1);
    expect(recent.results[0].passages).toBeUndefined();
    const rankings = await (await app.request('/api/v1/rankings')).json();
    expect(rankings.rows[0]).toMatchObject({ domain: 'example.com', documents: 2, unfair: 1 });
    expect(await (await app.request('/api/v1/stats')).json()).toMatchObject({ urls: 2, domains: 1 });
  });

  test('an expired result is gone from every route', async () => {
    const { app, c } = await seeded();
    c.advance(RESULT_TTL_MS + DAY);
    expect((await app.request('/api/v1/lookup?url=https://example.com/terms')).status).toBe(404);
    expect((await app.request('/api/v1/sites/example.com')).status).toBe(404);
    expect((await (await app.request('/api/v1/recent')).json()).results).toEqual([]);
  });

  test('public responses are cacheable and open to any origin', async () => {
    const { app } = await seeded();
    const r = await app.request('/api/v1/stats', { headers: { origin: 'https://query.example.org' } });
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('cache-control')).toBe('public, max-age=60');
  });
});

describe('CORS on the write routes', () => {
  test('a web page on another site cannot call them; an extension can', async () => {
    const { app } = build();
    const call = (origin: string) => app.request('/api/results', { method: 'POST', headers: { ...AUTHED, origin }, body: JSON.stringify(upload()) });
    expect((await call('https://evil.example.com')).status).toBe(403);
    const ok = await call(EXT);
    expect(ok.status).toBe(201);
    expect(ok.headers.get('access-control-allow-origin')).toBe(EXT);
  });

  test('configured origins are allowed too', async () => {
    const { app } = build({ allowedOrigins: ['https://admin.example.org'] });
    const r = await app.request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://admin.example.org' }, body: '{}' });
    expect(r.status).toBe(400); // got past CORS, failed validation
  });

  test('preflight for the public API is open, for the write routes it is not', async () => {
    const { app } = build();
    expect((await app.request('/api/v1/recent', { method: 'OPTIONS', headers: { origin: 'https://query.example.org' } })).status).toBe(204);
    expect((await app.request('/api/results', { method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } })).status).toBe(403);
  });
});

describe('POST /api/summary', () => {
  const REQUEST = {
    url: 'https://example.com/terms',
    domain: 'example.com',
    textHash: 'b'.repeat(64),
    passages: [
      { category: 'arbitration', text: 'Any dispute will be resolved by binding arbitration, and you waive any class action.' },
      { category: 'unilateral_termination', text: 'We may terminate your account at any time without notice.' },
    ],
  };
  const GOOD = { points: [{ category: 'arbitration', severity: 'high', title: 'You give up the right to sue', detail: 'Disputes go to a private arbitrator.', quote: 'binding arbitration, and you waive any class action' }] };
  const FROM = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' };

  test('summarises with checked quotes, and needs no sign-in', async () => {
    const { impl } = modelReturning(GOOD);
    const { post } = build({ fetchImpl: impl, trustProxy: true });
    const response = await post('/api/summary', REQUEST, FROM);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.points).toHaveLength(1);
    expect(body.riskScore).toBe(25);
    expect(body.cached).toBe(false);
  });

  test('a repeat is served from the cache without calling the model or spending rate limit', async () => {
    const { impl, calls } = modelReturning(GOOD);
    const { post } = build({ fetchImpl: impl, trustProxy: true, summaryPerIpPerHour: 1 });
    await post('/api/summary', REQUEST, FROM);
    const again = await post('/api/summary', REQUEST, FROM);
    expect(again.status).toBe(200);
    expect((await again.json()).cached).toBe(true);
    expect(calls.n).toBe(1);
  });

  test('invented passages filed under a real policy hash do not poison its summary', async () => {
    const { impl, calls } = modelReturning(GOOD);
    const { post } = build({ fetchImpl: impl, trustProxy: true });
    await post('/api/summary', REQUEST, FROM);
    const forged = { ...REQUEST, passages: [{ category: 'arbitration', text: 'binding arbitration, and you waive any class action — also we sell your data.' }] };
    const response = await post('/api/summary', forged, { ...FROM, 'x-forwarded-for': '203.0.113.8' });
    expect((await response.json()).cached).toBe(false);
    expect(calls.n).toBe(2);
  });

  test('limits each client, and says when to come back', async () => {
    const { impl } = modelReturning(GOOD);
    const { post } = build({ fetchImpl: impl, trustProxy: true, summaryPerIpPerHour: 2 });
    const distinct = (i: number) => ({ ...REQUEST, textHash: String(i).repeat(64).slice(0, 64) });
    expect((await post('/api/summary', distinct(1), FROM)).status).toBe(200);
    expect((await post('/api/summary', distinct(2), FROM)).status).toBe(200);
    const limited = await post('/api/summary', distinct(3), FROM);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await post('/api/summary', distinct(3), { ...FROM, 'x-forwarded-for': '198.51.100.9' })).status).toBe(200);
  });

  test('has a global ceiling too', async () => {
    const { impl } = modelReturning(GOOD);
    const { post } = build({ fetchImpl: impl, trustProxy: true, summaryGlobalPerHour: 1 });
    expect((await post('/api/summary', { ...REQUEST, textHash: '1'.repeat(64) }, FROM)).status).toBe(200);
    expect((await post('/api/summary', { ...REQUEST, textHash: '2'.repeat(64) }, { ...FROM, 'x-forwarded-for': '198.51.100.9' })).status).toBe(429);
  });

  test('refuses personal data and non-public pages before spending anything', async () => {
    const { impl, calls } = modelReturning(GOOD);
    const { post } = build({ fetchImpl: impl, trustProxy: true });
    const pii = { ...REQUEST, passages: [{ category: 'arbitration', text: 'Send it to jane.doe@gmail.com.' }] };
    expect((await post('/api/summary', pii, FROM)).status).toBe(422);
    expect((await post('/api/summary', { ...REQUEST, url: 'http://localhost/terms' }, FROM)).status).toBe(422);
    expect(calls.n).toBe(0);
  });

  test('discards a summary whose quotes are not in the passages', async () => {
    const { impl } = modelReturning({ points: [{ ...GOOD.points[0], quote: 'We will sell your kidneys' }] });
    const { post, store } = build({ fetchImpl: impl, trustProxy: true });
    const response = await post('/api/summary', REQUEST, FROM);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toBe('unverified');
    expect(store.stats().summaries).toBe(0);
  });

  test('says so when no summary model is configured', async () => {
    const { post } = build({ config: { ...CONFIG, apiKey: '' } });
    expect((await post('/api/summary', REQUEST, FROM)).status).toBe(503);
  });

  test('summaries expire with everything else', async () => {
    const { impl, calls } = modelReturning(GOOD);
    const { post, c } = build({ fetchImpl: impl, trustProxy: true });
    await post('/api/summary', REQUEST, FROM);
    c.advance(RESULT_TTL_MS + 1);
    await post('/api/summary', REQUEST, FROM);
    expect(calls.n).toBe(2);
  });
});

describe('/models', () => {
  test('is served without a sign-in and answers a missing file with a clear 404', async () => {
    const { app } = build();
    const r = await app.request('/models/manifest.json');
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toBe('not_found');
  });
});

describe('/health', () => {
  test('is open and says nothing about the deployment', async () => {
    const { app } = build();
    const body = await (await app.request('/health')).json();
    expect(body).toEqual({ ok: true, ttlDays: 30, authRequired: true });
  });
});

describe('similar clauses API', () => {
  const ARB = 'Any dispute arising out of these terms will be resolved exclusively by binding arbitration and you waive any right to a class action.';
  function seeded(extra: Parameters<typeof build>[0] = {}) {
    const b = build(extra);
    b.store.insert(upload({ url: 'https://one.com/terms', domain: 'one.com', passages: [passage(1, 'arbitration', ARB)] }), 'a');
    const mine = b.store.insert(upload({ url: 'https://mine.com/terms', domain: 'mine.com', passages: [passage(5, 'arbitration', ARB)] }), 'a');
    return { ...b, mine };
  }
  const ask = (app: ReturnType<typeof build>['app'], body: unknown) => app.request('/api/v1/similar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  test('for a stored result: public, no token, and it leaves out its own site', async () => {
    const { app, mine } = seeded();
    const body = (await (await app.request(`/api/v1/results/${mine.id}/similar`)).json()) as { items: { index: number; sites: number; examples: { domain: string }[] }[] };
    expect(body.items).toEqual([expect.objectContaining({ index: 5, sites: 1, examples: [expect.objectContaining({ domain: 'one.com' })] })]);
    expect((await app.request('/api/v1/results/9999/similar')).status).toBe(404);
  });

  test('for clauses the caller sends: found, and nothing is stored', async () => {
    const { app, store } = seeded();
    const before = store.stats();
    const response = await ask(app, { passages: [{ index: 3, category: 'arbitration', text: ARB }] });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { items: { index: number; sites: number }[] }).items.map((i) => [i.index, i.sites])).toEqual([[3, 2]]);
    expect(store.stats()).toEqual(before);
  });

  test('leaves out the site the clauses came from', async () => {
    const { app } = seeded();
    const body = (await (await ask(app, { domain: 'one.com', passages: [{ index: 3, category: 'arbitration', text: ARB }] })).json()) as { items: { sites: number; examples: { domain: string }[] }[] };
    expect(body.items[0]!.examples.map((e) => e.domain)).toEqual(['mine.com']);
  });

  test('refuses personal-looking sentences without echoing them, and bad shapes', async () => {
    const { app } = seeded();
    const personal = await ask(app, { passages: [{ index: 4, category: 'arbitration', text: 'Write to jane.doe@gmail.com about arbitration.' }] });
    expect(personal.status).toBe(422);
    expect(JSON.stringify(await personal.json())).not.toContain('jane');
    expect((await ask(app, { passages: [] })).status).toBe(400);
    expect((await ask(app, { passages: [{ index: 1, category: 'other', text: 'x' }] })).status).toBe(400);
    expect((await ask(app, { passages: Array.from({ length: 51 }, (_, i) => ({ index: i, category: 'arbitration', text: ARB })) })).status).toBe(400);
  });

  test('is limited per client', async () => {
    const { app } = seeded({ similarPerIpPerHour: 1 });
    const body = { passages: [{ index: 1, category: 'arbitration', text: ARB }] };
    expect((await ask(app, body)).status).toBe(200);
    expect((await ask(app, body)).status).toBe(429);
  });
});
