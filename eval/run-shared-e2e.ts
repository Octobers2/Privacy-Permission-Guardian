/**
 * End-to-end check of shared-only mode (no GPU, no model), in a real browser with the built extension and the real backend:
 *
 *   bun run build && bun run eval/run-shared-e2e.ts [--headed]
 *
 * The browser is started WITHOUT the WebGPU flags the other end-to-end checks use, so it behaves like a computer with no usable
 * graphics card: the setup wizard must say so, offer shared results only, and from then on the popup must answer from the public
 * cache without ever creating the model's offscreen document or downloading a model.
 */
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright-core';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OTHER_INDEX, TOS_CATEGORIES } from '@ppg/shared';

const root = resolve(import.meta.dir, '..');
const dist = join(root, 'packages/extension/dist');
const fixtures = join(root, 'eval/fixtures/terms');
const SERVER_PORT = 8796;
const SITE_PORT = 4311;
const SERVER = `http://localhost:${SERVER_PORT}`;
const HOSTS = ['acme-demo.com', 'plain-demo.com'];
const headed = process.argv.includes('--headed');
if (!existsSync(join(dist, 'manifest.json'))) throw new Error('Build the extension first: bun run build');

const siteServer = Bun.serve({
  port: SITE_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const host = (req.headers.get('host') ?? '').split(':')[0]!.replace(/^www\./, '');
    const full = join(fixtures, host, `${url.pathname === '/' ? 'index' : url.pathname.slice(1)}.html`);
    return existsSync(full) ? new Response(Bun.file(full), { headers: { 'content-type': 'text/html; charset=utf-8' } }) : new Response('not found', { status: 404 });
  },
});

const tmp = mkdtempSync(join(tmpdir(), 'ppg-shared-e2e-'));
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

const probs = (category: string) => TOS_CATEGORIES.map((c, i) => (c === category ? 0.9 : i === OTHER_INDEX ? 0.1 : 0));
const passage = (index: number, category: string, text: string) => ({ index, text, category, probs: probs(category) });

let context: BrowserContext | undefined;
try {
  for (let i = 0; i < 50 && !(await fetch(`${SERVER}/health`).catch(() => null))?.ok; i++) await Bun.sleep(200);

  // A contributor has already shared two documents of acme-demo.com.
  const login = (await (await fetch(`${SERVER}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'contributor', password: 'correct-horse-battery' }) })).json()) as { token: string };
  const share = async (path: string, passages: ReturnType<typeof passage>[]) =>
    fetch(`${SERVER}/api/results`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` },
      body: JSON.stringify({ url: `http://acme-demo.com:${SITE_PORT}${path}`.replace(`:${SITE_PORT}`, ''), domain: 'acme-demo.com', textHash: 'c'.repeat(64), model: { id: 'ppg-fast-0.8b-q4f32', version: '1' }, promptVersion: 'letters-v1', passageCount: 40, passages }),
    });
  const a = await share('/terms', [passage(3, 'unilateral_termination', 'We may close your account at any time.'), passage(9, 'arbitration', 'Any dispute goes to binding arbitration.'), passage(20, 'limitation_of_liability', 'We are not liable for any damages.')]);
  const b = await share('/privacy', [passage(5, 'unilateral_change', 'We may change this policy at any time.')]);
  check(a.status === 201 && b.status === 201, 'two documents of one site were shared by a contributor', `${a.status}, ${b.status}`);

  context = await chromium.launchPersistentContext(join(tmp, 'profile'), {
    executablePath: Bun.env.CHROMIUM ?? '/usr/bin/chromium',
    headless: !headed,
    // deliberately no WebGPU flags: this is a computer without a usable graphics card
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-sandbox', `--host-resolver-rules=${HOSTS.flatMap((h) => [`MAP ${h} 127.0.0.1`, `MAP www.${h} 127.0.0.1`]).join(',')}`],
  });
  const worker: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const extensionId = new URL(worker.url()).host;
  const requests: string[] = [];
  context.on('request', (r) => { if (r.url().startsWith(SERVER)) requests.push(r.url().slice(SERVER.length)); });

  // ---- setup, as a person without a GPU would see it
  const setup = context.pages().find((p) => p.url().endsWith('/setup.html')) ?? (await context.waitForEvent('page', { timeout: 15_000 }));
  await setup.waitForLoadState();
  await setup.getByText('Get started', { exact: true }).click();
  await setup.getByLabel('Server address').fill(SERVER);
  await setup.getByText('Check my computer', { exact: true }).click();
  await setup.getByText('Models offered').waitFor({ timeout: 60_000 });
  const facts = await setup.locator('dl.facts').innerText();
  check(/Not available/.test(facts), 'without WebGPU the wizard says graphics are not available');
  check(await setup.getByText('No model on this computer').isVisible(), 'and offers to continue without a model');
  check(await setup.locator('md-filled-button', { hasText: 'Continue' }).count() === 0, 'it does not pretend a model could be chosen');
  const shot = async (page: Page, name: string) => { if (Bun.env.SHOTS) await page.screenshot({ path: join(Bun.env.SHOTS, `${name}.png`) }); };
  await shot(setup, 'shared-device');
  await setup.getByText('Use shared results only', { exact: true }).click();
  await setup.locator('h1', { hasText: 'all set' }).waitFor({ timeout: 15_000 });
  check(/Look up results/.test(await setup.locator('main').innerText()), 'the last step explains how to use it');
  const prefs = await worker.evaluate(async () => (await chrome.storage.local.get('ppg-prefs'))['ppg-prefs']);
  check(prefs.setupDone === true && prefs.mode === 'shared' && prefs.modelId === null, 'setup is complete in shared mode with no model', JSON.stringify({ mode: prefs.mode, modelId: prefs.modelId }));
  const stored = await setup.evaluate(async () => (await navigator.storage.estimate()).usage ?? 0);
  check(stored < 20e6, 'no model was downloaded', `${(stored / 1e6).toFixed(1)} MB stored`);

  // ---- the popup on a site with results
  async function popupFor(host: string): Promise<{ popup: Page; site: Page }> {
    const site = await context!.newPage();
    await site.goto(`http://${host}:${SITE_PORT}/`);
    const tabId = await worker.evaluate(async (prefix) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(prefix))!.id!, `http://${host}:${SITE_PORT}`);
    const popup = await context!.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
    return { popup, site };
  }

  console.log('\n=== a site with shared results ===');
  const found = await popupFor('acme-demo.com');
  await found.popup.getByText('Look up these terms').waitFor();
  check(true, 'the popup offers to look the terms up, not to read them');
  check((await found.popup.locator('.app').innerText()).includes('Only the name of this website is sent'), 'and says what is sent');
  const before = requests.length;
  await found.popup.getByText('Look up results', { exact: true }).click();
  await found.popup.locator('section.ready h2').waitFor({ timeout: 15_000 });
  await shot(found.popup, 'shared-popup-ready');
  const text = (await found.popup.locator('main').innerText()).replace(/\s+/g, ' ');
  console.log(`  ${text.slice(0, 200)}`);
  check(/3 clauses that may work against you/.test(text), 'the terms document is shown, as the page itself points at it', text.slice(0, 60));
  check(/from the public cache/.test(text), 'it says the result comes from the public cache');
  check(/one of 2 documents/.test(text), 'it mentions that the site has another document');
  const kinds = await found.popup.locator('article.clause .kind').allTextContents();
  check(kinds.some((k) => /arbitration/i.test(k)) && kinds.length === 3, 'the clauses are listed', kinds.join(', '));
  const href = await found.popup.getByRole('link', { name: 'See all of them' }).getAttribute('href');
  check(href === `${SERVER}/site/acme-demo.com`, 'with a link to the public page of the site', href ?? '');
  const sent = requests.slice(before);
  check(sent.length === 1 && sent[0] === '/api/v1/sites/acme-demo.com', 'the only request was for the site’s domain', sent.join(' '));
  check(!sent.some((u) => u.includes('terms') && u.includes('lookup')), 'no page address or text was sent');
  await found.site.close();

  console.log('\n=== a site nobody has read ===');
  const empty = await popupFor('plain-demo.com');
  await empty.popup.getByText('Look up results', { exact: true }).click();
  await empty.popup.locator('section.state h2').waitFor({ timeout: 15_000 });
  await shot(empty.popup, 'shared-popup-empty');
  const none = (await empty.popup.locator('main').innerText()).replace(/\s+/g, ' ');
  check(/only looks up shared results/.test(none), 'it says nobody has shared a result, and why this browser cannot read it', none.slice(0, 90));
  await empty.site.close();

  console.log('\n=== nothing else happened ===');
  const contexts = await worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] })).length);
  check(contexts === 0, 'the model’s offscreen document was never created');
  check(!requests.some((u) => /^\/models\/run|params_shard/.test(u)), 'no model file was requested', requests.filter((u) => u.startsWith('/models')).join(' '));

  // ---- the settings page
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.getByText('Shared results only').first().waitFor();
  check(await options.getByText('Install an on-device model').isVisible(), 'settings show shared-only mode and offer to install a model');
} finally {
  await context?.close().catch(() => {});
  backend.kill();
  siteServer.stop(true);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? '\nFAILED' : '\nALL PASSED');
process.exit(failed ? 1 : 0);
