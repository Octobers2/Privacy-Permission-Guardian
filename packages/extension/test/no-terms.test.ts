import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import type { FormObservation } from '@ppg/shared';
import { asksForDetails, publishesNoTerms } from '../src/content/no-terms.ts';
import { hasPolicyLink, PRIVACY_PATTERN } from '../src/content/policy-scout.ts';
import { cleanAddress, othersFoundNoTerms, reportMissingTerms } from '../src/background/missing-terms.ts';

const domOf = (body: string, title = 'Home') => parseHTML(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`).document as unknown as Document;
const field = (over: Partial<FormObservation['form']['fields'][number]> = {}) => ({ type: 'text', name: '', id: '', autocomplete: '', placeholder: '', label: '', required: false, ...over });
const form = (...fields: ReturnType<typeof field>[]): FormObservation[] => [
  { page: { url: 'https://quickloan.com/signup', hostname: 'quickloan.com', isHttps: true, title: 'Sign up' }, form: { fields, actionOrigin: null, method: 'post', submitText: 'Go' } },
];
const SIGNUP = form(field({ type: 'email', name: 'email' }), field({ type: 'password', name: 'pw' }));
const PAGE = 'https://quickloan.com/signup';

describe('privacy pattern', () => {
  test.each(['Privacy Policy', '/legal/privacy', 'Cookie notice', 'Data protection', '私隱政策'])('%s', (text) => expect(PRIVACY_PATTERN.test(text)).toBe(true));
  test.each(['Pricing', 'About us', 'Contact'])('not %s', (text) => expect(PRIVACY_PATTERN.test(text)).toBe(false));
});

describe('hasPolicyLink', () => {
  test('a privacy link, a terms link or a legal notice counts, by text or by address', () => {
    expect(hasPolicyLink(domOf('<a href="/p">Privacy</a>'), PAGE)).toBe(true);
    expect(hasPolicyLink(domOf('<a href="/legal/terms">Read more</a>'), PAGE)).toBe(true);
    expect(hasPolicyLink(domOf('<a href="/x">Terms of Use</a>'), PAGE)).toBe(true);
    expect(hasPolicyLink(domOf('<a href="/about">Disclaimer</a>'), PAGE)).toBe(true);
  });
  test('ordinary links do not', () => {
    expect(hasPolicyLink(domOf('<a href="/pricing">Pricing</a><a href="/about">About</a><a>no href</a>'), PAGE)).toBe(false);
  });
});

describe('asksForDetails', () => {
  test('a password or a payment/ID field', () => {
    expect(asksForDetails(SIGNUP)).toBe(true);
    expect(asksForDetails(form(field({ name: 'cc-number' })))).toBe(true);
    expect(asksForDetails(form(field({ label: 'Passport number' })))).toBe(true);
  });
  test('a search box or newsletter form does not', () => {
    expect(asksForDetails(form(field({ type: 'search', name: 'q' })))).toBe(false);
    expect(asksForDetails(form(field({ type: 'email', name: 'email' })))).toBe(false);
  });
});

describe('publishesNoTerms', () => {
  test('a sign-up with no terms or privacy link', () => {
    expect(publishesNoTerms(SIGNUP, domOf('<a href="/pricing">Pricing</a>'), PAGE)).toBe(true);
  });
  test('quiet when a privacy or terms link exists', () => {
    expect(publishesNoTerms(SIGNUP, domOf('<footer><a href="/privacy">Privacy</a></footer>'), PAGE)).toBe(false);
  });
  test('quiet without a form that wants details', () => {
    expect(publishesNoTerms(form(field({ type: 'search' })), domOf(''), PAGE)).toBe(false);
    expect(publishesNoTerms([], domOf(''), PAGE)).toBe(false);
  });
  test('quiet on the terms or privacy page itself', () => {
    expect(publishesNoTerms(SIGNUP, domOf('', 'Privacy Policy'), 'https://quickloan.com/legal')).toBe(false);
    expect(publishesNoTerms(SIGNUP, domOf(''), 'https://quickloan.com/privacy')).toBe(false);
  });
  test('quiet on localhost, an intranet name, an address and non-web pages', () => {
    for (const url of ['http://localhost:3000/login', 'http://intranet/login', 'http://192.168.1.4/login', 'file:///tmp/login.html', 'http://[::1]/login']) {
      expect(publishesNoTerms(SIGNUP, domOf(''), url)).toBe(false);
    }
  });
});

describe('cleanAddress', () => {
  test('drops the query, fragment and credentials, and refuses non-web addresses', () => {
    expect(cleanAddress('https://user:pw@quickloan.com/a/b?token=1#x')).toBe('https://quickloan.com/a/b');
    expect(cleanAddress('chrome://extensions')).toBeNull();
    expect(cleanAddress('nonsense')).toBeNull();
  });
});

describe('reportMissingTerms', () => {
  const reply = (status: number, body: unknown = {}) => {
    const calls: { url: string; body: any }[] = [];
    const impl = (async (url: string, init: RequestInit) => (calls.push({ url, body: JSON.parse(String(init.body)) }), new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;
    return { impl, calls };
  };

  test('sends the cleaned page address and the cleaned places tried, and nothing else', async () => {
    const net = reply(201, { reports: 3 });
    const outcome = await reportMissingTerms({ serverUrl: 'https://s.example/', url: 'https://quickloan.com/signup?email=a@b.com#top', tried: ['https://quickloan.com/terms?x=1', 'https://quickloan.com/terms', 'junk'], fetch: net.impl });
    expect(outcome).toMatchObject({ ok: true, reports: 3 });
    expect(net.calls[0]!.url).toBe('https://s.example/api/v1/reports/missing-terms');
    expect(net.calls[0]!.body).toEqual({ url: 'https://quickloan.com/signup', tried: ['https://quickloan.com/terms'] });
  });

  test('says what happened for each answer', async () => {
    const run = (status: number) => reportMissingTerms({ serverUrl: 'https://s', url: 'https://quickloan.com/', fetch: reply(status).impl });
    expect(await run(200)).toMatchObject({ ok: true, message: expect.stringContaining('already reported') });
    expect(await run(409)).toMatchObject({ ok: false, message: expect.stringContaining('already has shared terms') });
    expect(await run(422)).toMatchObject({ ok: false });
    expect(await run(429)).toMatchObject({ ok: false, message: expect.stringContaining('Too many') });
    expect(await run(500)).toMatchObject({ ok: false });
  });

  test('a page that is not a website sends nothing', async () => {
    const net = reply(201);
    expect((await reportMissingTerms({ serverUrl: 'https://s', url: 'chrome://newtab', fetch: net.impl })).ok).toBe(false);
    expect(net.calls).toHaveLength(0);
  });

  test('an unreachable server is a message, not an exception', async () => {
    const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await reportMissingTerms({ serverUrl: 'https://s', url: 'https://quickloan.com/', fetch: down })).toMatchObject({ ok: false });
  });
});

describe('othersFoundNoTerms', () => {
  test('the count, or null when nobody reported or the server cannot be reached', async () => {
    const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await othersFoundNoTerms({ serverUrl: 'https://s', domain: 'quickloan.com', fetch: answer(200, { reports: 4 }) })).toBe(4);
    expect(await othersFoundNoTerms({ serverUrl: 'https://s', domain: 'quickloan.com', fetch: answer(404, {}) })).toBeNull();
    expect(await othersFoundNoTerms({ serverUrl: 'https://s', domain: 'quickloan.com', fetch: (async () => { throw new Error('x'); }) as unknown as typeof fetch })).toBeNull();
  });
});
