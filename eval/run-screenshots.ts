/**
 * Renders every screen of the extension to PNG files, in light and dark, so a design change can be looked at rather than imagined.
 *
 *   bun run build && bun run eval/run-screenshots.ts [--out /tmp/shots] [--only popup|options|setup|banner]
 *
 * - popup: each analysis state is written straight into the extension's session storage (no model needed), then the popup page is
 *   opened against a real tab and photographed;
 * - options: as stored preferences allow;
 * - setup: the real wizard, driven against the real backend and a real download;
 * - banner: a lookalike-domain login page, which the content script warns about.
 */
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright-core';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const dist = join(root, 'packages/extension/dist');
const arg = (flag: string, fallback: string) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1]! : fallback);
const out = arg('--out', '/tmp/claude-1000/shots');
const only = arg('--only', 'all');
const audit = process.argv.includes('--axe');
const violations: string[] = [];
const SITE_PORT = 4312;
const SERVER_PORT = 8797;
const SERVER = `http://localhost:${SERVER_PORT}`;
mkdirSync(out, { recursive: true });
if (!existsSync(join(dist, 'manifest.json'))) throw new Error('Build the extension first: bun run build');

// ---------------------------------------------------------------- sample data for the popup states
const CATS = ['limitation_of_liability', 'contract_by_using', 'unilateral_change', 'arbitration', 'content_removal', 'choice_of_law', 'other', 'unilateral_termination', 'jurisdiction'];
const probs = (category: string, mass: number) => CATS.map((c) => (c === category ? mass : c === 'other' ? 1 - mass - 0.02 : 0.02 / 7));
const clause = (index: number, category: string, mass: number, text: string) => ({ index, text, category, probs: probs(category, mass) });
const FLAGGED = [
  clause(14, 'unilateral_termination', 0.97, 'We reserve the right to suspend or terminate your account at any time, with or without notice, and for any reason or no reason at all.'),
  clause(31, 'arbitration', 0.98, 'Any dispute arising out of these terms will be resolved exclusively by binding arbitration, and you waive any right to a jury trial or to take part in a class action.'),
  clause(32, 'jurisdiction', 0.91, 'Any claim that is not subject to arbitration must be brought exclusively in the courts located in San Francisco County, California.'),
  clause(47, 'limitation_of_liability', 0.99, 'Acme and its suppliers shall not be liable for any indirect, incidental, special or consequential damages arising out of your use of the service, even if we have been advised of the possibility of such damages.'),
  clause(52, 'limitation_of_liability', 0.86, 'The service is provided "as is" and we make no warranties about it.'),
  clause(61, 'unilateral_change', 0.88, 'We may modify these terms at any time, and your continued use of the service after a change means that you accept the new terms.'),
  clause(63, 'contract_by_using', 0.94, 'By using the service, you agree to be bound by these terms.'),
  clause(77, 'content_removal', 0.83, 'We may remove any content that you post at our sole discretion and without telling you why.'),
  clause(80, 'choice_of_law', 0.64, 'These terms are governed by the laws of the State of California.'),
];
const counts = (items: { category: string }[]) => items.reduce<Record<string, number>>((m, p) => ((m[p.category] = (m[p.category] ?? 0) + 1), m), {});
const result = (over: object = {}) => ({
  policyUrl: 'http://acme-demo.com:4310/terms', domain: 'acme-demo.com', textHash: 'a'.repeat(64), model: { id: 'ppg-fast-0.8b-q4f32', version: '2026-10-14' },
  analyzedAt: new Date(Date.now() - 12 * 60_000).toISOString(), source: 'this-device', passageCount: 186, flagged: FLAGGED, categories: counts(FLAGGED), truncated: false,
  sharing: { status: 'shared', id: 3 }, personal: null, summary: null, summaryError: null, ...over,
});
const SUMMARY = {
  domain: 'acme-demo.com', url: 'http://acme-demo.com:4310/terms', textHash: 'a'.repeat(64), riskScore: 74, droppedPoints: 0, promptVersion: 'summary-v1', model: 'gpt-4o-mini', generatedAt: new Date().toISOString(), cached: false,
  points: [
    { category: 'arbitration', severity: 'high', title: 'You give up the right to sue or join a class action', detail: 'Disputes go to a private arbitrator, and you cannot take part in a class action or have a jury.', quote: 'binding arbitration' },
    { category: 'unilateral_termination', severity: 'high', title: 'They can close your account without warning', detail: 'Your account can be suspended or ended at any time, for any reason, and you are not told why.', quote: 'with or without notice' },
    { category: 'limitation_of_liability', severity: 'medium', title: 'Almost no responsibility if things go wrong', detail: 'Acme excludes indirect and consequential damages, even if it knew they were possible.', quote: 'shall not be liable' },
    { category: 'unilateral_change', severity: 'low', title: 'The terms can change under you', detail: 'Using the service after a change counts as accepting it.', quote: 'continued use of the service' },
  ],
};
const STATES: Record<string, object> = {
  'popup-idle': { status: 'idle', domain: 'acme-demo.com' },
  'popup-needs-setup': { status: 'needs-setup' },
  'popup-working-loading': { status: 'working', domain: 'acme-demo.com', stage: 'loading-model', done: 58, total: 100, detail: 'Fetching params_shard_12.bin', flagged: [] },
  'popup-working-classifying': { status: 'working', domain: 'acme-demo.com', stage: 'classifying', done: 74, total: 186, flagged: FLAGGED.slice(0, 4) },
  'popup-ready-summary': { status: 'ready', domain: 'acme-demo.com', result: result({ summary: SUMMARY }) },
  'popup-ready': { status: 'ready', domain: 'acme-demo.com', result: result() },
  'popup-ready-community-clean': { status: 'ready', domain: 'acme-demo.com', result: result({ source: 'community', flagged: [], categories: {}, sharing: { status: 'already-public' }, analyzedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }) },
  'popup-ready-personal': { status: 'ready', domain: 'acme-demo.com', result: result({ flagged: FLAGGED.slice(0, 2), categories: counts(FLAGGED.slice(0, 2)), sharing: { status: 'blocked', reasons: ['1 personal email address', 'account-like page address'] }, personal: { reasons: ['1 personal email address'] } }) },
  'popup-unavailable': { status: 'unavailable', domain: 'acme-demo.com', reason: 'Found 2 links, but every one returned an error (a sign-in wall, or the page moved).', links: ['https://acme-demo.com/legal/terms', 'https://acme-demo.com/tos'] },
  'popup-error': { status: 'error', domain: 'acme-demo.com', message: "Failed to execute 'mapAsync' on 'GPUBuffer': [Device] is lost.", detail: 'while: classifying 14/186\nAbortError: Failed to execute mapAsync on GPUBuffer\n    at PpgEngine.letters (engine.ts:104)' },
};

// ---------------------------------------------------------------- fake sites and a backend for the wizard
const lookalike = join(root, 'eval/fixtures/phishing/secure-paypa1.xyz.html');
const siteServer = Bun.serve({
  port: SITE_PORT,
  fetch(req) {
    const host = (req.headers.get('host') ?? '').split(':')[0]!;
    if (host === 'secure-paypa1.xyz') return new Response(Bun.file(lookalike), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return new Response('<!doctype html><title>Acme</title><h1>Acme</h1><footer><a href="/terms">Terms</a></footer>', { headers: { 'content-type': 'text/html' } });
  },
});
const tmp = mkdtempSync(join(tmpdir(), 'ppg-shots-'));
writeFileSync(join(tmp, 'auth.txt'), `contributor:${await Bun.password.hash('correct-horse-battery', { algorithm: 'bcrypt', cost: 4 })}\n`);
const backend = Bun.spawn(['bun', 'run', 'packages/server/src/index.ts'], {
  cwd: root, stdout: 'ignore', stderr: 'inherit',
  env: { ...Bun.env, PPG_PORT: String(SERVER_PORT), PPG_DB_FILE: join(tmp, 'ppg.sqlite'), PPG_AUTH_FILE: join(tmp, 'auth.txt') },
});

const SCHEMES = ['light', 'dark'] as const;
let context: BrowserContext | undefined;
try {
  for (let i = 0; i < 50 && !(await fetch(`${SERVER}/health`).catch(() => null))?.ok; i++) await Bun.sleep(200);
  context = await chromium.launchPersistentContext(join(tmp, 'profile'), {
    executablePath: Bun.env.CHROMIUM ?? '/usr/bin/chromium', headless: true, deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--no-sandbox',
      '--host-resolver-rules=MAP acme-demo.com 127.0.0.1,MAP secure-paypa1.xyz 127.0.0.1'],
  });
  const worker: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const id = new URL(worker.url()).host;
  for (const page of context.pages()) if (page.url().endsWith('/setup.html')) await page.close();

  const login = (await (await fetch(`${SERVER}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'contributor', password: 'correct-horse-battery' }) })).json()) as object;
  const prefs = (extra: object = {}) => ({ setupDone: true, serverUrl: SERVER, modelId: 'ppg-fast-0.8b-q4f32', summary: 'server', byok: { baseUrl: '', apiKey: '', model: '' }, account: { username: 'contributor', ...login }, paused: false, allowlist: ['example-shop.com', 'bank.example'], ...extra });
  const setPrefs = (extra: object = {}) => worker.evaluate((p) => chrome.storage.local.set({ 'ppg-prefs': p }), prefs(extra));
  await setPrefs();

  const shoot = async (page: Page, name: string, scheme: string, selector?: string, wait = 250) => {
    await page.waitForTimeout(wait);
    const file = join(out, `${name}.${scheme}.png`);
    await (selector ? page.locator(selector).first().screenshot({ path: file }) : page.screenshot({ path: file, fullPage: true }));
    console.log('  ', file);
    if (audit) {
      // WCAG 2.1 A/AA plus axe's best practices, on the page as rendered (light or dark, shadow DOM included)
      // evaluated over the DevTools protocol: the extension pages' CSP (rightly) refuses an injected <script>
      await page.evaluate(readFileSync(join(root, 'node_modules/axe-core/axe.min.js'), 'utf8'));
      const found = (await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] })).violations.map((v: any) => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, first: v.nodes[0].target.join(' ').slice(0, 90), why: (v.nodes[0].any[0]?.message ?? v.nodes[0].failureSummary ?? '').slice(0, 140) })))) as { id: string; impact: string; help: string; n: number; first: string; why: string }[];
      for (const v of found) violations.push(`${name}.${scheme}  [${v.impact}] ${v.id} x${v.n}: ${v.help}  @ ${v.first}  (${v.why.replace(/\s+/g, ' ')})`);
    }
  };

  // ---- popup states
  if (only === 'all' || only === 'popup') {
    const site = await context.newPage();
    await site.goto(`http://acme-demo.com:${SITE_PORT}/`);
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.includes('acme-demo.com'))!.id!);
    for (const scheme of SCHEMES) {
      const popup = await context.newPage();
      await popup.setViewportSize({ width: 380, height: 700 });
      await popup.emulateMedia({ colorScheme: scheme });
      for (const [name, state] of Object.entries(STATES)) {
        const needs = name === 'popup-needs-setup';
        if (needs) await setPrefs({ setupDone: false, modelId: null });
        await worker.evaluate(([t, s]) => chrome.storage.session.set({ [`analysis:${t}`]: { jobId: 1, state: s } }), [tabId, state] as const);
        await popup.goto(`chrome-extension://${id}/popup.html?tab=${tabId}`);
        await popup.locator('.app').waitFor();
        await shoot(popup, name, scheme, '.app');
        if (needs) await setPrefs();
      }
      await popup.close();
    }
    await site.close();
  }

  // ---- options
  if (only === 'all' || only === 'options') {
    for (const scheme of SCHEMES) {
      const page = await context.newPage();
      await page.setViewportSize({ width: 820, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await setPrefs({ summary: 'byok', byok: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-4o-mini' } });
      await page.goto(`chrome-extension://${id}/options.html`);
      await page.locator('main').waitFor();
      await shoot(page, 'options-signed-in', scheme);
      await setPrefs({ account: null, summary: 'off', allowlist: [] });
      await page.reload();
      await page.locator('main').waitFor();
      await shoot(page, 'options-signed-out', scheme);
      await page.close();
    }
    await setPrefs();
  }

  // ---- the wizard, step by step against the real backend
  if (only === 'all' || only === 'setup') {
    for (const scheme of SCHEMES) {
      await worker.evaluate(() => chrome.storage.local.remove('ppg-prefs'));
      const page = await context.newPage();
      await page.setViewportSize({ width: 900, height: 800 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`chrome-extension://${id}/setup.html`);
      const click = (name: string | RegExp) => page.getByText(name, { exact: typeof name === 'string' }).first().click();
      await shoot(page, 'setup-1-welcome', scheme, undefined, 2600); // the strip's one-time reveal takes ~2 s
      await click('Get started');
      await page.getByLabel('Server address').fill(SERVER);
      await shoot(page, 'setup-2-device-before', scheme);
      await click('Check my computer');
      await page.getByText('Models offered').waitFor({ timeout: 60_000 });
      await shoot(page, 'setup-2-device-after', scheme);
      await click('Continue');
      await shoot(page, 'setup-3-model', scheme);
      await page.locator('md-filled-button', { hasText: /^Download/ }).click();
      await page.locator('h1', { hasText: 'Quick test' }).waitFor({ timeout: 240_000 });
      await page.locator('table.results tr').nth(4).waitFor({ timeout: 120_000 });
      await shoot(page, 'setup-5-test', scheme);
      await click('Continue');
      await shoot(page, 'setup-6-options', scheme);
      await click('Finish setup');
      await page.locator('h1', { hasText: 'all set' }).waitFor();
      await shoot(page, 'setup-7-done', scheme);
      await page.close();
    }
    await setPrefs();
  }

  // ---- the in-page warning banner
  if (only === 'all' || only === 'banner') {
    for (const scheme of SCHEMES) {
      const page = await context.newPage();
      await page.setViewportSize({ width: 900, height: 600 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`http://secure-paypa1.xyz:${SITE_PORT}/`);
      await page.waitForSelector('#ppg-banner-host', { state: 'attached', timeout: 15_000 }).catch(() => console.log('   (no banner appeared)'));
      await shoot(page, 'banner', scheme);
      await page.close();
    }
  }
} finally {
  await context?.close().catch(() => {});
  backend.kill();
  siteServer.stop(true);
  rmSync(tmp, { recursive: true, force: true });
}
console.log('done ->', out);
if (audit) {
  console.log(violations.length ? `\n${violations.length} accessibility finding(s):` : '\nno accessibility findings');
  for (const v of violations) console.log('  ' + v);
}
