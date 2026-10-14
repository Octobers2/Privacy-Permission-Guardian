/**
 * End-to-end check of the first-run wizard, in a real browser with the built extension loaded:
 *
 *   bun run build && bun run eval/run-setup-e2e.ts [--model fast|accurate] [--headed]
 *
 * Starts the real backend on a temporary database and account, opens the extension's setup page, and clicks through
 * every step: device check, model choice, a real download from the backend, the quick test, the options (including a
 * contributor sign-in), and finish. Then reads the saved preferences back from the extension.
 *
 * Needs a GPU the browser can use, the built extension (packages/extension/dist) and model bundles in
 * packages/server/data/models (run `bun run models:manifest`).
 */
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const dist = join(root, 'packages/extension/dist');
const tier = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : 'fast';
const headed = process.argv.includes('--headed');
const PORT = 8799;
const SERVER = `http://localhost:${PORT}`;

if (!existsSync(join(dist, 'manifest.json'))) throw new Error('Build the extension first: bun run build');
if (!existsSync(join(root, 'packages/server/data/models/manifest.json'))) throw new Error('No model manifest: bun run models:manifest');

const tmp = mkdtempSync(join(tmpdir(), 'ppg-setup-e2e-'));
writeFileSync(join(tmp, 'auth.txt'), `contributor:${await Bun.password.hash('correct-horse-battery', { algorithm: 'bcrypt', cost: 4 })}\n`);
const server = Bun.spawn(['bun', 'run', 'packages/server/src/index.ts'], {
  cwd: root,
  env: { ...Bun.env, PPG_PORT: String(PORT), PPG_DB_FILE: join(tmp, 'ppg.sqlite'), PPG_AUTH_FILE: join(tmp, 'auth.txt') },
  stdout: 'ignore',
  stderr: 'inherit',
});

let failed = false;
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed = true;
};

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    if ((await fetch(`${SERVER}/health`).catch(() => null))?.ok) return;
    await Bun.sleep(200);
  }
  throw new Error('the backend did not start');
}

let context: BrowserContext | undefined;
try {
  await waitForServer();
  context = await chromium.launchPersistentContext(join(tmp, 'profile'), {
    executablePath: Bun.env.CHROMIUM ?? '/usr/bin/chromium',
    headless: !headed,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,WebGPU',
      '--use-angle=vulkan',
      '--ignore-gpu-blocklist',
      '--no-sandbox',
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const extensionId = new URL(worker.url()).host;

  // The service worker opens the setup page by itself on a fresh install.
  const opened = context.pages().find((p) => p.url().endsWith('/setup.html')) ?? (await context.waitForEvent('page', { timeout: 15_000 }).catch(() => null));
  check(Boolean(opened) && opened!.url().endsWith('/setup.html'), 'the setup page opens by itself on install');

  const page: Page = opened ?? (await context.newPage());
  if (!page.url().endsWith('/setup.html')) await page.goto(`chrome-extension://${extensionId}/setup.html`);
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 300)); });

  const heading = () => page.locator('h1').first().innerText();
  const click = (name: string | RegExp) => page.getByText(name, { exact: typeof name === 'string' }).first().click();

  check((await heading()).includes('fine print'), 'welcome step');
  await click('Get started');

  check((await heading()) === 'Check this computer', 'device step');
  await page.getByLabel('Server address').fill(SERVER);
  await click('Check my computer');
  await page.getByText('Models offered').waitFor({ timeout: 60_000 });
  const facts = await page.locator('dl.facts').innerText();
  check(/Graphics\s+(?!Not available)/.test(facts), 'WebGPU graphics detected', facts.split('\n')[1] ?? '');
  await click('Continue');

  check((await heading()) === 'Choose a model', 'model step');
  const names = await page.locator('.model .title').allInnerTexts();
  check(names.length >= 2, 'both tiers are offered', names.map((n) => n.replace(/\s+/g, ' ')).join(' | '));
  check((await page.locator('.model.chosen .title').innerText()).includes('Recommended'), 'the small model is pre-selected as recommended');
  if (tier === 'accurate') await page.locator('.model', { hasText: 'Accurate (4B)' }).click();
  await page.locator('md-filled-button', { hasText: /^Download/ }).click();

  const started = Date.now();
  await page.locator('h1', { hasText: 'Quick test' }).waitFor({ timeout: 15 * 60_000 });
  console.log(`  downloaded and loaded in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  // Proof the weights really came across: the extension's own storage now holds about the size of the model.
  const stored = await page.evaluate(async () => (await navigator.storage.estimate()).usage ?? 0);
  const expected = tier === 'accurate' ? 2.3e9 : 4.0e8;
  check(stored >= expected, 'the model’s weights are in the browser’s storage', `${(stored / 1e6).toFixed(0)} MB stored`);

  await page.locator('table.results tr').nth(4).waitFor({ timeout: 120_000 }); // 3 clause samples + 2 pages
  const rows = await page.locator('table.results tr').allInnerTexts();
  console.log(rows.map((r) => '  ' + r.replace(/\s+/g, ' ')).join('\n'));
  check(rows.length === 5, 'the quick test answered all five questions');
  const right = await page.locator('table.results tr:not(.wrong)').count();
  check(right >= 4, 'at least four of five sample answers are as expected', `${right}/5`);
  await click('Continue');

  check((await heading()) === 'Two optional extras', 'options step');
  await page.getByLabel('Username').fill('contributor');
  await page.getByLabel('Password').fill('wrong-password');
  await click('Sign in');
  await page.getByText('Wrong username or password.').waitFor({ timeout: 10_000 });
  check(true, 'a wrong password is refused with a clear message');
  await page.getByLabel('Password').fill('correct-horse-battery');
  await click('Sign in');
  await page.getByText(/Signed in as/).waitFor({ timeout: 10_000 });
  check(true, 'the contributor account signs in');
  await page.getByText('Explain flagged clauses in plain English').click();
  await click('Finish setup');
  await page.locator('h1', { hasText: 'all set' }).waitFor({ timeout: 30_000 });

  // What was actually saved, read from inside the extension.
  const prefs = (await page.evaluate(async () => (await chrome.storage.local.get('ppg-prefs'))['ppg-prefs'])) as Record<string, any>;
  check(prefs.setupDone === true, 'setup is recorded as done');
  check(prefs.serverUrl === SERVER, 'the server address is saved');
  check(typeof prefs.modelId === 'string' && prefs.modelId.includes(tier === 'accurate' ? 'accurate' : 'fast'), 'the chosen model is saved', prefs.modelId);
  check(prefs.summary === 'server', 'the summary opt-in is saved');
  check(prefs.account?.username === 'contributor' && prefs.account.token.length > 20, 'the contributor token is saved');

  const cached = await page.evaluate(async () => (await caches.keys()).length);
  check(cached > 0, 'the model is in the browser cache for the offscreen document to load', `${cached} cache(s)`);
} catch (error) {
  failed = true;
  console.log('FAIL  ', error instanceof Error ? error.message : error);
  // What the user would have been looking at when it stopped.
  for (const [i, p] of (context?.pages() ?? []).entries()) {
    await p.screenshot({ path: `/tmp/claude-1000/setup-e2e-fail-${i}.png` }).catch(() => {});
    console.log(`  page ${i}: ${p.url()}`);
  }
} finally {
  await context?.close().catch(() => {});
  server.kill();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? '\nFAILED' : '\nALL PASSED');
process.exit(failed ? 1 : 0);
