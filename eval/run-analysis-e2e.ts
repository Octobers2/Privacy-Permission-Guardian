/**
 * End-to-end check of the analysis flow, in a real browser with the built extension and the real backend:
 *
 *   bun run build && bun run eval/run-analysis-e2e.ts [--headed]
 *
 * Fake sites (eval/fixtures/terms) are served locally and mapped to public-looking hostnames, the backend runs on a temporary
 * database, the extension is seeded as if setup had been completed, and the popup page is driven like a user would:
 *   A  first analysis of a terms page: read on this device, the unfair clauses found, shared to the backend
 *   B  the same policy again with the local result wiped: served from the public cache
 *   C  the policy text changed: read again, a second version stored
 *   D  a page that shows the user's account: analysed locally, never shared, never looked up
 *   E  a site with no terms: said plainly
 *   F  signed out: analysed, not shared
 */
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright-core';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const dist = join(root, 'packages/extension/dist');
const fixtures = join(root, 'eval/fixtures/terms');
const SERVER_PORT = 8798;
const SITE_PORT = 4310;
const SERVER = `http://localhost:${SERVER_PORT}`;
const HOSTS = ['acme-demo.com', 'shop-demo.com', 'plain-demo.com'];
const site = (host: string, path = '/') => `http://${host}:${SITE_PORT}${path}`;
const headed = process.argv.includes('--headed');

if (!existsSync(join(dist, 'manifest.json'))) throw new Error('Build the extension first: bun run build');
if (!existsSync(join(root, 'data/models/manifest.json'))) throw new Error('No model manifest: bun run models:manifest');

// ---- fake sites: the terms page of acme-demo.com can be switched between versions
let acmeTerms = 'terms.html';
const siteServer = Bun.serve({
  port: SITE_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const host = (req.headers.get('host') ?? '').split(':')[0]!.replace(/^www\./, '');
    const path = url.pathname === '/' ? '/index' : url.pathname;
    const file = host === 'acme-demo.com' && path === '/terms' ? acmeTerms : `${path.slice(1)}.html`;
    const full = join(fixtures, host, file);
    return existsSync(full) ? new Response(Bun.file(full), { headers: { 'content-type': 'text/html; charset=utf-8' } }) : new Response('not found', { status: 404 });
  },
});

// ---- backend on a temporary database and account
const tmp = mkdtempSync(join(tmpdir(), 'ppg-analysis-e2e-'));
writeFileSync(join(tmp, 'auth.txt'), `contributor:${await Bun.password.hash('correct-horse-battery', { algorithm: 'bcrypt', cost: 4 })}\n`);
const backend = Bun.spawn(['bun', 'run', 'packages/server/src/index.ts'], {
  cwd: root,
  env: { ...Bun.env, PPG_PORT: String(SERVER_PORT), PPG_DB_FILE: join(tmp, 'ppg.sqlite'), PPG_AUTH_FILE: join(tmp, 'auth.txt') },
  stdout: 'ignore',
  stderr: 'inherit',
});

let failed = false;
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed = true;
};
const api = async (path: string) => (await fetch(`${SERVER}${path}`)).json() as Promise<any>;

let context: BrowserContext | undefined;
try {
  for (let i = 0; i < 50 && !(await fetch(`${SERVER}/health`).catch(() => null))?.ok; i++) await Bun.sleep(200);

  context = await chromium.launchPersistentContext(join(tmp, 'profile'), {
    executablePath: Bun.env.CHROMIUM ?? '/usr/bin/chromium',
    headless: !headed,
    args: [
      `--disable-extensions-except=${dist}`, `--load-extension=${dist}`,
      '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--no-sandbox',
      ...(Bun.env.CHROME_LOG ? ['--enable-logging=stderr', '--v=0'] : []),
      `--host-resolver-rules=${HOSTS.flatMap((h) => [`MAP ${h} 127.0.0.1`, `MAP www.${h} 127.0.0.1`]).join(',')}`,
    ],
  });
  const worker: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const extensionId = new URL(worker.url()).host;
  for (const page of context.pages()) if (page.url().endsWith('/setup.html')) await page.close(); // opened on install

  const login = (await (await fetch(`${SERVER}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'contributor', password: 'correct-horse-battery' }) })).json()) as { token: string; expiresAt: number };
  const prefs = (extra: object = {}) => ({ setupDone: true, serverUrl: SERVER, modelId: 'ppg-fast-0.8b-q4f32', summary: 'off', byok: { baseUrl: '', apiKey: '', model: '' }, account: { username: 'contributor', ...login }, paused: false, allowlist: [], ...extra });
  const setPrefs = (extra: object = {}) => worker.evaluate((p) => chrome.storage.local.set({ 'ppg-prefs': p }), prefs(extra));
  const wipeLocal = () => worker.evaluate(async () => { await chrome.storage.local.remove('ppg-results'); const all = await chrome.storage.session.get(null); await chrome.storage.session.remove(Object.keys(all)); });
  await setPrefs();

  /** Opens a site, then drives the extension's popup against that tab like a user, and returns what the popup says. */
  async function analyse(host: string, path = '/'): Promise<{ text: string; ms: number; groups: string[]; popup: Page }> {
    const sitePage = await context!.newPage();
    await sitePage.goto(site(host, path));
    const tabId = await worker.evaluate(async (prefix) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(prefix))!.id!, site(host));
    const popup = await context!.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
    const started = Date.now();
    // TIMELINE=1: sample the analysis state a few times a second and print each change, to see where the time goes
    const timeline: string[] = [];
    let last = '';
    let lastUi = '';
    const sampler = Bun.env.TIMELINE ? setInterval(async () => {
      const st = await worker.evaluate(async (id) => (await chrome.storage.session.get('analysis:' + id))['analysis:' + id]?.state, tabId).catch(() => null);
      const label = st ? `${st.status}${st.stage ? ':' + st.stage : ''}` : 'none';
      if (label !== last) { last = label; timeline.push(`${((Date.now() - started) / 1000).toFixed(1)}s state=${label}`); }
      const ui = await popup.evaluate(() => (document.querySelector('.app main')?.innerText ?? '').replace(/\s+/g, ' ').slice(22, 70)).catch(() => '');
      if (ui !== lastUi) { lastUi = ui; timeline.push(`${((Date.now() - started) / 1000).toFixed(1)}s ui="${ui}"`); }
    }, 300) : null;
    await popup.getByText('Read the terms', { exact: true }).click();
    await popup.locator('section.ready h2, section.state h2').first().waitFor({ timeout: 180_000 });
    if (sampler) { clearInterval(sampler); console.log('  [timeline] ' + timeline.join('  ->  ')); }
    const text = (await popup.locator('main').innerText()).replace(/\s+/g, ' ');
    // read the findings before the site tab closes: the popup rightly stops showing them once its tab is gone
    const groups = (await popup.locator('article.clause .kind').allTextContents()).map((t) => t.trim());
    const tech = (await popup.locator('.tech pre').textContent({ timeout: 300 }).catch(() => '')) ?? '';
    if (tech) console.log('  [technical details]\n' + tech.split('\n').map((l) => '    ' + l).join('\n'));
    await sitePage.close();
    return { text, ms: Date.now() - started, groups, popup };
  }

  // A ---------------------------------------------------------------------------------------------------------
  console.log('\n=== A. first analysis of acme-demo.com ===');
  const a = await analyse('acme-demo.com');
  console.log(`  ${(a.ms / 1000).toFixed(1)} s | ${a.text}`);
  check(/\d+ clauses? that may work against you/.test(a.text), 'a headline with the number of flagged clauses');
  check(/read on this device/.test(a.text), 'it says the analysis happened on this device');
  const flaggedCount = Number(/(\d+) clauses? that may/.exec(a.text)?.[1] ?? 0);
  check(flaggedCount >= 5 && flaggedCount <= 9, 'about the seven planted clauses were flagged', `${flaggedCount} flagged of 11`);
  const groups = a.groups;
  // Planted: termination, liability, arbitration, content removal, a change-of-terms clause (read as "contract by using" or
  // "unilateral change"), choice of law and jurisdiction. A small model may fold choice of law into jurisdiction, so the bar is "most".
  const planted = ['Unilateral termination', 'Limitation of liability', 'Mandatory arbitration', 'Content removal', 'Jurisdiction'];
  const found = planted.filter((c) => groups.includes(c));
  check(found.length >= 4, 'most of the planted kinds of clause were recognised', `${found.length}/5: ${groups.join(', ')}`);
  check(groups.includes('Unilateral change') || groups.includes('Contract by using'), 'the change-of-terms clause was recognised as one of its two kinds');
  check(/Shared publicly/.test(a.text), 'the signed-in user shared the result');
  const first = await api('/api/v1/lookup?url=' + encodeURIComponent(site('acme-demo.com', '/terms')));
  check(first.result?.unfairCount === flaggedCount, 'the backend holds the same result publicly', `${first.result?.unfairCount} stored`);
  check(!JSON.stringify(first).includes('support@acme-demo.com') && !JSON.stringify(first).includes('invoices'), 'the fair sentences were not uploaded');
  check(first.result?.model?.id === 'ppg-fast-0.8b-q4f32', 'the model that produced it is recorded');

  if (process.argv.includes('--only-a')) throw new Error('stopped after A (--only-a)');

  // B ---------------------------------------------------------------------------------------------------------
  console.log('\n=== B. same policy, local result wiped: public cache ===');
  await wipeLocal();
  const b = await analyse('acme-demo.com');
  console.log(`  ${(b.ms / 1000).toFixed(1)} s | ${b.text.slice(0, 160)}`);
  check(/from the public cache/.test(b.text), 'served from the public cache');
  check(b.ms < a.ms, 'faster than the first run', `${(b.ms / 1000).toFixed(1)} s vs ${(a.ms / 1000).toFixed(1)} s`);
  check(Number(/(\d+) clauses? that may/.exec(b.text)?.[1]) === flaggedCount, 'the same clauses');

  // C ---------------------------------------------------------------------------------------------------------
  console.log('\n=== C. the policy changed ===');
  acmeTerms = 'terms.v2.html';
  await wipeLocal();
  const c = await analyse('acme-demo.com');
  check(/read on this device/.test(c.text), 'changed text is read again, not served from the cache');
  const hist = await api('/api/v1/history?url=' + encodeURIComponent(site('acme-demo.com', '/terms')));
  check(hist.versions?.length === 2 && hist.versions[0].current && !hist.versions[1].current, 'both versions are kept, the newest is current', `${hist.versions?.length} versions`);

  // D ---------------------------------------------------------------------------------------------------------
  console.log('\n=== D. a page that shows the user’s account ===');
  const before = (await api('/api/v1/stats')).results;
  const d = await analyse('shop-demo.com');
  console.log(`  ${d.text.slice(0, 260)}`);
  check(/looks like it shows personal information/.test(d.text), 'it explains the result was not shared because the page looks personal');
  check(/personal email/.test(d.text), 'the reason is given without repeating the address', '');
  check(!d.text.includes('jane.doe'), 'the address itself is not shown in the popup');
  check((await api('/api/v1/stats')).results === before, 'nothing was added to the backend');
  check(!(await api('/api/v1/sites/shop-demo.com')).documents, 'and nothing is public for that site');

  // E ---------------------------------------------------------------------------------------------------------
  console.log('\n=== E. a site with no terms ===');
  const e = await analyse('plain-demo.com');
  check(/No terms of service were found/.test(e.text) && !/Found \d+ link/.test(e.text), 'said plainly, without claiming links were found', e.text.slice(0, 90));

  // F ---------------------------------------------------------------------------------------------------------
  console.log('\n=== F. signed out ===');
  acmeTerms = 'terms.v3.html';
  await setPrefs({ account: null });
  await wipeLocal();
  const f = await analyse('acme-demo.com');
  check(/Not shared/.test(f.text) && /Sign in as a contributor/.test(f.text), 'analysed on the device but not shared, with the way to change that');
  check((await api('/api/v1/history?url=' + encodeURIComponent(site('acme-demo.com', '/terms')))).versions.length === 2, 'no third version was uploaded');
} catch (error) {
  failed = true;
  console.log('FAIL  ', error instanceof Error ? error.stack ?? error.message : error);
  for (const [i, p] of (context?.pages() ?? []).entries()) {
    await p.screenshot({ path: `/tmp/claude-1000/analysis-e2e-fail-${i}.png` }).catch(() => {});
    console.log(`  page ${i}: ${p.url()}`);
  }
} finally {
  await context?.close().catch(() => {});
  backend.kill();
  siteServer.stop(true);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? '\nFAILED' : '\nALL PASSED');
process.exit(failed ? 1 : 0);
