/**
 * Loads the built extension in headless Chromium and fails if any extension
 * page logs an error, throws, or trips the MV3 content security policy.
 *
 *   bun run scripts/check-extension.ts
 *
 * This is the automated half of the "console 零 error" acceptance criterion:
 * a CSP violation or a Lit component that fails to upgrade shows up here
 * instead of being noticed by hand three weeks later.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const distDir = resolve(import.meta.dir, '../dist');
const profileDir = mkdtempSync(join(tmpdir(), 'ppg-chrome-'));
const PORT = 9333;

/**
 * Chromium derives an unpacked extension's ID from its absolute path: sha256,
 * first 16 bytes, each hex nibble mapped 0-f onto a-p.
 */
function unpackedExtensionId(path: string): string {
  const hex = createHash('sha256').update(path).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const extId = unpackedExtensionId(distDir);

const proc = Bun.spawn(
  [
    'chromium',
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    `--load-extension=${distDir}`,
    `--disable-extensions-except=${distDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdout: 'pipe', stderr: 'pipe' },
);

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()) as { webSocketDebuggerUrl: string };
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error('devtools never came up');
}

const version = await waitForDevtools();

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));

let nextId = 1;
const pending = new Map<number, (v: any) => void>();
const events: any[] = [];

ws.onmessage = (e) => {
  const msg = JSON.parse(String(e.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg.result);
    pending.delete(msg.id);
  } else if (msg.method) {
    events.push(msg);
  }
};

function send(method: string, params: any = {}, sessionId?: string) {
  const id = nextId++;
  return new Promise<any>((res) => {
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

const problems: string[] = [];

for (const page of ['popup.html', 'options.html']) {
  const url = `chrome-extension://${extId}/${page}`;
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);

  events.length = 0;
  await send('Page.navigate', { url }, sessionId);
  await Bun.sleep(2500);

  const heading = await send(
    'Runtime.evaluate',
    {
      expression: `(() => {
        const h = document.querySelector('h1');
        const btn = document.querySelector('md-filled-button, md-switch');
        return JSON.stringify({
          url: location.href,
          heading: h && h.textContent.trim(),
          customElementUpgraded: !!(btn && btn.shadowRoot),
          bodyBg: getComputedStyle(document.body).backgroundColor,
        });
      })()`,
      returnByValue: true,
    },
    sessionId,
  );

  console.log(`\n=== ${page} ===`);
  console.log(heading.result?.value ?? heading);

  for (const ev of events) {
    if (ev.method === 'Runtime.consoleAPICalled') {
      const text = (ev.params.args ?? []).map((a: any) => a.value ?? a.description).join(' ');
      console.log(`  console.${ev.params.type}: ${text}`);
      if (ev.params.type === 'error') problems.push(`${page}: ${text}`);
    }
    if (ev.method === 'Runtime.exceptionThrown') {
      const d = ev.params.exceptionDetails;
      const text = d.exception?.description ?? d.text;
      console.log(`  EXCEPTION: ${text}`);
      problems.push(`${page}: ${text}`);
    }
    if (ev.method === 'Log.entryAdded' && ev.params.entry.level === 'error') {
      console.log(`  LOG error [${ev.params.entry.source}]: ${ev.params.entry.text}`);
      problems.push(`${page}: ${ev.params.entry.text}`);
    }
  }
  await send('Target.closeTarget', { targetId });
}

console.log(`\n=== verdict ===`);
console.log(
  problems.length === 0
    ? 'clean: no console errors, no CSP violations'
    : `PROBLEMS:\n${problems.join('\n')}`,
);

ws.close();
proc.kill();
rmSync(profileDir, { recursive: true, force: true });
process.exit(problems.length === 0 ? 0 : 1);
