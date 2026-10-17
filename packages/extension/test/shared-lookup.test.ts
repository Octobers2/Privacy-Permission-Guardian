import { describe, expect, test } from 'bun:test';
import { OTHER_INDEX, TOS_CATEGORIES, type ResultView } from '@ppg/shared';
import { addressKey, lookupShared, pickDocument } from '../src/background/shared-lookup.ts';

const probs = TOS_CATEGORIES.map((_, i) => (i === TOS_CATEGORIES.indexOf('arbitration') ? 0.9 : i === OTHER_INDEX ? 0.1 : 0));
function doc(path: string, createdAt: string, unfair = 1): ResultView {
  return {
    id: 1, url: `https://example.com${path}`, domain: 'example.com', textHash: 'a'.repeat(64), model: { id: 'm', version: '1' }, promptVersion: 'letters-v1',
    createdAt, expiresAt: '2026-12-01T00:00:00.000Z', passageCount: 50, unfairCount: unfair, fairCount: 50 - unfair, categories: { arbitration: unfair },
    passages: Array.from({ length: unfair }, (_, i) => ({ index: i, text: 'Any dispute goes to arbitration.', category: 'arbitration' as const, probs })), current: true,
  };
}
const json = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('addressKey', () => {
  test('treats www, case, query, fragment and a trailing slash as the same page', () => {
    const a = addressKey('https://WWW.Example.com/Terms/?utm=1#top');
    expect(a).toBe(addressKey('https://example.com/Terms'));
    expect(a).not.toBe(addressKey('https://example.com/privacy'));
    expect(addressKey('not a url')).toBeNull();
  });
});

describe('pickDocument', () => {
  const privacy = doc('/privacy', '2026-10-10T00:00:00.000Z');
  const terms = doc('/legal/terms', '2026-10-01T00:00:00.000Z');
  const newer = doc('/about', '2026-10-15T00:00:00.000Z');

  test('nothing -> null', () => expect(pickDocument([], [])).toBeNull());
  test('the document the page points at wins, in the order of the hints', () => {
    expect(pickDocument([privacy, terms, newer], ['https://www.example.com/privacy/?x=1', 'https://example.com/legal/terms'])).toBe(privacy);
    expect(pickDocument([privacy, terms, newer], ['https://example.com/other', 'https://example.com/legal/terms'])).toBe(terms);
  });
  test('without a hint, something that looks like terms beats a newer unrelated page', () => {
    expect(pickDocument([privacy, newer, terms], [])).toBe(terms);
  });
  test('and with neither, the newest', () => {
    expect(pickDocument([privacy, newer], [])).toBe(newer);
  });
});

describe('lookupShared', () => {
  const base = { serverUrl: 'https://results.example.org', domain: 'example.com', hints: [] as string[] };

  test('a hit becomes a result from the public cache, with the site link', async () => {
    const state = await lookupShared({ ...base, fetch: json({ domain: 'example.com', documents: [doc('/terms', '2026-10-10T00:00:00.000Z', 3), doc('/privacy', '2026-10-09T00:00:00.000Z')] }) });
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    expect(state.result).toMatchObject({ source: 'community', domain: 'example.com', policyUrl: 'https://example.com/terms', passageCount: 50, personal: null, summary: null });
    expect(state.result.flagged).toHaveLength(3);
    expect(state.result.sharing).toEqual({ status: 'already-public' });
    expect(state.result.site).toEqual({ documents: 2, url: 'https://results.example.org/site/example.com' });
  });

  test('asks the server about the domain only: no path, no page text', async () => {
    const urls: string[] = [];
    const spy = (async (url: string) => { urls.push(String(url)); return new Response(JSON.stringify({ documents: [] }), { status: 200 }); }) as unknown as typeof fetch;
    await lookupShared({ ...base, hints: ['https://example.com/terms?token=secret'], fetch: spy });
    expect(urls).toEqual(['https://results.example.org/api/v1/sites/example.com']);
  });

  test('a site nobody has read says so, and says why this browser cannot read it', async () => {
    const state = await lookupShared({ ...base, fetch: json({ error: 'not_found' }, 404) });
    expect(state).toMatchObject({ status: 'unavailable', domain: 'example.com' });
    expect(state.status === 'unavailable' && state.reason).toContain('only looks up shared results');
  });

  test('a server that cannot be reached, or that fails, is an error with something to do', async () => {
    const down = (async () => { throw new TypeError('network'); }) as unknown as typeof fetch;
    const a = await lookupShared({ ...base, fetch: down });
    expect(a.status === 'error' && a.message).toContain('https://results.example.org');
    const b = await lookupShared({ ...base, fetch: json({}, 503) });
    expect(b.status === 'error' && b.message).toContain('503');
  });

  test('never contacts the server about a private or local address', async () => {
    let called = false;
    const spy = (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch;
    for (const domain of ['localhost', '192.168.1.10', '10.0.0.5', 'intranet', '127.0.0.1']) {
      const state = await lookupShared({ ...base, domain, fetch: spy });
      expect(state.status).toBe('unavailable');
    }
    expect(called).toBe(false);
  });

  test('a reply with no documents is not a crash', async () => {
    expect((await lookupShared({ ...base, fetch: json({ documents: 'nope' }) })).status).toBe('unavailable');
  });
});
