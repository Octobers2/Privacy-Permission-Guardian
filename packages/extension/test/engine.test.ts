import { describe, expect, test } from 'bun:test';
import type { ModelEntry } from '@ppg/shared';
import { checkDevice, formatBytes, hasRoomFor, recommend, waitForAdapter, type AdapterLike, type GpuLike } from '../src/engine/device.ts';
import { appConfigFor, LetterTap, toSri } from '../src/engine/engine.ts';

const GB = 1024 ** 3;
const adapter = (over: Partial<AdapterLike> = {}): AdapterLike => ({
  features: { has: () => false },
  limits: { maxBufferSize: 4 * GB, maxStorageBufferBindingSize: 2 * GB },
  info: { vendor: 'nvidia', architecture: 'blackwell' },
  ...over,
});
/** A GPU whose first `nulls` adapter requests come back empty, like a cold page. */
const gpu = (a: AdapterLike | null, nulls = 0): GpuLike & { calls: number } => {
  const g = { calls: 0, requestAdapter: async () => (g.calls++ < nulls ? null : a) };
  return g;
};
const FAST = { retry: { attempts: 5, delayMs: 1 } };

describe('waitForAdapter', () => {
  test('retries the cold-start null', async () => {
    const g = gpu(adapter(), 2);
    expect(await waitForAdapter(g, 5, 1)).not.toBeNull();
    expect(g.calls).toBe(3);
  });
  test('gives up after the attempts and says null', async () => {
    const g = gpu(null);
    expect(await waitForAdapter(g, 3, 1)).toBeNull();
    expect(g.calls).toBe(3);
  });
  test('no gpu object at all', async () => expect(await waitForAdapter(undefined)).toBeNull());
});

describe('checkDevice', () => {
  const store = { estimate: async () => ({ quota: 50 * GB, usage: 1 * GB }) };

  test('a normal discrete GPU has no problems', async () => {
    const r = await checkDevice({ gpu: gpu(adapter()), storage: store, deviceMemory: 8 }, FAST.retry);
    expect(r).toMatchObject({ webgpu: true, software: false, problems: [], gpu: 'nvidia blackwell', memoryGB: 8 });
    expect(r.storage).toEqual({ quota: 50 * GB, usage: 1 * GB });
  });
  test('no WebGPU in the browser vs no adapter are explained differently', async () => {
    const none = await checkDevice({ gpu: undefined, storage: store }, FAST.retry);
    const noAdapter = await checkDevice({ gpu: gpu(null), storage: store }, FAST.retry);
    expect(none.problems[0]).toMatch(/does not support WebGPU/);
    expect(noAdapter.problems[0]).toMatch(/graphics drivers/);
  });
  test('a software renderer is refused', async () => {
    const r = await checkDevice({ gpu: gpu(adapter({ info: { vendor: 'google', architecture: 'swiftshader' } })), storage: store }, FAST.retry);
    expect(r.software).toBe(true);
    expect(r.problems[0]).toMatch(/software renderer/);
  });
  test('a card with tiny buffers is refused', async () => {
    const r = await checkDevice({ gpu: gpu(adapter({ limits: { maxBufferSize: 256 * 1024 ** 2, maxStorageBufferBindingSize: 128 * 1024 ** 2 } })), storage: store }, FAST.retry);
    expect(r.problems[0]).toMatch(/less memory per buffer/);
  });
  test('reports shader-f16 support', async () => {
    const withF16 = await checkDevice({ gpu: gpu({ ...adapter(), features: { has: (f) => f === 'shader-f16' } }), storage: store }, FAST.retry);
    expect(withF16.shaderF16).toBe(true);
    expect((await checkDevice({ gpu: gpu({ ...adapter(), features: { has: () => false } }), storage: store }, FAST.retry)).shaderF16).toBe(false);
  });
});

const model = (over: Partial<ModelEntry> = {}): ModelEntry => ({
  id: 'm', name: 'M', tier: 'fast', version: '1', quantization: 'q4f32_1', requiresShaderF16: false, contextWindow: 4096,
  letterTokenIds: [357, 417, 351, 414, 458, 426, 469, 462, 353],
  tasks: { tos: { promptVersion: 'letters-v1', temperature: 2.28 }, pii: { promptVersion: 'pii-v1', threshold: 0.5 } },
  bundle: 'bundle', sizeBytes: 451e6,
  lib: { path: 'k.wasm', size: 7e6, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
  files: [{ path: 'bundle/a.bin', size: 1, sha256: '0'.repeat(64) }],
  ...over,
});
const device = (over = {}) => ({ webgpu: true, gpu: 'x', software: false, shaderF16: false, maxBufferSize: 4 * GB, maxStorageBufferBindingSize: 2 * GB, memoryGB: 8, storage: null, problems: [], ...over });

describe('recommend', () => {
  test('starts with the small model', () => {
    const r = recommend([model({ id: 'big', tier: 'accurate' }), model({ id: 'small', tier: 'fast' })], device());
    expect(r.model?.id).toBe('small');
  });
  test('skips models that need shader-f16 when the card lacks it', () => {
    const r = recommend([model({ id: 'f16', requiresShaderF16: true })], device({ shaderF16: false }));
    expect(r.model).toBeNull();
    expect(recommend([model({ id: 'f16', requiresShaderF16: true })], device({ shaderF16: true })).model?.id).toBe('f16');
  });
  test('says so when the server offers nothing', () => expect(recommend([], device()).reason).toMatch(/no models/));
});

describe('hasRoomFor / formatBytes', () => {
  test('wants 20% headroom, and trusts the browser when it cannot tell', () => {
    expect(hasRoomFor(device({ storage: { quota: 10 * GB, usage: 5 * GB } }), 4 * GB)).toBe(true);
    expect(hasRoomFor(device({ storage: { quota: 10 * GB, usage: 5 * GB } }), 4.5 * GB)).toBe(false);
    expect(hasRoomFor(device({ storage: null }), 100 * GB)).toBe(true);
  });
  test('formats sizes', () => {
    expect(formatBytes(451e6)).toBe('451 MB');
    expect(formatBytes(2.395e9)).toBe('2.4 GB');
  });
});

describe('engine helpers', () => {
  test('toSri converts a hex digest to the base64 form WebLLM verifies', () => {
    expect(toSri('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')).toBe('sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  });
  test('the app config points at the server, keeps the context small and pins the kernel hash', () => {
    const cfg = appConfigFor('https://ppg.example.org/', model());
    const rec = cfg.model_list[0]!;
    expect(rec.model).toBe('https://ppg.example.org/models/bundle');
    expect(rec.model_lib).toBe('https://ppg.example.org/models/k.wasm');
    expect(rec.overrides?.context_window_size).toBe(4096);
    expect(cfg.cacheBackend).toBe('cache');
    expect((rec as unknown as { integrity: { model_lib: string } }).integrity.model_lib).toStartWith('sha256-');
  });
  test('the logit tap reads only the chosen token ids', () => {
    const tap = new LetterTap();
    tap.ids = [2, 0];
    const logits = Float32Array.from([10, 20, 30, 40]);
    expect(tap.processLogits(logits)).toBe(logits); // passes the logits through untouched
    expect(tap.last).toEqual([30, 10]);
  });
});
