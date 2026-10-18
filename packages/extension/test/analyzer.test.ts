import { describe, expect, test } from 'bun:test';
import { OTHER_INDEX, TOS_CATEGORIES } from '@ppg/shared';
import { analyse, MAX_SENTENCES, type Deps, type EngineLike, type Job } from '../src/analysis/analyzer.ts';
import type { AnalysisState } from '../src/analysis/state.ts';

const DOC = [
  'You may not use the service for any unlawful purpose at all.',
  'We may terminate your account at any time without any prior notice to you.',
  'Any dispute will be resolved by binding arbitration and you waive class actions.',
  'We will do our best to keep the service running smoothly for everyone.',
  'Contact our support team if you have a question about your invoice.',
].join('\n');

/** Probabilities that put almost all mass on `category`. */
const probs = (category: (typeof TOS_CATEGORIES)[number]) => TOS_CATEGORIES.map((c) => (c === category ? 0.9 : 0.1 / 8));

function fakeEngine(over: Partial<EngineLike> = {}): EngineLike & { classified: string[] } {
  const classified: string[] = [];
  return {
    classified,
    model: { id: 'ppg-fast', version: '2026-10-14', tasks: { tos: { promptVersion: 'letters-v1', temperature: 1 }, pii: { promptVersion: 'pii-v1', threshold: 0.5 } } },
    async classify(text) {
      classified.push(text);
      const category = /terminate/.test(text) ? 'unilateral_termination' : /arbitration/.test(text) ? 'arbitration' : 'other';
      return { probs: probs(category), category };
    },
    async askPersonal() {
      return { personal: false, probability: 0.02 };
    },
    ...over,
  };
}

interface Call { url: string; method: string; headers: Record<string, string>; body: any }
function fakeNetwork(handlers: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = { url, method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const key = Object.keys(handlers).find((k) => url.includes(k));
    if (!key) return new Response('{}', { status: 404 });
    return handlers[key]!(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function job(over: Partial<Job> = {}, prefs: Partial<Job['prefs']> = {}): Job {
  return {
    id: 1, tabId: 7, policyUrl: 'https://example.com/terms', domain: 'example.com', text: DOC, truncated: false,
    prefs: { serverUrl: 'https://ppg.example.org', modelId: 'ppg-fast', summary: 'off', byok: { baseUrl: '', apiKey: '', model: '' }, token: null, ...prefs },
    ...over,
  };
}

function deps(over: Partial<Deps> & { engine?: EngineLike; recovered?: EngineLike; net?: ReturnType<typeof fakeNetwork> } = {}) {
  const states: AnalysisState[] = [];
  const engine = over.engine ?? fakeEngine();
  let loads = 0;
  let t = 0;
  const d: Deps = {
    loadEngine: async () => (loads++, engine),
    recoverEngine: async () => (loads++, over.recovered ?? engine),
    fetch: over.net?.impl ?? fakeNetwork({}).impl,
    now: () => (t += 1_000), // each call advances a second, so progress throttling never swallows an update
    emit: (s) => states.push(s),
    isCurrent: () => true,
    ...over,
  };
  return { d, states, engine, loads: () => loads };
}

const ready = (s: AnalysisState) => {
  if (s.status !== 'ready') throw new Error(`expected ready, got ${JSON.stringify(s).slice(0, 200)}`);
  return s.result;
};

describe('analysing a policy on this device', () => {
  test('classifies sentence by sentence and keeps the flagged ones, in their original wording', async () => {
    const { d, engine } = deps();
    const result = ready(await analyse(job(), d));
    expect(result.source).toBe('this-device');
    expect(result.passageCount).toBe(5);
    expect(result.flagged.map((p) => p.category)).toEqual(['unilateral_termination', 'arbitration']);
    expect(result.flagged[0]!.text).toBe('We may terminate your account at any time without any prior notice to you.');
    expect(result.categories).toEqual({ unilateral_termination: 1, arbitration: 1 });
    // the model was shown the corpus-style text, not the page's prose
    expect((engine as ReturnType<typeof fakeEngine>).classified[1]).toBe('we may terminate your account at any time without any prior notice to you .');
  });

  test('reports progress while it works, and the flagged clauses so far', async () => {
    const { d, states } = deps();
    await analyse(job(), d);
    const classifying = states.filter((s) => s.status === 'working' && s.stage === 'classifying') as Extract<AnalysisState, { status: 'working' }>[];
    expect(classifying.at(-1)).toMatchObject({ done: 5, total: 5 });
    expect(classifying.at(-1)!.flagged).toHaveLength(2);
  });

  test('does not read more than the sentence cap', async () => {
    const long = Array.from({ length: MAX_SENTENCES + 50 }, (_, i) => `This is sentence number ${i} of a very long policy document.`).join('\n');
    const { d, engine } = deps();
    const result = ready(await analyse(job({ text: long }), d));
    expect((engine as ReturnType<typeof fakeEngine>).classified).toHaveLength(MAX_SENTENCES);
    expect(result.truncated).toBe(true);
  });

  test('a page with no readable sentences is "unavailable", not an error', async () => {
    const { d } = deps();
    expect((await analyse(job({ text: 'Home | Contact | Help' }), d)).status).toBe('unavailable');
  });
});

describe('the saved result', () => {
  const saved = (sameText: boolean) => ({
    result: { id: 9, url: 'https://example.com/terms', domain: 'example.com', textHash: 'a'.repeat(64), model: { id: 'ppg-fast', version: 'v' }, promptVersion: 'letters-v1',
      createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-31T00:00:00.000Z', passageCount: 40, unfairCount: 1, fairCount: 39, categories: { arbitration: 1 },
      passages: [{ index: 3, text: 'Any dispute will be resolved by binding arbitration.', category: 'arbitration', probs: probs('arbitration') }], current: true },
    sameText,
  });

  test('an unchanged policy is served from the public cache without loading the model', async () => {
    const net = fakeNetwork({ '/api/v1/lookup': () => json(saved(true)) });
    const { d, loads } = deps({ net });
    const result = ready(await analyse(job(), d));
    expect(result.source).toBe('community');
    expect(result.flagged).toHaveLength(1);
    expect(result.sharing).toEqual({ status: 'already-public' });
    expect(loads()).toBe(0);
    expect(net.calls[0]!.url).toContain('hash=');
  });

  test('a changed policy is read again', async () => {
    const net = fakeNetwork({ '/api/v1/lookup': () => json(saved(false)) });
    const { d, loads } = deps({ net });
    expect(ready(await analyse(job(), d)).source).toBe('this-device');
    expect(loads()).toBe(1);
  });

  test('a server that is down never stops the on-device analysis', async () => {
    const net = { calls: [], impl: (async () => { throw new TypeError('network down'); }) as unknown as typeof fetch };
    const { d } = deps({ net });
    expect(ready(await analyse(job(), d)).flagged).toHaveLength(2);
  });
});

describe('the personal-data gate', () => {
  const PERSONAL_TEXT = 'My account. Signed in as Jane Doe (jane.doe@gmail.com). We may terminate your account at any time without notice to anyone.';

  test('the rules stop a personal page before any request is made', async () => {
    const net = fakeNetwork({});
    const { d } = deps({ net });
    const result = ready(await analyse(job({ policyUrl: 'https://shop.example.net/account/orders', text: PERSONAL_TEXT }, { token: 'tok', summary: 'server' }), d));
    expect(net.calls).toHaveLength(0); // no lookup, no upload, no summary
    expect(result.sharing.status).toBe('blocked');
    expect(result.personal?.reasons.join(' ')).toMatch(/personal email/);
    expect(result.flagged).toHaveLength(1); // the user still gets the on-device answer
  });

  test('the model can stop a page the rules cannot', async () => {
    const net = fakeNetwork({ '/api/v1/lookup': () => json({}, 404) });
    const engine = fakeEngine({ askPersonal: async () => ({ personal: true, probability: 0.97 }) });
    const { d } = deps({ net, engine });
    const result = ready(await analyse(job({}, { token: 'tok', summary: 'server' }), d));
    expect(result.sharing.status).toBe('blocked');
    expect(result.summary).toBeNull();
    expect(net.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  test('a model without the personal-data question skips that check', async () => {
    const engine = fakeEngine();
    delete (engine.model.tasks as { pii?: unknown }).pii;
    const { d } = deps({ engine });
    expect(ready(await analyse(job(), d)).personal).toBeNull();
  });
});

describe('sharing', () => {
  const okLookup = { '/api/v1/lookup': () => json({}, 404) };

  test('a signed-in contributor uploads only the flagged clauses, with their token', async () => {
    const net = fakeNetwork({ ...okLookup, '/api/results': () => json({ id: 42 }, 201) });
    const { d } = deps({ net });
    const result = ready(await analyse(job({}, { token: 'secret-token' }), d));
    expect(result.sharing).toEqual({ status: 'shared', id: 42 });
    const post = net.calls.find((c) => c.method === 'POST')!;
    expect(post.headers.authorization).toBe('Bearer secret-token');
    expect(post.body).toMatchObject({ url: 'https://example.com/terms', domain: 'example.com', passageCount: 5, promptVersion: 'letters-v1' });
    expect(post.body.passages.map((p: { category: string }) => p.category)).toEqual(['unilateral_termination', 'arbitration']);
    expect(JSON.stringify(post.body)).not.toContain('invoice'); // the fair sentences are not in the upload
    expect(post.body.textHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('without an account nothing is uploaded', async () => {
    const net = fakeNetwork(okLookup);
    const { d } = deps({ net });
    expect(ready(await analyse(job(), d)).sharing).toEqual({ status: 'not-signed-in' });
    expect(net.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  test('a personal email inside a clause blocks the whole page, so nothing is uploaded (the per-clause filter is a second line behind this)', async () => {
    const net = fakeNetwork({ ...okLookup, '/api/results': () => json({ id: 1 }, 201) });
    const text = DOC + '\nWe may terminate your account if jane.doe@gmail.com reports any abuse of the service.';
    const { d } = deps({ net });
    const result = ready(await analyse(job({ text }, { token: 't' }), d));
    expect(result.sharing.status).toBe('blocked');
    expect(net.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(JSON.stringify(net.calls)).not.toContain('jane.doe');
  });

  test('an expired sign-in is explained, and the on-device result still stands', async () => {
    const net = fakeNetwork({ ...okLookup, '/api/results': () => json({ error: 'unauthorized' }, 401) });
    const { d } = deps({ net });
    const result = ready(await analyse(job({}, { token: 'old' }), d));
    expect(result.sharing).toMatchObject({ status: 'failed', message: expect.stringContaining('sign-in has expired') });
    expect(result.flagged).toHaveLength(2);
  });
});

describe('summaries', () => {
  const okLookup = { '/api/v1/lookup': () => json({}, 404) };
  const SUMMARY = { domain: 'example.com', url: 'https://example.com/terms', textHash: 'a'.repeat(64), riskScore: 25, droppedPoints: 0, promptVersion: 'summary-v1', model: 'm', generatedAt: '2026-10-14T00:00:00.000Z', cached: false,
    points: [{ category: 'arbitration', severity: 'high', title: 't', detail: 'd', quote: 'binding arbitration' }] };

  test('off by default: no request', async () => {
    const net = fakeNetwork(okLookup);
    const { d } = deps({ net });
    const result = ready(await analyse(job(), d));
    expect(result.summary).toBeNull();
    expect(net.calls.some((c) => c.url.includes('/api/summary'))).toBe(false);
  });

  test('from the server: sends only category and text of the flagged clauses', async () => {
    const net = fakeNetwork({ ...okLookup, '/api/summary': () => json(SUMMARY) });
    const { d } = deps({ net });
    const result = ready(await analyse(job({}, { summary: 'server' }), d));
    expect(result.summary?.riskScore).toBe(25);
    const body = net.calls.find((c) => c.url.includes('/api/summary'))!.body;
    expect(Object.keys(body).sort()).toEqual(['domain', 'passages', 'textHash', 'url']);
    expect(body.passages.every((p: object) => Object.keys(p).sort().join() === 'category,text')).toBe(true);
  });

  test('a summary that fails does not take the result down with it', async () => {
    const net = fakeNetwork({ ...okLookup, '/api/summary': () => json({ error: 'rate_limited' }, 429) });
    const { d } = deps({ net });
    const result = ready(await analyse(job({}, { summary: 'server' }), d));
    expect(result.summary).toBeNull();
    expect(result.summaryError).toMatch(/Too many summary requests/);
    expect(result.flagged).toHaveLength(2);
  });

  test('your own endpoint: the clauses go there and nowhere else, and quotes are checked', async () => {
    const net = fakeNetwork({
      ...okLookup,
      'llm.example.org': () => json({ choices: [{ message: { content: JSON.stringify({ points: [{ category: 'arbitration', severity: 'high', title: 't', detail: 'd', quote: 'binding arbitration and you waive class actions' }] }) } }] }),
    });
    const { d } = deps({ net });
    const result = ready(await analyse(job({}, { summary: 'byok', byok: { baseUrl: 'https://llm.example.org/v1', apiKey: 'sk', model: 'm' } }), d));
    expect(result.summary?.points).toHaveLength(1);
    expect(net.calls.some((c) => c.url.includes('ppg.example.org/api/summary'))).toBe(false);
  });

  test('no summary is requested when nothing was flagged', async () => {
    const net = fakeNetwork(okLookup);
    const { d } = deps({ net });
    await analyse(job({ text: 'We keep things simple here and always will for you.\nSupport is available by email on weekdays at any hour.' }, { summary: 'server' }), d);
    expect(net.calls.some((c) => c.url.includes('/api/summary'))).toBe(false);
  });
});

describe('a lost GPU device', () => {
  const dies = (message: string, times = 1) => {
    const e = fakeEngine();
    const original = e.classify.bind(e);
    let left = times;
    e.classify = async (t) => {
      if (/terminate/.test(t) && left-- > 0) throw new Error(message);
      return original(t);
    };
    return e;
  };

  test('is survived by loading a fresh engine and retrying that sentence', async () => {
    const recovered = fakeEngine();
    const { d, loads } = deps({ engine: dies("Failed to execute 'mapAsync' on 'GPUBuffer': [Device] is lost."), recovered });
    const result = ready(await analyse(job(), d));
    expect(result.flagged.map((p) => p.category)).toEqual(['unilateral_termination', 'arbitration']); // nothing skipped
    expect(loads()).toBe(2); // the first load plus one recovery
  });

  test('is tried once only: a second failure is reported, not retried forever', async () => {
    const { d, loads } = deps({ engine: dies('GPU device lost', 5), recovered: dies('GPU device lost', 5) });
    const final = await analyse(job(), d);
    expect(final.status).toBe('error');
    expect(loads()).toBe(2);
  });

  test('an error that is not about the engine is not retried', async () => {
    const { d, loads } = deps({ engine: dies('Unexpected token in prompt') });
    expect((await analyse(job(), d)).status).toBe('error');
    expect(loads()).toBe(1);
  });

  test('works for the personal-data question too', async () => {
    let calls = 0;
    const flaky = fakeEngine({ askPersonal: async () => { if (calls++ === 0) throw new Error('Model not loaded before trying to complete'); return { personal: false, probability: 0.1 }; } });
    const { d } = deps({ engine: flaky, recovered: flaky });
    expect(ready(await analyse(job(), d)).personal).toBeNull();
  });
});

describe('cancellation', () => {
  test('a newer job supersedes this one: it stops quietly and uploads nothing', async () => {
    const net = fakeNetwork({ '/api/v1/lookup': () => json({}, 404), '/api/results': () => json({ id: 1 }, 201) });
    let current = true;
    const engine = fakeEngine();
    const original = engine.classify.bind(engine);
    engine.classify = async (t) => { current = false; return original(t); }; // superseded during the first sentence
    const { d } = deps({ net, engine, isCurrent: () => current });
    expect((await analyse(job({}, { token: 't' }), d)).status).toBe('idle');
    expect(net.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

test('OTHER_INDEX is the "other" class', () => expect(TOS_CATEGORIES[OTHER_INDEX]).toBe('other'));
