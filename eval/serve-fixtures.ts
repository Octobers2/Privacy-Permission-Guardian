/**
 * Serves the fixture set under its real hostnames.
 *
 * The rule engine's strongest signal is the domain, so a fixture opened from
 * `file://` exercises almost none of it — the lookalike check has nothing to
 * look at. This server, paired with Chromium's `--host-resolver-rules`, puts
 * `https://secure-paypa1.xyz/verify` in the address bar for real, which is both
 * a far better demo and the only way to test the extension end to end.
 *
 *   bun run eval/serve-fixtures.ts
 *
 * It prints the exact Chromium flags to use.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadFixtures, type Fixture } from './fixtures.ts';

const HTTPS_PORT = 8443;
const HTTP_PORT = 8080;
const CERT_DIR = resolve(import.meta.dir, '.cert');

/**
 * A self-signed certificate covering every fixture hostname.
 *
 * Regenerated whenever the hostname set changes; Chromium is launched with
 * `--ignore-certificate-errors` anyway, but a correct SAN list keeps the
 * console quiet enough that real errors stand out.
 */
function ensureCertificate(hostnames: string[]): { cert: string; key: string } {
  const certPath = resolve(CERT_DIR, 'cert.pem');
  const keyPath = resolve(CERT_DIR, 'key.pem');
  const stampPath = resolve(CERT_DIR, 'hostnames.txt');
  const stamp = [...hostnames].sort().join('\n');

  const current = existsSync(stampPath) ? readFileSync(stampPath, 'utf8') : null;
  if (!existsSync(certPath) || current !== stamp) {
    mkdirSync(CERT_DIR, { recursive: true });
    const san = hostnames.map((h) => `DNS:${h}`).join(',');
    const result = Bun.spawnSync([
      'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '365',
      '-subj', '/CN=ppg-fixtures',
      '-addext', `subjectAltName=${san}`,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`openssl failed: ${new TextDecoder().decode(result.stderr)}`);
    }
    Bun.write(stampPath, stamp);
    console.log(`generated a self-signed certificate for ${hostnames.length} hostnames`);
  }

  return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
}

/* --------------------------------------------------------------- mock model */

export const MOCK_LLM_HOST = 'mock-llm.test';

/**
 * The last user message the mock received.
 *
 * Exposed at `GET /last-prompt` so the injection evaluation can ask what
 * actually reached the model after the real extension had sanitised it —
 * rather than re-running the sanitiser in the harness and measuring something
 * production does not do.
 */
let lastPrompt = '';

/**
 * A stand-in for an OpenAI-compatible endpoint.
 *
 * It does not pretend to be a model. It reads the document out of the prompt
 * and quotes two sentences back verbatim, then adds one point with an invented
 * quote. That makes the end-to-end test assert something real: the verbatim
 * check has to keep the first two and drop the third. A canned response with
 * hard-coded quotes would pass whether or not that check worked.
 */
async function mockCompletion(request: Request): Promise<Response> {
  const body = (await request.json()) as { messages: { role: string; content: string }[] };
  const user = body.messages.find((message) => message.role === 'user')?.content ?? '';
  lastPrompt = user;
  const document = /<untrusted_document>\n([\s\S]*)\n<\/untrusted_document>/.exec(user)?.[1] ?? '';

  const sentences = document
    .split(/(?<=\.)\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 60 && sentence.length < 240);

  const points = [
    {
      category: 'third_party_sharing',
      severity: 'high',
      title: '會將你嘅資料分享畀廣告商',
      detail: '你嘅個人資料會交畀第三方廣告公司同資料經紀。',
      quote: sentences[0] ?? document.slice(0, 180),
    },
    {
      category: 'retention',
      severity: 'medium',
      title: '資料會無限期保留',
      detail: '就算你刪咗帳戶，資料一樣會留低。',
      quote: sentences[1] ?? document.slice(180, 360),
    },
    {
      category: 'data_collection',
      severity: 'high',
      title: '（測試用）呢一點嘅引文係作出嚟嘅',
      detail: '呢一點應該喺核對引文嗰步被丟棄。',
      quote: 'We promise to sell your data to the highest bidder every Tuesday.',
    },
  ];

  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify({ points }) } }] }),
    { headers: { 'content-type': 'application/json' } },
  );
}

/* ------------------------------------------------------------------ serving */

const fixtures = loadFixtures();
const byHostname = new Map(fixtures.map((f) => [f.hostname, f]));

const HTML = { 'content-type': 'text/html; charset=utf-8' };

/**
 * Most fixtures are a single page, so the host alone identifies the file. A few
 * need more than one page — a homepage that links to a privacy policy cannot be
 * tested with one file — and those live under `fixtures/sites/<hostname>/`,
 * where the path picks the file.
 */
export const INJECTION_HOST = 'injection.test';

/** One host per injection fixture, so each can be visited as a real site. */
export function injectionHosts(): string[] {
  return readdirSync(resolve(import.meta.dir, 'fixtures', 'injection'))
    .filter((name) => name.endsWith('.html'))
    .map((name) => `inj-${name.slice(0, 2)}.test`)
    .sort();
}

function fileFor(host: string, pathname: string): string | null {
  // The injection fixtures are one directory of standalone pages rather than a
  // site, so they get a host of their own where the path picks the file.
  if (host === INJECTION_HOST) {
    const page = pathname.replace(/^\/+|\/+$/g, '') || 'index';
    return resolve(import.meta.dir, 'fixtures', 'injection', `${page}.html`);
  }

  const fixture = byHostname.get(host);
  if (!fixture) return null;

  if (fixture.file.startsWith('sites/')) {
    const page = pathname === '/' || pathname === '' ? 'index' : pathname.replace(/^\/+|\/+$/g, '');
    return resolve(import.meta.dir, 'fixtures', 'sites', host, `${page}.html`);
  }
  return resolve(import.meta.dir, 'fixtures', fixture.file);
}

async function respond(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.hostname === MOCK_LLM_HOST) {
    if (url.pathname === '/last-prompt') {
      return new Response(JSON.stringify({ prompt: lastPrompt }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/reset') {
      lastPrompt = '';
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }
    return mockCompletion(request);
  }

  // Each injection fixture gets its own site: a landing page that links to it
  // as the privacy policy, so the whole production path runs — link discovery,
  // offscreen fetch, rendering, sanitising — instead of the harness calling the
  // sanitiser directly and measuring something the extension never does.
  const injectionSite = /^inj-(\d+)\.test$/.exec(url.hostname);
  if (injectionSite) {
    const number = injectionSite[1]!;
    if (url.pathname === '/privacy') {
      const match = readdirSync(resolve(import.meta.dir, 'fixtures', 'injection')).find((name) =>
        name.startsWith(`${number}-`),
      );
      if (!match) return new Response(`no injection fixture ${number}`, { status: 404 });
      return new Response(Bun.file(resolve(import.meta.dir, 'fixtures', 'injection', match)), {
        headers: HTML,
      });
    }
    return new Response(
      `<!doctype html><html><body><h1>Fixture ${number}</h1>` +
        `<footer><a href="/privacy">Privacy Policy</a></footer></body></html>`,
      { headers: HTML },
    );
  }

  const path = fileFor(url.hostname, url.pathname);
  if (!path) {
    return new Response(`no fixture for host "${url.hostname}"`, {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const file = Bun.file(path);
  if (!(await file.exists())) {
    return new Response(`no fixture page at ${url.pathname}`, { status: 404 });
  }
  return new Response(file, { headers: HTML });
}

const httpsHosts = [
  ...fixtures.filter((f) => f.protocol === 'https:').map((f) => f.hostname),
  MOCK_LLM_HOST,
  INJECTION_HOST,
  ...injectionHosts(),
];
const httpHosts = fixtures.filter((f) => f.protocol === 'http:').map((f) => f.hostname);

if (httpsHosts.length) {
  Bun.serve({ port: HTTPS_PORT, tls: ensureCertificate(httpsHosts), fetch: respond, idleTimeout: 60 });
  console.log(`https fixtures on :${HTTPS_PORT}  (${httpsHosts.length} hosts)`);
}
if (httpHosts.length) {
  Bun.serve({ port: HTTP_PORT, fetch: respond, idleTimeout: 60 });
  console.log(`http  fixtures on :${HTTP_PORT}  (${httpHosts.length} hosts)`);
}

/** Only the fixture hostnames are redirected, so ordinary browsing still works. */
export function hostResolverRules(): string {
  return [
    ...httpsHosts.map((h) => `MAP ${h} 127.0.0.1:${HTTPS_PORT}`),
    ...httpHosts.map((h) => `MAP ${h} 127.0.0.1:${HTTP_PORT}`),
  ].join(',');
}

if (import.meta.main) {
  console.log('\nChromium flags:');
  console.log(`  --host-resolver-rules="${hostResolverRules()}"`);
  console.log('  --ignore-certificate-errors');
  console.log(`\nMock model endpoint: https://${MOCK_LLM_HOST}/v1`);
  console.log('\nFixture URLs:');
  for (const f of fixtures) console.log(`  ${f.label.padEnd(8)} ${f.url}`);
}
