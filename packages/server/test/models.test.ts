import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRange, safePath, serveModelFile } from '../src/models.ts';

let root: string;
const BYTES = Uint8Array.from({ length: 100 }, (_, i) => i);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ppg-models-'));
  mkdirSync(join(root, 'bundle'));
  writeFileSync(join(root, 'manifest.json'), '{"models":[]}');
  writeFileSync(join(root, 'bundle', 'params_shard_0.bin'), BYTES);
  writeFileSync(join(root, 'bundle', 'tensor-cache.json'), '{}');
  writeFileSync(join(root, 'lib.wasm'), BYTES);
  writeFileSync(join(root, 'secret.sh'), 'echo hi');
  mkdirSync(join(root, '..', 'ppg-outside'), { recursive: true });
  writeFileSync(join(root, '..', 'ppg-outside', 'x.json'), '{}');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  serveModelFile(root, path, new Request(`http://x/models/${path}`, { method, headers }));

describe('safePath', () => {
  test('maps the WebLLM resolve/main layout onto the bundle directory', () => {
    expect(safePath(root, 'bundle/resolve/main/params_shard_0.bin')).toBe(join(root, 'bundle', 'params_shard_0.bin'));
  });
  test('refuses traversal, absolute, hidden-segment and odd paths', () => {
    for (const p of ['../ppg-outside/x.json', 'bundle/../../x.json', '/etc/passwd', 'bundle//x.json', 'bundle/./x.json', 'a\\b.json', 'x\0.json', '']) {
      expect(safePath(root, p)).toBeNull();
    }
  });
  test('only serves known file types', () => {
    expect(safePath(root, 'secret.sh')).toBeNull();
    expect(safePath(root, 'lib.wasm')).not.toBeNull();
  });
});

describe('parseRange', () => {
  test('parses start-end, open ended and suffix ranges', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
  });
  test('flags unsatisfiable ranges and ignores ones it does not understand', () => {
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=20-10', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange(null, 100)).toBeNull();
  });
});

describe('serveModelFile', () => {
  test('serves a whole file with the headers a 2 GB download needs', async () => {
    const r = await get('bundle/resolve/main/params_shard_0.bin');
    expect(r.status).toBe(200);
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(r.headers.get('cache-control')).toContain('immutable');
    expect(r.headers.get('content-length')).toBe('100');
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(BYTES);
  });

  test('serves the wasm with the right type', async () => {
    expect((await get('lib.wasm')).headers.get('content-type')).toBe('application/wasm');
  });

  test('answers a range request with 206 and exactly those bytes', async () => {
    const r = await get('bundle/resolve/main/params_shard_0.bin', { range: 'bytes=10-19' });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 10-19/100');
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(BYTES.slice(10, 20));
  });

  test('answers an unsatisfiable range with 416', async () => {
    const r = await get('lib.wasm', { range: 'bytes=500-' });
    expect(r.status).toBe(416);
    expect(r.headers.get('content-range')).toBe('bytes */100');
  });

  test('HEAD returns headers and no body; a matching ETag returns 304', async () => {
    const head = await get('lib.wasm', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('100');
    expect(await head.text()).toBe('');
    const again = await get('lib.wasm', { 'if-none-match': head.headers.get('etag')! });
    expect(again.status).toBe(304);
  });

  test('the manifest is cached briefly, not forever', async () => {
    expect((await get('manifest.json')).headers.get('cache-control')).toBe('public, max-age=300');
  });

  test('missing files, directories and traversal are all a plain 404', async () => {
    for (const p of ['nope.bin', 'bundle', '../ppg-outside/x.json', 'secret.sh']) expect((await get(p)).status).toBe(404);
  });
});
