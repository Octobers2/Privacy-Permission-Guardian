import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { isUsable, ModelManifestSchema } from '../src/model-manifest.ts';

const REAL = new URL('../../server/data/models/manifest.json', import.meta.url).pathname;

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
});
