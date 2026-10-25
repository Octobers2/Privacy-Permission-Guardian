/**
 * Records the real footage the video is made of: the built extension, in Chromium, driven like a person would (a visible cursor,
 * pauses long enough to read), against fixture sites and a throwaway results server seeded with invented data.
 *
 *   bun run build && bun run video/capture.ts [all | setup | pomme | popup | share | site | phish | bank | quickloan | home]
 *
 * Needs the WebGPU Chromium and the model bundles in data/models (the model really runs: the strip you see filling is the real thing).
 * Each clip is written to video/footage/<name>.mp4, and `marks.json` / `marks.js` say when, in seconds from the start of each clip,
 * the things the narration refers to happen, so a scene can line the footage up with the voice.
 *
 * Frames come from the browser's screencast (JPEG, at the page's own size), are given the time they were painted, and are joined into
 * a constant 30 fps clip. No screen is recorded, so nothing outside the page can end up in the footage.
 */
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright-core';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hostResolverRules } from '../eval/serve-fixtures.ts';
import { seed } from './seed.ts';

const root = resolve(import.meta.dir, '..');
const dist = join(root, 'packages/extension/dist');
const OUT = resolve(import.meta.dir, 'footage');
const SERVER_PORT = 8799;
const SERVER = `http://localhost:${SERVER_PORT}`;
const PASSWORD = 'correct-horse-battery'; // the throwaway account of this script's own server, not a real credential
mkdirSync(OUT, { recursive: true });
if (!existsSync(join(dist, 'manifest.json'))) throw new Error('Build the extension first: bun run build');
if (!existsSync(join(root, 'data/models/manifest.json'))) throw new Error('No model manifest in data/models: bun run models:manifest');

const args = process.argv.slice(2);
const wanted = new Set(args.filter((a) => !a.startsWith('real:')).length ? args : args.length ? [] : ['all']);
const want = (name: string) => wanted.has('all') || wanted.has(name);
// `real:<url>` arguments record a live site and are never part of `all`
const sleep = (ms: number) => Bun.sleep(ms);

/* ------------------------------------------------------------------ the arrow that screencasts do not show */

const CURSOR_JS = `(() => {
  const make = () => {
    if (document.getElementById('__cur') || !document.documentElement) return;
    const d = document.createElement('div');
    d.id = '__cur';
    d.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:30px;height:30px;left:-100px;top:-100px;';
    d.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M3 2l7 19 3-8 8-3z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.append(d);
    addEventListener('mousemove', (e) => { d.style.left = e.clientX - 3 + 'px'; d.style.top = e.clientY - 2 + 'px'; }, true);
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border-radius:50%;border:3px solid #e1251b;width:12px;height:12px;left:' + (e.clientX - 6) + 'px;top:' + (e.clientY - 6) + 'px;';
      document.documentElement.append(r);
      r.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(4)', opacity: 0 }], { duration: 450, easing: 'ease-out' }).onfinish = () => r.remove();
    }, true);
  };
  make();
  document.addEventListener('DOMContentLoaded', make);
})();`;

let pointer = new WeakMap<Page, { x: number; y: number }>();

async function glide(page: Page, x: number, y: number, ms = 700): Promise<void> {
  const from = pointer.get(page) ?? { x: x + 160, y: y + 120 };
  const steps = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease in-out
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await sleep(ms / steps);
  }
  pointer.set(page, { x, y });
}

/** Moves the arrow to the middle of an element, pauses as a person would, and clicks it. */
async function press(page: Page, target: ReturnType<Page['locator']>, { before = 300, after = 400, ms = 750 } = {}): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  await glide(page, box.x + box.width / 2, box.y + box.height / 2, ms);
  await sleep(before);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
  await sleep(after);
}

async function scrollMain(page: Page, selector: string, top: number, ms = 900): Promise<void> {
  await page.evaluate(([sel, y]) => document.querySelector(sel as string)?.scrollTo({ top: y as number, behavior: 'smooth' }), [selector, top]);
  await sleep(ms);
}

/* ------------------------------------------------------------------ recording */

const allMarks: Record<string, Record<string, number>> = existsSync(join(OUT, 'marks.json')) ? JSON.parse(readFileSync(join(OUT, 'marks.json'), 'utf8')) : {};

async function record(page: Page, name: string, size: { w: number; h: number }) {
  const cdp = await page.context().newCDPSession(page);
  const dir = mkdtempSync(join(tmpdir(), `ppg-rec-${name}-`));
  const frames: { file: string; t: number }[] = [];
  const marks: Record<string, number> = {};
  let writes: Promise<unknown>[] = [];
  cdp.on('Page.screencastFrame', (e: { data: string; sessionId: number; metadata: { timestamp: number } }) => {
    const file = join(dir, `${frames.length}.jpg`);
    frames.push({ file, t: e.metadata.timestamp });
    writes.push(Bun.write(file, Buffer.from(e.data, 'base64')));
    void cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: size.w, maxHeight: size.h, everyNthFrame: 1 });
  // a static page paints nothing, so no frame would arrive: nudge the cursor to get the first one
  await page.mouse.move(2, 2);
  await sleep(300);
  return {
    mark: (label: string) => { marks[label] = Date.now() / 1000; console.log(`    · ${name}: ${label}`); },
    async stop(): Promise<void> {
      const stopAt = Date.now() / 1000; // a page that stopped changing paints nothing: the last frame lasts until here
      await sleep(400);
      await cdp.send('Page.stopScreencast').catch(() => {});
      await Promise.all(writes);
      if (frames.length < 2) throw new Error(`${name}: only ${frames.length} frames were recorded`);
      const t0 = frames[0]!.t;
      const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.t ?? Math.max(f.t + 0.25, stopAt)) - f.t).toFixed(4)}`);
      list.push(`file '${frames.at(-1)!.file}'`);
      writeFileSync(join(dir, 'list.txt'), list.join('\n') + '\n');
      const out = join(OUT, `${name}.mp4`);
      const done = Bun.spawnSync(['ffmpeg', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '15', out], { stderr: 'inherit' });
      if (done.exitCode !== 0) throw new Error(`ffmpeg failed for ${name}`);
      allMarks[name] = Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, Math.round((v - t0) * 1000) / 1000]));
      allMarks[name]!._length = Math.round((Math.max(frames.at(-1)!.t + 0.25, stopAt) - t0) * 1000) / 1000;
      writeFileSync(join(OUT, 'marks.json'), JSON.stringify(allMarks, null, 2) + '\n');
      writeFileSync(join(OUT, 'marks.js'), `window.MARKS = ${JSON.stringify(allMarks)};\n`);
      rmSync(dir, { recursive: true, force: true });
      console.log(`  -> ${out}  (${frames.length} frames, ${allMarks[name]!._length} s)`);
    },
  };
}

/* ------------------------------------------------------------------ the environment */

const tmp = mkdtempSync(join(tmpdir(), 'ppg-capture-'));
writeFileSync(join(tmp, 'auth.txt'), `contributor:${await Bun.password.hash(PASSWORD, { algorithm: 'bcrypt', cost: 4 })}\n`);
const backend = Bun.spawn(['bun', 'run', 'packages/server/src/index.ts'], {
  cwd: root,
  env: { ...Bun.env, PPG_PORT: String(SERVER_PORT), PPG_DB_FILE: join(tmp, 'ppg.sqlite'), PPG_AUTH_FILE: join(tmp, 'auth.txt') },
  stdout: 'ignore',
  stderr: 'inherit',
});
let context: BrowserContext | undefined;

async function shutdown(code: number): Promise<never> {
  await context?.close().catch(() => {});
  backend.kill();
  rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}

try {
  for (let i = 0; i < 60 && !(await fetch(`${SERVER}/health`).catch(() => null))?.ok; i++) await sleep(200);
  const login = (await (await fetch(`${SERVER}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'contributor', password: PASSWORD }) })).json()) as { token: string; expiresAt: number };
  console.log(`seeded ${await seed(SERVER, login.token)} invented sites`);

  context = await chromium.launchPersistentContext(join(tmp, 'profile'), {
    executablePath: Bun.env.CHROMIUM ?? '/usr/bin/chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-sandbox', '--ignore-certificate-errors',
      '--force-device-scale-factor=2', // sharper footage: frames are 2x and scaled to the size asked for
      '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=vulkan', '--ignore-gpu-blocklist',
      `--host-resolver-rules=${hostResolverRules()}`,
    ],
  });
  await context.addInitScript(CURSOR_JS);
  const worker: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const extensionId = new URL(worker.url()).host;
  const tabIdOf = (prefix: string) => worker.evaluate(async (p) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(p))?.id ?? null, prefix);
  const popupSize = { w: 760, h: 1200 };

  // When the setup wizard is not being recorded, start from the state it would have left behind.
  if (!want('setup')) {
    for (const p of context.pages()) if (p.url().endsWith('/setup.html')) await p.close();
    await worker.evaluate((prefs) => chrome.storage.local.set({ 'ppg-prefs': prefs }), {
      setupDone: true, serverUrl: SERVER, modelId: 'ppg-fast-0.8b-q4f32', summary: 'off', byok: { baseUrl: '', apiKey: '', model: '' },
      account: { username: 'contributor', ...login }, paused: false, allowlist: [],
    });
  }

  /** The popup, opened as an ordinary tab pointed at a site's tab, at the size (and sharpness) of the real popup. */
  async function openPopup(forTab: number): Promise<Page> {
    const popup = await context!.newPage();
    await popup.setViewportSize({ width: 380, height: 600 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${forTab}`);
    await popup.bringToFront();
    return popup;
  }

  /* ----------------------------------------------------------- setup: what the user is told, then a real download */
  if (want('setup')) {
    console.log('\n== setup ==');
    const page = context.pages().find((p) => p.url().endsWith('/setup.html')) ?? (await context.waitForEvent('page', { timeout: 15_000 }));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForLoadState();
    await page.bringToFront();
    const rec = await record(page, 'setup', { w: 1280, h: 800 });
    const heading = page.locator('h1').first();
    await heading.waitFor();
    rec.mark('welcome');
    await sleep(6500); // long enough to read the promise about the offline model
    rec.mark('promise-read');
    await press(page, page.locator('md-filled-button', { hasText: 'Get started' }));
    await page.getByLabel('Server address').fill(SERVER);
    await sleep(500);
    await press(page, page.locator('md-filled-button', { hasText: 'Check my computer' }));
    await page.getByText('Models offered').waitFor({ timeout: 60_000 });
    rec.mark('device-checked');
    await sleep(2500);
    await press(page, page.locator('md-filled-button', { hasText: 'Continue' }));
    await page.locator('.model').first().waitFor();
    rec.mark('model-step');
    await sleep(4500);
    await press(page, page.locator('md-filled-button', { hasText: /^Download/ }));
    rec.mark('download-started');
    await page.locator('h1', { hasText: 'Quick test' }).waitFor({ timeout: 15 * 60_000 });
    rec.mark('download-done');
    await page.locator('table.results tr').nth(4).waitFor({ timeout: 120_000 });
    await sleep(2500);
    rec.mark('self-test-done');
    await press(page, page.locator('md-filled-button', { hasText: 'Continue' }));
    await page.getByLabel('Username').fill('contributor');
    await page.getByLabel('Password').fill(PASSWORD);
    await press(page, page.getByText('Sign in', { exact: true }).first());
    await page.getByText(/Signed in as/).waitFor({ timeout: 10_000 });
    await sleep(1500);
    await press(page, page.locator('md-filled-button', { hasText: 'Finish setup' }));
    await page.locator('h1', { hasText: 'all set' }).waitFor({ timeout: 30_000 });
    rec.mark('done');
    await sleep(2500);
    await rec.stop();
    await page.close();
  }

  /* ----------------------------------------------------------- a fixture site, then the popup reading it */
  const pomme = 'https://www.pomme-demo.com/';
  if (want('pomme') || want('popup') || want('share')) {
    console.log('\n== pomme (the page) ==');
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(pomme);
    await page.bringToFront();
    await sleep(800);
    if (want('pomme')) {
      const rec = await record(page, 'pomme', { w: 1280, h: 800 });
      rec.mark('home');
      await sleep(2500);
      await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
      await sleep(1200);
      const link = page.getByRole('link', { name: 'Terms of Service' }).first();
      await glide(page, ...(await link.boundingBox().then((b) => [b!.x + b!.width / 2, b!.y + b!.height / 2] as const)), 900);
      rec.mark('terms-link');
      await sleep(2800);
      await rec.stop();
    }

    if (want('popup') || want('share')) {
      console.log('\n== popup: reading the terms ==');
      const tabId = (await tabIdOf(pomme))!;
      const popup = await openPopup(tabId);
      await popup.getByText('Read the terms', { exact: true }).waitFor();
      const rec = await record(popup, 'popup-read', popupSize);
      rec.mark('idle');
      await sleep(2400);
      await press(popup, popup.locator('md-filled-button', { hasText: 'Read the terms' }));
      rec.mark('read-clicked');
      await popup.locator('section.working').waitFor({ timeout: 30_000 });
      rec.mark('reading');
      await popup.locator('section.ready h2').waitFor({ timeout: 180_000 });
      rec.mark('ready');
      await sleep(4200);
      // the families, then Money on its own
      rec.mark('chips');
      await press(popup, popup.locator('button.chip.fam-money'), { before: 400, after: 2600 });
      rec.mark('money-filtered');
      await press(popup, popup.locator('button.chip.fam-money'), { before: 200, after: 600 });
      await scrollMain(popup, 'main', 360, 1100);
      rec.mark('in-short');
      await sleep(5500);
      await scrollMain(popup, 'main', 760, 1400);
      await sleep(3500);
      rec.mark('quotes');
      await scrollMain(popup, 'main', 1100, 1400);
      await sleep(2000);
      const find = popup.locator('md-filled-tonal-button', { hasText: 'Find similar cases' });
      await scrollMain(popup, 'main', 0, 1200);
      await scrollMain(popup, 'main', 760, 1000);
      rec.mark('similar-button');
      await press(popup, find, { before: 500, after: 300 });
      await popup.locator('.similar button').first().waitFor({ timeout: 30_000 });
      rec.mark('similar-found');
      await sleep(1500);
      const seen = popup.locator('.similar button').first();
      await press(popup, seen, { before: 400, after: 3800 });
      rec.mark('similar-open');
      await sleep(1500);
      await rec.stop();

      if (want('share')) {
        console.log('\n== popup: the share question ==');
        await scrollMain(popup, 'main', 0, 400);
        const rec2 = await record(popup, 'popup-share', popupSize);
        rec2.mark('top');
        await sleep(800);
        const card = popup.locator('[aria-labelledby="offer-title"]');
        await card.scrollIntoViewIfNeeded();
        await sleep(600);
        rec2.mark('offer');
        await sleep(6500); // the card says what would be sent
        await press(popup, popup.locator('md-filled-button', { hasText: /^\s*Share\s*$/ }), { before: 600, after: 300 });
        rec2.mark('share-clicked');
        await popup.getByText(/Shared publicly/).waitFor({ timeout: 20_000 });
        rec2.mark('shared');
        await sleep(3200);
        await rec2.stop();
      }
      await popup.close();
    }
    await page.close();
  }

  /* ----------------------------------------------------------- the public query site */
  if (want('site')) {
    console.log('\n== the public site ==');
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${SERVER}/site/pomme-demo.com`);
    await page.bringToFront();
    await page.locator('article.doc').waitFor({ timeout: 15_000 });
    const rec = await record(page, 'site-pomme', { w: 1280, h: 800 });
    rec.mark('site');
    await sleep(3500);
    await press(page, page.locator('button.chip.fam-money'), { before: 300, after: 2500 });
    rec.mark('money');
    await press(page, page.locator('button.chip.fam-money'), { before: 200, after: 400 });
    await page.evaluate(() => window.scrollTo({ top: 520, behavior: 'smooth' }));
    await sleep(3500);
    await rec.stop();
    await page.close();
  }

  /* ----------------------------------------------------------- a lookalike sign-in, and a checkout that is probably genuine */
  if (want('phish')) {
    console.log('\n== phishing ==');
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.bringToFront();
    const rec = await record(page, 'phish', { w: 1280, h: 800 });
    rec.mark('load');
    await page.goto('https://account-verify-center.top/');
    await sleep(900);
    await page.locator('#ppg-banner-host').waitFor({ state: 'attached', timeout: 15_000 });
    rec.mark('banner');
    await sleep(4200);
    const why = page.locator('#ppg-banner-host').getByRole('button', { name: 'Why am I seeing this?' });
    await press(page, why, { before: 400, after: 500 });
    rec.mark('reasons');
    await sleep(6500);
    await rec.stop();
    await page.close();
  }

  if (want('bank')) {
    console.log('\n== a genuine checkout asking for a card ==');
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.bringToFront();
    const rec = await record(page, 'bank', { w: 1280, h: 800 });
    rec.mark('load');
    await page.goto('https://shop.example.com/checkout');
    await page.locator('#ppg-banner-host').waitFor({ state: 'attached', timeout: 15_000 });
    rec.mark('banner');
    await sleep(6500);
    await rec.stop();
    await page.close();
  }

  /* ----------------------------------------------------------- no terms anywhere: the page, the model, the report */
  if (want('quickloan') || want('home')) {
    console.log('\n== a site with no terms ==');
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('https://www.quickloan-demo.com/signup');
    await page.bringToFront();
    await page.locator('#ppg-banner-host').waitFor({ state: 'attached', timeout: 15_000 });
    const tabId = (await tabIdOf('https://www.quickloan-demo.com/'))!;
    const refit = () => page.setViewportSize({ width: 1281, height: 800 }).then(() => page.setViewportSize({ width: 1280, height: 800 }));
    if (want('quickloan')) {
      const a = await record(page, 'quickloan-page', { w: 1280, h: 800 });
      a.mark('banner');
      await sleep(5200);
      await a.stop();

      const popup = await openPopup(tabId);
      const b = await record(popup, 'quickloan-popup', popupSize);
      b.mark('idle');
      await sleep(1800);
      await press(popup, popup.locator('md-filled-button', { hasText: 'Read the terms' }));
      b.mark('read-clicked');
      await popup.locator('section.ready h2').waitFor({ timeout: 180_000 });
      b.mark('ready');
      await sleep(5200);
      await scrollMain(popup, 'main', 300, 1200);
      await sleep(3200);
      await rec_hold(popup, b);
      await b.stop();
      await popup.close();

      await page.bringToFront();
      await refit();
      const c = await record(page, 'quickloan-banner', { w: 1280, h: 800 });
      c.mark('findings');
      await sleep(5600);
      const report = page.locator('#ppg-banner-host').getByRole('button', { name: 'Report this site' });
      await press(page, report, { before: 500, after: 300 });
      c.mark('report-clicked');
      await page.locator('#ppg-banner-host').getByText(/has been reported/).waitFor({ timeout: 20_000 });
      c.mark('reported');
      await sleep(3600);
      await c.stop();
    }
    await page.close();
  }

  if (want('home')) {
    console.log('\n== the public site: the lists ==');
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(SERVER);
    await page.bringToFront();
    await page.locator('#rankings tbody tr').first().waitFor({ timeout: 15_000 });
    await page.locator('#missing ul.recent > li').first().waitFor({ timeout: 15_000 }).catch(() => {});
    const rec = await record(page, 'site-home', { w: 1280, h: 800 });
    rec.mark('top');
    await sleep(3500);
    await page.evaluate(() => document.getElementById('missing')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    rec.mark('missing');
    await sleep(4200);
    await rec.stop();
    await page.close();
  }

  /* ----------------------------------------------------------- a real site, live (needs the network; not part of `all`) */
  const real = process.argv.slice(2).filter((a) => a.startsWith('real:')).map((a) => a.slice(5));
  for (const url of real) {
    const name = `real-${new URL(url).hostname.replace(/^www\./, '').split('.')[0]}`;
    console.log(`\n== a real site: ${url} ==`);
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 }).catch(() => {});
    await sleep(1500);
    const tabId = (await tabIdOf(new URL(page.url()).origin))!; // the address after any redirect
    const popup = await openPopup(tabId);
    const rec = await record(popup, name, popupSize);
    rec.mark('idle');
    await sleep(1500);
    await press(popup, popup.locator('md-filled-button', { hasText: 'Read the terms' }));
    const started = Date.now();
    rec.mark('read-clicked');
    const outcome = await Promise.race([
      popup.locator('section.ready h2').waitFor({ timeout: 240_000 }).then(() => 'ready'),
      popup.locator('section.state h2').waitFor({ timeout: 240_000 }).then(() => 'state'),
    ]);
    const seconds = (Date.now() - started) / 1000;
    rec.mark(outcome);
    if (outcome === 'ready') {
      const sentences = Number(/among (\d+) sentences/.exec(await popup.locator('.hero .meta').innerText())?.[1] ?? 0);
      const file = resolve(import.meta.dir, 'data/measured.json');
      const measured = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
      measured[`${name.slice(5)}_seconds`] = String(Math.round(seconds));
      measured[`${name.slice(5)}_sentences`] = String(sentences);
      writeFileSync(file, JSON.stringify(measured, null, 2) + '\n');
      console.log(`    ${sentences} sentences in ${seconds.toFixed(1)} s`);
    } else console.log('    the popup said: ' + (await popup.locator('section.state').innerText()).replace(/\s+/g, ' ').slice(0, 200));
    await sleep(3500);
    await scrollMain(popup, 'main', 360, 1200);
    await sleep(3000);
    await rec.stop();
    await popup.close();
    await page.close();
  }

  console.log('\ndone');
  await shutdown(0);
} catch (error) {
  console.error('\ncapture failed:', error instanceof Error ? error.stack ?? error.message : error);
  for (const [i, p] of (context?.pages() ?? []).entries()) await p.screenshot({ path: join(OUT, `_failure-${i}.png`) }).catch(() => {});
  await shutdown(1);
}

/** A held beat at the end of a popup clip. */
async function rec_hold(_page: Page, rec: { mark(label: string): void }): Promise<void> {
  rec.mark('end');
  await sleep(1200);
}
