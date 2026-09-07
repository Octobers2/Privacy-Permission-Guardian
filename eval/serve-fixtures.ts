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
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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

const fixtures = loadFixtures();
const byHostname = new Map(fixtures.map((f) => [f.hostname, f]));

function respond(request: Request): Response {
  const host = new URL(request.url).hostname;
  const fixture = byHostname.get(host);
  if (!fixture) {
    return new Response(`no fixture for host "${host}"`, {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(Bun.file(resolve(import.meta.dir, 'fixtures', fixture.file)), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

const httpsHosts = fixtures.filter((f) => f.protocol === 'https:').map((f) => f.hostname);
const httpHosts = fixtures.filter((f) => f.protocol === 'http:').map((f) => f.hostname);

if (httpsHosts.length) {
  Bun.serve({ port: HTTPS_PORT, tls: ensureCertificate(httpsHosts), fetch: respond });
  console.log(`https fixtures on :${HTTPS_PORT}  (${httpsHosts.length} hosts)`);
}
if (httpHosts.length) {
  Bun.serve({ port: HTTP_PORT, fetch: respond });
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
  console.log('\nFixture URLs:');
  for (const f of fixtures) console.log(`  ${f.label.padEnd(8)} ${f.url}`);
}
