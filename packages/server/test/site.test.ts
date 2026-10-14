import { describe, expect, test } from 'bun:test';
import { CATEGORY_HINTS, CATEGORY_LABELS, FAMILIES, FAMILY_HINTS, FAMILY_LABELS, FAMILY_OF, TOS_CATEGORIES } from '@ppg/shared';
import { AuthStore } from '../src/auth.ts';
import { createApp } from '../src/index.ts';
import { ResultStore } from '../src/store.ts';
import { upload } from './helpers.ts';
// @ts-expect-error plain browser module without types
import * as pure from '../public/js/pure.js';

const CONFIG = { baseUrl: 'https://model.invalid/v1', apiKey: '', model: 'm', temperature: 0, maxTokens: 1, timeoutMs: 1000 };
const store = new ResultStore({ file: ':memory:' });
const app = createApp({ config: CONFIG, store, auth: new AuthStore({ users: new Map() }), modelsDir: '/nonexistent' });
const get = (path: string, init?: RequestInit) => app.request(path, init);

describe('pages and files', () => {
  test('clean URLs map to the three pages', async () => {
    expect(await (await get('/')).text()).toContain('How do a site’s terms read?');
    expect(await (await get('/docs')).text()).toContain('The public API');
    const page = await get('/site/github.com');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('/js/site.js');
  });

  test('stylesheets, scripts and fonts are served with sensible types and caching', async () => {
    const css = await get('/css/site.css');
    expect(css.headers.get('content-type')).toContain('text/css');
    const js = await get('/js/common.js');
    expect(js.headers.get('content-type')).toContain('javascript');
    const font = await get('/fonts/source-serif-4-latin-wght-normal.woff2');
    expect(font.headers.get('cache-control')).toContain('immutable');
    expect((await get('/', { method: 'HEAD' })).status).toBe(200);
  });

  test('unknown paths and directories are 404 with the friendly page', async () => {
    for (const path of ['/nope', '/js', '/js/', '/site/a/b']) {
      const response = await get(path);
      expect(response.status).toBe(404);
    }
    expect(await (await get('/nope')).text()).toContain('That page does not exist');
  });

  test('paths cannot leave the public folder', async () => {
    for (const path of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/src/app.ts', '/js/../../src/app.ts', '/%00', '/%zz']) {
      const response = await get(path);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('createSite');
    }
  });

  test('the pages only answer reads', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) expect((await get('/', { method })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('one server for the site and the API', () => {
  test('the API keeps its prefixes: JSON, never the site\'s pages', async () => {
    const stats = await get('/api/v1/stats');
    expect(stats.headers.get('content-type')).toContain('application/json');
    expect(stats.headers.get('content-security-policy')).toBeNull();
    const unknown = await get('/api/v1/nothing-here');
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type') ?? '').not.toContain('text/html');
    expect(((await get('/health')).headers.get('content-type')) ?? '').toContain('json');
    expect((await get('/models/nothing')).status).toBe(404);
    expect(((await get('/models/nothing')).headers.get('content-type')) ?? '').not.toContain('text/html');
  });

  test('a stored result is readable through the same server the page was served from', async () => {
    store.insert(upload(), 'alice');
    const read = await get('/api/v1/sites/example.com');
    expect(read.status).toBe(200);
    expect(((await read.json()) as { documents: unknown[] }).documents).toHaveLength(1);
    expect((await get('/site/example.com')).status).toBe(200);
  });

  test('a strict content security policy allows only this origin', async () => {
    const csp = (await get('/')).headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/https?:/);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    const response = await get('/');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('no page uses inline scripts, inline styles or event-handler attributes, which the policy would block', async () => {
    for (const name of ['index', 'site', 'docs', '404']) {
      const html = await Bun.file(new URL(`../public/${name}.html`, import.meta.url)).text();
      expect(html).not.toMatch(/\son[a-z]+=/i);
      expect(html).not.toMatch(/\sstyle=/i);
      expect(html).not.toMatch(/<style/i);
      for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) expect(tag).toMatch(/\ssrc=/);
    }
  });
});

describe('labels match the shared package', () => {
  test('same categories, names, hints and families as the extension and the server', () => {
    expect(pure.TOS_CATEGORIES).toEqual([...TOS_CATEGORIES]);
    expect(pure.CATEGORY_LABELS).toEqual(CATEGORY_LABELS);
    expect(pure.CATEGORY_HINTS).toEqual(CATEGORY_HINTS);
    expect(pure.FAMILIES).toEqual([...FAMILIES]);
    expect(pure.FAMILY_OF).toEqual(FAMILY_OF);
    expect(pure.FAMILY_LABELS).toEqual(FAMILY_LABELS);
    expect(pure.FAMILY_HINTS).toEqual(FAMILY_HINTS);
  });
});

describe('what people type', () => {
  test('domainCandidates reads domains and links, most specific first', () => {
    expect(pure.domainCandidates('GitHub.com')).toEqual(['github.com']);
    expect(pure.domainCandidates('  https://www.Docs.Example.co.uk/terms?x=1#top ')).toEqual(['docs.example.co.uk', 'example.co.uk']);
    expect(pure.domainCandidates('http://shop.example.com:8080/a')).toEqual(['shop.example.com', 'example.com']);
  });
  test('and refuses what is not a site', () => {
    for (const bad of ['', '   ', 'localhost', 'not a site', 'javascript:alert(1)', 'a'.repeat(300) + '.com']) expect(pure.domainCandidates(bad)).toEqual([]);
  });
  test('familyCounts groups categories into families in a fixed order', () => {
    expect(pure.familyCounts({ arbitration: 2, jurisdiction: 1, unilateral_termination: 4 })).toEqual([{ family: 'rights', n: 3 }, { family: 'control', n: 4 }]);
    expect(pure.familyCounts({})).toEqual([]);
  });
  test('formatting', () => {
    expect(pure.percent(0.056)).toBe('5.6%');
    expect(pure.percent(0.1)).toBe('10%');
    expect(pure.policyLabel('https://a.com/legal/terms/')).toBe('/legal/terms');
    expect(pure.policyLabel('https://a.com/')).toBe('/');
    const now = Date.UTC(2026, 9, 14, 12);
    expect(pure.timeAgo(new Date(now - 30_000).toISOString(), now)).toBe('just now');
    expect(pure.timeAgo(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3 hours ago');
    expect(pure.timeAgo(new Date(now - 86_400_000).toISOString(), now)).toBe('1 day ago');
  });
});
