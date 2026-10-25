import { describe, expect, test } from 'bun:test';
import { AuthStore } from '../src/auth.ts';
import { createApp } from '../src/index.ts';
import { ResultStore } from '../src/store.ts';
import { clock, DAY, RESULT_TTL_MS, upload } from './helpers.ts';

const CONFIG = { baseUrl: 'https://llm.invalid/v1', apiKey: '', model: 'm', temperature: 0, maxTokens: 10, timeoutMs: 1000 };

function build(extra: Record<string, unknown> = {}) {
  const c = clock();
  const store = new ResultStore({ file: ':memory:', now: c.now });
  const app = createApp({ config: CONFIG, store, auth: new AuthStore({ users: new Map() }), modelsDir: '/nonexistent', now: c.now, ...extra });
  const report = (body: unknown, headers: Record<string, string> = {}) =>
    app.request('/api/v1/reports/missing-terms', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { app, store, c, report };
}

const REPORT = { url: 'https://quickloan.com/signup', tried: ['https://quickloan.com/terms', 'https://quickloan.com/privacy', 'https://elsewhere.org/terms'] };

describe('POST /api/v1/reports/missing-terms', () => {
  test('anyone can report; it needs no token and keeps only the address and the same-site places tried', async () => {
    const { report, store } = build();
    const response = await report(REPORT);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ domain: 'quickloan.com', reports: 1, counted: true });
    const row = store['db'].query('SELECT url, tried_json FROM missing_terms').get() as { url: string; tried_json: string };
    expect(row.url).toBe('https://quickloan.com/signup');
    expect(JSON.parse(row.tried_json)).toEqual(['https://quickloan.com/terms', 'https://quickloan.com/privacy']); // the other site's link is dropped
  });

  test('a second report from the same client for the same site the same day is acknowledged but not counted', async () => {
    const { report, c } = build();
    await report(REPORT);
    const again = await report(REPORT);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ reports: 1, counted: false });
    c.advance(DAY + 1);
    expect(await (await report(REPORT)).json()).toMatchObject({ reports: 2, counted: true });
  });

  test('other clients add to the count', async () => {
    const { report } = build({ trustProxy: true });
    await report(REPORT, { 'x-forwarded-for': '1.1.1.1' });
    expect(await (await report(REPORT, { 'x-forwarded-for': '2.2.2.2' })).json()).toMatchObject({ reports: 2 });
  });

  test('refuses an address with a query string, a private host, or an extra field', async () => {
    const { report } = build();
    expect((await report({ url: 'https://quickloan.com/signup?token=abc' })).status).toBe(400);
    expect((await report({ url: 'http://localhost:3000/signup' })).status).toBe(422);
    expect((await report({ url: 'https://192.168.1.4/signup' })).status).toBe(422);
    expect((await report({ ...REPORT, note: 'hi' })).status).toBe(400);
    expect((await report({ url: 'https://quickloan.com/signup', tried: Array.from({ length: 21 }, (_, i) => `https://quickloan.com/t${i}`) })).status).toBe(400);
  });

  test('a site that already has a shared result has terms, so the report is refused', async () => {
    const { report, store } = build();
    store.insert(upload({ url: 'https://quickloan.com/terms', domain: 'quickloan.com' }), 'alice');
    const response = await report(REPORT);
    expect(response.status).toBe(409);
    expect(store.missing('quickloan.com')).toBeNull();
  });

  test('each client is limited per hour, and everyone together', async () => {
    const perClient = build({ reportPerIpPerHour: 2 });
    expect((await perClient.report({ url: 'https://a-site.com/x' })).status).toBe(201);
    expect((await perClient.report({ url: 'https://b-site.com/x' })).status).toBe(201);
    const limited = await perClient.report({ url: 'https://c-site.com/x' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();

    const everyone = build({ trustProxy: true, reportGlobalPerHour: 1 });
    expect((await everyone.report({ url: 'https://a-site.com/x' }, { 'x-forwarded-for': '1.1.1.1' })).status).toBe(201);
    expect((await everyone.report({ url: 'https://b-site.com/x' }, { 'x-forwarded-for': '2.2.2.2' })).status).toBe(429);
  });

  test('a web page on another site cannot file one for its visitor, but an extension can', async () => {
    const { report } = build();
    expect((await report(REPORT, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await report(REPORT, { origin: 'chrome-extension://abcdef' })).status).toBe(201);
  });
});

describe('reading reports', () => {
  test('a site\'s count, the list, and 404 for a site nobody reported', async () => {
    const { app, report } = build({ trustProxy: true });
    await report(REPORT, { 'x-forwarded-for': '1.1.1.1' });
    await report(REPORT, { 'x-forwarded-for': '2.2.2.2' });
    await report({ url: 'https://other-site.com/x' }, { 'x-forwarded-for': '1.1.1.1' });
    expect(await (await app.request('/api/v1/missing-terms/quickloan.com')).json()).toMatchObject({ domain: 'quickloan.com', reports: 2 });
    expect((await app.request('/api/v1/missing-terms/unknown.com')).status).toBe(404);
    expect((await app.request('/api/v1/missing-terms/not%20a%20domain')).status).toBe(400);
    const list = (await (await app.request('/api/v1/missing-terms')).json()) as { sites: { domain: string; reports: number }[] };
    expect(list.sites.map((s) => [s.domain, s.reports])).toEqual([['quickloan.com', 2], ['other-site.com', 1]]);
  });

  test('reports expire 30 days after the last one, and are purged', async () => {
    const { app, store, c, report } = build();
    await report(REPORT);
    c.advance(RESULT_TTL_MS - DAY);
    expect((await app.request('/api/v1/missing-terms/quickloan.com')).status).toBe(200);
    c.advance(2 * DAY);
    expect((await app.request('/api/v1/missing-terms/quickloan.com')).status).toBe(404);
    expect(store.purge().reports).toBe(1);
  });

  test('a new report after expiry starts the count again', async () => {
    const { store, c } = build();
    store.reportMissing('quickloan.com', 'https://quickloan.com/a', []);
    store.reportMissing('quickloan.com', 'https://quickloan.com/a', []);
    c.advance(RESULT_TTL_MS + DAY);
    expect(store.reportMissing('quickloan.com', 'https://quickloan.com/a', []).reports).toBe(1);
  });
});
