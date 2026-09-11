import { describe, expect, test } from 'bun:test';
import { isPublicUrl } from '../src/render.ts';

/**
 * The renderer opens a URL the caller chose, so this is the check that decides
 * what they are allowed to choose. Literal addresses throughout: `dns.lookup`
 * resolves those without a network, so these tests measure the rule rather than
 * whatever DNS answers today.
 */
describe('isPublicUrl', () => {
  test('allows an ordinary public address', async () => {
    expect(await isPublicUrl('https://93.184.216.34/privacy')).toBe(true);
    expect(await isPublicUrl('http://1.1.1.1/terms')).toBe(true);
  });

  test('refuses the cloud metadata endpoint', async () => {
    // The one that turns "fetch this page for me" into "read my credentials".
    expect(await isPublicUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
  });

  test('refuses loopback and the private ranges', async () => {
    for (const url of [
      'http://127.0.0.1:8787/health',
      'http://localhost:8787/health',
      'http://10.0.0.5/admin',
      'http://172.16.4.4/',
      'http://172.31.255.255/',
      'http://192.168.1.1/',
      'http://100.64.0.1/',
      'http://0.0.0.0/',
      'http://[::1]/',
      'http://[fe80::1]/',
      'http://[fc00::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
      'http://[::ffff:a00:5]/',
      'http://[0:0:0:0:0:0:0:1]/',
    ]) {
      expect(await isPublicUrl(url)).toBe(false);
    }
  });

  test('allows a public address just outside a private range', async () => {
    expect(await isPublicUrl('http://172.32.0.1/')).toBe(true);
    expect(await isPublicUrl('http://11.0.0.1/')).toBe(true);
  });

  test('refuses a scheme that is not http', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'chrome://settings']) {
      expect(await isPublicUrl(url)).toBe(false);
    }
  });

  test('refuses credentials in the URL', async () => {
    expect(await isPublicUrl('http://admin:hunter2@93.184.216.34/')).toBe(false);
  });

  test('refuses names that cannot resolve at all', async () => {
    expect(await isPublicUrl('https://this-name-does-not-exist.invalid/privacy')).toBe(false);
    expect(await isPublicUrl('not a url')).toBe(false);
  });

  test('refuses internal-sounding suffixes without asking DNS', async () => {
    for (const url of ['http://router.lan/', 'http://printer.local/', 'http://wiki.internal/']) {
      expect(await isPublicUrl(url)).toBe(false);
    }
  });
});
