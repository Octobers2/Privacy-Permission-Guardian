import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { isUsable, ModelManifestSchema } from '../src/model-manifest.ts';

const REAL = new URL('../../../data/models/manifest.json', import.meta.url).pathname;

describe('ModelManifestSchema', () => {
  // The manifest is generated locally (the bundles are gigabytes and not in the repository), so this runs when present.
  test.skipIf(!existsSync(REAL))('accepts the manifest the build script produced', () => {
    const parsed = ModelManifestSchema.safeParse(JSON.parse(readFileSync(REAL, 'utf8')));
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues.slice(0, 3)));
    expect(parsed.data.models.length).toBeGreaterThan(0);
    for (const m of parsed.data.models) expect(isUsable(m)).toBe(true);
  });

  test('rejects unknown keys and a wrong schema version', () => {
    expect(ModelManifestSchema.safeParse({ schema: 2, generatedAt: new Date().toISOString(), models: [] }).success).toBe(false);
    expect(ModelManifestSchema.safeParse({ schema: 1, generatedAt: new Date().toISOString(), models: [], extra: 1 }).success).toBe(false);
  });

  const file = { path: 'a', size: 1, sha256: '0'.repeat(64) };
  const entry = (tos: Record<string, unknown>) => ({
    id: 'm', name: 'M', tier: 'fast', version: '1', quantization: 'q4f32_1', lib: file, requiresShaderF16: false, contextWindow: 2048,
    letterTokenIds: [1, 2, 3, 4, 5, 6, 7, 8, 9], tasks: { tos }, bundle: 'b', sizeBytes: 1, files: [file],
  });
  const manifest = (tos: Record<string, unknown>) => ModelManifestSchema.parse({ schema: 1, generatedAt: new Date().toISOString(), models: [entry(tos)] });

  test('a letters-v2 model with a flag threshold is accepted and usable', () => {
    const m = manifest({ promptVersion: 'letters-v2', temperature: 1.7, otherThreshold: 0.82 }).models[0]!;
    expect(m.tasks.tos.otherThreshold).toBe(0.82);
    expect(isUsable(m)).toBe(true);
  });
  test('a prompt version this extension cannot build is not usable', () => {
    expect(isUsable(manifest({ promptVersion: 'letters-v9', temperature: 1 }).models[0]!)).toBe(false);
  });
  test('the threshold must be a probability', () => {
    expect(() => manifest({ promptVersion: 'letters-v2', temperature: 1, otherThreshold: 1.5 })).toThrow();
  });
});
