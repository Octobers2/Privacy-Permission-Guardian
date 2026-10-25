/**
 * End-to-end check of the public query site in a real browser, against a real results server on a throwaway database:
 *
 *   bun run eval/run-site-e2e.ts [--headed]
 *
 * The results server serves the site, so one process stands in for the whole deployment.
 *
 *   search      a domain or a pasted link finds the site; an unknown site says so; junk is refused before any request
 *   site page   documents, the strip, the family filter, folding, history with an older version
 *   safety      a passage written as HTML is shown as text and nothing runs; the page's policy blocks inline script
 *   lists       rankings (both orders) and the recent list link to the site page
 *   api page    "Try it" runs a real request
 */
import { chromium } from 'playwright-core';
import { OTHER_INDEX, TOS_CATEGORIES, type ResultUpload, type UnfairCategory } from '@ppg/shared';
import { AuthStore } from '../packages/server/src/auth.ts';
import { createApp } from '../packages/server/src/index.ts';
import { ResultStore } from '../packages/server/src/store.ts';

const PORT = 8797;
const headed = process.argv.includes('--headed');
const EVIL = '<img src=x onerror="window.__pwn=1"> <script>window.__pwn=2</script> We may close your account at any time.';

const probs = (c: UnfairCategory, mass = 0.9) => TOS_CATEGORIES.map((_, i) => (i === TOS_CATEGORIES.indexOf(c) ? mass : i === OTHER_INDEX ? 1 - mass : 0));
const passage = (index: number, category: UnfairCategory, text: string) => ({ index, text, category, probs: probs(category) });
const upload = (o: Partial<ResultUpload>): ResultUpload => ({
  url: 'https://acme-demo.com/terms', domain: 'acme-demo.com', textHash: 'a'.repeat(64), model: { id: 'ppg-fast-0.8b-q4f32', version: '1' }, promptVersion: 'letters-v1', passageCount: 100,
  passages: [passage(3, 'unilateral_termination', EVIL)], money: [], ...o,
});

let now = Date.now() - 3_600_000;
const store = new ResultStore({ file: ':memory:', now: () => now });
const many = Array.from({ length: 9 }, (_, i) => passage(5 + i * 9, i % 2 ? 'arbitration' : 'unilateral_change', `Clause number ${i} says something unfair.`));
store.insert(upload({ textHash: 'b'.repeat(64), passages: [passage(7, 'arbitration', 'The old version had arbitration.')] }), 'e2e'); // an older version
now += 1_800_000;
const FEE = '<b onmouseover="window.__pwn=3">All fees are non-refundable.</b>';
store.insert(upload({ passages: [passage(3, 'unilateral_termination', EVIL), ...many], passageCount: 120, money: [{ index: 20, kind: 'no_refund', text: FEE }] }), 'e2e');
store.reportMissing('nowhere-demo.com', 'https://nowhere-demo.com/signup', []);
store.reportMissing('nowhere-demo.com', 'https://nowhere-demo.com/signup', []);
store.insert(upload({ url: 'https://quiet-demo.org/terms', domain: 'quiet-demo.org', passages: [], passageCount: 60 }), 'e2e');
store.insert(upload({ url: 'https://big-demo.net/tos', domain: 'big-demo.net', passageCount: 1000, passages: Array.from({ length: 40 }, (_, i) => passage(i * 20, 'jurisdiction', `Court clause ${i}.`)) }), 'e2e');

const api = createApp({ config: { baseUrl: 'https://model.invalid/v1', apiKey: '', model: '', temperature: 0, maxTokens: 1, timeoutMs: 1000 }, store, auth: new AuthStore({ users: new Map() }), modelsDir: '/nonexistent' });
const server = Bun.serve({ port: PORT, fetch: api.fetch });
const BASE = `http://localhost:${PORT}`;

let failed = false;
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed = true;
};

const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM ?? '/usr/bin/chromium', headless: !headed, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const problems: string[] = [];
  let apiCalls = 0;
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) problems.push(m.text()); });
  page.on('request', (r) => { if (r.url().startsWith(`${BASE}/api/v1/sites`)) apiCalls++; });

  console.log('\n=== search ===');
  await page.goto(BASE);
  await page.locator('#rankings table').waitFor();
  check((await page.title()) === 'Terms check', 'home page loads');
  await page.fill('#q', 'not a site');
  await page.click('button[type=submit]');
  check(/does not look like a website/.test((await page.locator('#search-status').textContent()) ?? ''), 'junk input is refused');
  check(apiCalls === 0, 'and no request was made for it');

  await page.fill('#q', 'https://www.Nobody-Demo.com/terms?x=1');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => /Nobody has read/.test(document.getElementById('search-status')?.textContent ?? ''));
  check(true, 'an unknown site says nobody has read it');

  await page.fill('#q', 'https://www.ACME-demo.com/some/page');
  await Promise.all([page.waitForURL('**/site/acme-demo.com'), page.click('button[type=submit]')]);
  check(page.url().endsWith('/site/acme-demo.com'), 'a pasted link finds the site');

  console.log('\n=== site page ===');
  await page.locator('article.doc').waitFor();
  check((await page.locator('h1').textContent()) === 'acme-demo.com', 'the domain is the heading');
  check((await page.title()).startsWith('acme-demo.com'), 'and the tab title');
  const heading = (await page.locator('article.doc h2').first().textContent()) ?? '';
  check(/10 clauses that may work against you/.test(heading), 'headline counts the flagged clauses', heading);
  check((await page.locator('svg.strip').count()) === 1 && (await page.locator('svg.strip rect.flagged').count()) === 11, 'the strip has one tick per flagged clause, and one for the fee clause');
  check((await page.locator('.clause').count()) === 6, 'only the first six clauses are shown at first');
  await page.getByRole('button', { name: 'Show all 11 clauses' }).click();
  check((await page.locator('.clause').count()) === 11, '"Show all" reveals every clause');

  await page.locator('.chip.fam-rights').click();
  const kinds = await page.locator('.clause h4').allTextContents();
  check(kinds.length > 0 && kinds.every((k) => k === 'Mandatory arbitration'), 'a family chip filters the list', kinds.join(','));
  check((await page.locator('rect.flagged.dim').count()) === (await page.locator('rect.flagged').count()) - kinds.length, 'and dims the other ticks');
  await page.locator('.chip.fam-rights').click();
  check((await page.locator('.clause').count()) >= 6, 'clicking it again clears the filter');

  console.log('\n=== money ===');
  await page.getByRole('button', { name: /^Money/ }).click();
  const feeCards = page.locator('article.clause.fam-money');
  check((await feeCards.count()) === 1 && /Money/.test((await page.locator('.list-title').textContent()) ?? ''), 'the Money chip shows the fee clauses, and only those');
  check(/No refunds/.test((await feeCards.textContent()) ?? '') && /All fees are non-refundable/.test((await feeCards.textContent()) ?? ''), 'a fee clause says what kind it is and quotes the sentence');
  check((await page.locator('blockquote b').count()) === 0 && (await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn)) === undefined, 'and a fee sentence written as HTML is shown as text');
  await page.getByRole('button', { name: /^Money/ }).click(); // back to everything

  console.log('\n=== safety ===');
  await page.getByRole('button', { name: /Show all/ }).click().catch(() => {});
  const quote = page.locator('blockquote', { hasText: 'We may close your account' });
  check((await quote.textContent())?.includes('<img src=x') === true, 'a passage written as HTML is shown as text');
  check((await page.locator('blockquote img, blockquote script').count()) === 0, 'and creates no elements');
  check((await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn)) === undefined, 'nothing from it ran');
  const csp = await page.evaluate(() => fetch(location.href).then((r) => r.headers.get('content-security-policy')));
  check(/script-src 'self'/.test(csp ?? ''), 'the page is served with a script policy');

  console.log('\n=== history ===');
  await page.locator('details.history summary').click();
  await page.locator('.versions li').first().waitFor();
  check((await page.locator('.versions li').count()) === 2, 'two versions are listed');
  await page.getByRole('button', { name: /Show the version of/ }).nth(1).click();
  await page.locator('.tag', { hasText: 'Older version' }).waitFor();
  check(/The old version had arbitration/.test((await page.locator('article.doc').textContent()) ?? ''), 'an older version can be shown in place');

  console.log('\n=== a site with nothing flagged, and a missing one ===');
  await page.goto(`${BASE}/site/quiet-demo.org`);
  await page.locator('article.doc').waitFor();
  check(/No clauses that look unfair/.test((await page.locator('article.doc h2').textContent()) ?? ''), 'says so plainly');
  await page.goto(`${BASE}/site/ghost-demo.org`);
  await page.locator('.hero.small').waitFor();
  check(/Nobody has read this site/.test((await page.locator('main').textContent()) ?? ''), 'an unknown site page explains itself');
  const missing = await page.goto(`${BASE}/nowhere`);
  check(missing?.status() === 404 && /does not exist/.test((await page.locator('main').textContent()) ?? ''), 'an unknown address is a friendly 404');

  console.log('\n=== a site reported as having no terms ===');
  await page.goto(`${BASE}/site/nowhere-demo.com`);
  await page.locator('.hero.small .warn-tag').waitFor();
  const reported = (await page.locator('main').textContent()) ?? '';
  check(/No terms found/.test(reported) && /2 people reported/.test(reported), 'its page says how many people reported that it has no terms');
  check(/not a verdict/.test(reported), 'and that a report is an observation, not a verdict');

  console.log('\n=== lists ===');
  await page.goto(BASE);
  await page.locator('#rankings tbody tr').first().waitFor();
  const rankByCount = await page.locator('#rankings tbody th a').allTextContents();
  check(rankByCount[0] === 'acme-demo.com' || rankByCount[0] === 'big-demo.net', 'rankings list the sites', rankByCount.join(', '));
  check(rankByCount[0] === 'big-demo.net', 'by count, the site with most flagged clauses is first');
  await page.getByRole('button', { name: 'Share of the document' }).click();
  await page.waitForFunction(() => document.querySelector('#rankings tbody th a')?.textContent === 'acme-demo.com');
  const rankByShare = await page.locator('#rankings tbody th a').allTextContents();
  check(rankByShare[0] === 'acme-demo.com', 'by share of the text, the order can differ', rankByShare.join(', '));
  await page.locator('#missing ul.recent > li').first().waitFor();
  check(/nowhere-demo\.com/.test((await page.locator('#missing').textContent()) ?? '') && /2 reports/.test((await page.locator('#missing').textContent()) ?? ''), 'the home page lists sites reported as having no terms');
  await page.locator('#recent ul.recent > li').first().waitFor();
  const recentCount = await page.locator('#recent ul.recent > li').count();
  check(recentCount === 3, 'recent lists each policy once', String(recentCount));
  await Promise.all([page.waitForURL('**/site/**'), page.locator('#recent a').first().click()]);
  check(true, 'a recent entry links to its site page');

  console.log('\n=== docs page ===');
  await page.goto(`${BASE}/docs`);
  await page.locator('article.endpoint').first().waitFor();
  check((await page.locator('#base code').textContent()) === BASE, 'shows the API address');
  await page.locator('article.endpoint', { hasText: '/api/v1/stats' }).getByRole('button', { name: 'Try it' }).click();
  await page.waitForFunction(() => /"results": \d+/.test(document.querySelector('article.endpoint:last-of-type .out')?.textContent ?? ''));
  check(true, '"Try it" runs a real request and shows the answer');

  console.log('\n=== small screen ===');
  await page.setViewportSize({ width: 360, height: 800 });
  for (const path of ['/', '/site/acme-demo.com', '/docs']) {
    await page.goto(BASE + path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 0, `no sideways scrolling on ${path}`, overflow > 0 ? `${overflow}px too wide` : '');
  }

  check(problems.length === 0, 'no script errors or console errors on any page', problems.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.stop(true);
}
console.log(failed ? '\nFAILED' : '\nALL PASSED');
process.exit(failed ? 1 : 0);
